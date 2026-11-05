import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describeError, readJsonBody, writeJson } from "../http.js";
import { cancelRun, startRun } from "../run-starter.js";
import { BUSY_MESSAGE, writeConversationBusy, writeOpenAiError } from "./errors.js";
import { ChatCompletionRequestSchema, parseConversation, toRunRequest, type Conversation } from "./messages.js";
import { AGENT_MODEL_ID } from "./models.js";
import { streamCompletion } from "./stream-completion.js";
import { withChatSession, type OpenAiContext } from "./chat-session.js";
import { SseStream } from "./sse.js";
import { completeTask, isTaskRequest } from "./task-request.js";

/** Open WebUI sends its chat id here (configured per connection), which keys a persistent Nexum session. */
const CHAT_ID_HEADER = "x-openwebui-chat-id";

/**
 * POST /v1/chat/completions. Housekeeping requests get a plain model reply; chat requests run the agent on the
 * session for the conversation (see chat-session.ts). The answer is returned whole or, with `stream: true`, as
 * an SSE stream.
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

  if (isTaskRequest(req, conversation.conversation)) {
    await replyToTask(res, ctx, conversation.conversation, request.stream === true);
    return;
  }
  const chatId = req.headers[CHAT_ID_HEADER];
  const chat = { ...conversation.conversation, externalKey: typeof chatId === "string" && chatId ? chatId : undefined };
  if (request.stream) await streamCompletion(res, ctx, chat);
  else await completeOnce(res, ctx, chat);
}

async function replyToTask(
  res: ServerResponse,
  ctx: OpenAiContext,
  conversation: Conversation,
  stream: boolean,
): Promise<void> {
  let content: string;
  try {
    content = await completeTask(ctx, conversation);
  } catch (err) {
    writeOpenAiError(res, 500, "server_error", `could not complete the request: ${describeError(err)}`);
    return;
  }
  if (!stream) {
    writeJson(res, 200, completion(`task-${randomUUID()}`, content));
    return;
  }
  const sse = new SseStream(res, AGENT_MODEL_ID);
  sse.open(`chatcmpl-task-${randomUUID()}`);
  sse.text(content);
  sse.finish();
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    writeOpenAiError(res, 400, "invalid_request_error", `invalid JSON body: ${describeError(err)}`);
    return undefined;
  }
}

type Outcome = { ok: true; runId: string; content: string } | { ok: false; message: string; busy?: true };

async function completeOnce(res: ServerResponse, ctx: OpenAiContext, conversation: Conversation): Promise<void> {
  const outcome = await withChatSession(ctx, conversation, (sessionId) =>
    runToCompletion(res, ctx, sessionId, conversation),
  );
  // Respond only after the cleanup, so a client that follows up never sees the temporary session.
  if (outcome.ok) writeJson(res, 200, completion(outcome.runId, outcome.content));
  else if (outcome.busy) writeConversationBusy(res);
  else writeOpenAiError(res, 500, "server_error", outcome.message);
}

async function runToCompletion(
  res: ServerResponse,
  ctx: OpenAiContext,
  sessionId: string,
  conversation: Conversation,
): Promise<Outcome> {
  const started = await startRun(ctx, sessionId, toRunRequest(conversation));
  if (!started.ok) return { ok: false, message: BUSY_MESSAGE, busy: true };

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
