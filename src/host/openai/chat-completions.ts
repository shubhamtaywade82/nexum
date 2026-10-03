import type { IncomingMessage, ServerResponse } from "node:http";
import { describeError, readJsonBody, writeJson } from "../http.js";
import { cancelRun, startRun } from "../run-starter.js";
import { writeOpenAiError } from "./errors.js";
import { ChatCompletionRequestSchema, parseConversation, toRunRequest, type Conversation } from "./messages.js";
import { AGENT_MODEL_ID } from "./models.js";
import { streamCompletion } from "./stream-completion.js";
import { withTemporarySession, type OpenAiContext } from "./temporary-session.js";

/**
 * POST /v1/chat/completions. Each request runs on a temporary session (see temporary-session.ts), and the
 * answer is returned whole or, with `stream: true`, as an SSE stream.
 */
export async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OpenAiContext,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;

  const parsed = ChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeOpenAiError(res, 400, "invalid_request_error", parsed.error.message);
    return;
  }
  const request = parsed.data;
  if (request.model !== AGENT_MODEL_ID) {
    writeOpenAiError(res, 404, "not_found_error", `The model "${request.model}" does not exist`, {
      code: "model_not_found",
      param: "model",
    });
    return;
  }
  const conversation = parseConversation(request.messages);
  if (!conversation.ok) {
    writeOpenAiError(res, 400, "invalid_request_error", conversation.message, { param: "messages" });
    return;
  }

  if (request.stream) await streamCompletion(res, ctx, conversation.conversation);
  else await completeOnce(res, ctx, conversation.conversation);
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    writeOpenAiError(res, 400, "invalid_request_error", `invalid JSON body: ${describeError(err)}`);
    return undefined;
  }
}

type Outcome = { ok: true; runId: string; content: string } | { ok: false; message: string };

async function completeOnce(res: ServerResponse, ctx: OpenAiContext, conversation: Conversation): Promise<void> {
  const outcome = await withTemporarySession(ctx, conversation.history, (sessionId) =>
    runToCompletion(res, ctx, sessionId, conversation),
  );
  // Respond only after the cleanup, so a client that follows up never sees the temporary session.
  if (outcome.ok) writeJson(res, 200, completion(outcome.runId, outcome.content));
  else writeOpenAiError(res, 500, "server_error", outcome.message);
}

async function runToCompletion(
  res: ServerResponse,
  ctx: OpenAiContext,
  sessionId: string,
  conversation: Conversation,
): Promise<Outcome> {
  const started = await startRun(ctx, sessionId, toRunRequest(conversation));
  if (!started.ok) return { ok: false, message: "could not start a run on a new session" };

  // If the client goes away mid-run nobody is waiting for the answer, so stop spending effort on it.
  res.on("close", () => {
    const entry = ctx.registry.peek(sessionId);
    if (!res.writableEnded && entry) cancelRun(entry);
  });
  await started.done;

  const run = await ctx.repos.runs.get(started.run.id);
  if (run?.status !== "completed") return { ok: false, message: run?.error ?? `run ${run?.status ?? "was lost"}` };
  return { ok: true, runId: started.run.id, content: run.output ?? "" };
}

function completion(runId: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${runId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: AGENT_MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}
