import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describeError, readJsonBody, writeJson } from "../http.js";
import { cancelRun, startRun, type RunServices } from "../run-starter.js";
import { writeOpenAiError } from "./errors.js";
import { composeGoal, ChatCompletionRequestSchema, parseConversation, type Conversation } from "./messages.js";
import { AGENT_MODEL_ID } from "./models.js";

export type OpenAiContext = RunServices & { workspaceRoot: string };

/**
 * POST /v1/chat/completions (non-streaming). Each request runs on a temporary session seeded with the
 * history the client sent, and the session is deleted afterwards: an OpenAI client keeps its own transcript,
 * so there is nothing for Nexum to remember between calls.
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
  if (request.stream) {
    writeOpenAiError(res, 400, "invalid_request_error", "streaming is not available yet", {
      code: "stream_not_supported",
      param: "stream",
    });
    return;
  }

  const conversation = parseConversation(request.messages);
  if (!conversation.ok) {
    writeOpenAiError(res, 400, "invalid_request_error", conversation.message, { param: "messages" });
    return;
  }

  await runOnTemporarySession(res, ctx, conversation.conversation);
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

async function runOnTemporarySession(
  res: ServerResponse,
  ctx: OpenAiContext,
  conversation: Conversation,
): Promise<void> {
  const sessionId = randomUUID();
  await ctx.repos.sessions.create(sessionId, ctx.workspaceRoot, "openai-compat");
  let outcome: Outcome;
  try {
    outcome = await runToCompletion(res, ctx, sessionId, conversation);
  } finally {
    await ctx.registry.evict(sessionId);
    await ctx.repos.sessions.delete(sessionId).catch((err) => {
      process.stderr.write(`[nexum host] could not delete temporary session ${sessionId}: ${describeError(err)}\n`);
    });
  }
  // Respond only after the cleanup, so a client that follows up never sees the temporary session.
  if (outcome.ok) writeJson(res, 200, completion(outcome.runId, outcome.content));
  else writeOpenAiError(res, 500, "server_error", outcome.message);
}

async function runToCompletion(
  res: ServerResponse,
  ctx: OpenAiContext,
  sessionId: string,
  { history, ...rest }: Conversation,
): Promise<Outcome> {
  if (history.length > 0) await ctx.repos.messages.append(sessionId, history);

  const started = await startRun(ctx, sessionId, {
    goal: composeGoal({ ...rest, history }),
    presentation: { mode: "markdown" },
    interactive: false,
  });
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
