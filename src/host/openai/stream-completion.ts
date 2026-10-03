import type { ServerResponse } from "node:http";
import { followRun } from "../follow-run.js";
import { describeError } from "../http.js";
import { cancelRun, startRun } from "../run-starter.js";
import { BUSY_MESSAGE, writeConversationBusy, writeOpenAiError } from "./errors.js";
import { toRunRequest, type Conversation } from "./messages.js";
import { AGENT_MODEL_ID } from "./models.js";
import { SseStream } from "./sse.js";
import { projectEvent } from "./stream-projection.js";
import { withChatSession, type OpenAiContext } from "./chat-session.js";

/**
 * Streams a chat completion: the agent's tool activity as it happens, then its answer. Nexum's agent produces the
 * answer in one piece (it does not stream tokens), so the answer arrives as a single chunk at the end.
 */
export async function streamCompletion(
  res: ServerResponse,
  ctx: OpenAiContext,
  conversation: Conversation,
): Promise<void> {
  const stream = new SseStream(res, AGENT_MODEL_ID);
  let failure: string | null = null;

  await withChatSession(ctx, conversation, async (sessionId) => {
    try {
      failure = await relayRun(res, ctx, sessionId, conversation, stream);
    } catch (err) {
      failure = describeError(err);
      stream.text(`\n⚠️ ${failure}`);
    }
  });

  // Finish only after the session is gone, so a client that follows up never sees it.
  if (stream.isOpen) stream.finish();
  else if (failure === BUSY_MESSAGE) writeConversationBusy(res);
  else writeOpenAiError(res, 500, "server_error", failure ?? "could not start a run");
}

/** Starts the run and relays its events into the stream. Returns a failure message if no run could start. */
async function relayRun(
  res: ServerResponse,
  ctx: OpenAiContext,
  sessionId: string,
  conversation: Conversation,
  stream: SseStream,
): Promise<string | null> {
  const started = await startRun(ctx, sessionId, toRunRequest(conversation));
  if (!started.ok) return BUSY_MESSAGE;
  stream.open(`chatcmpl-${started.run.id}`);

  // A client that goes away mid-run is not waiting for the answer any more: stop the work.
  res.on("close", () => {
    const entry = ctx.registry.peek(sessionId);
    if (!stream.isFinished && entry) cancelRun(entry);
  });

  const state = { activity: false };
  await followRun(ctx, started.run.id, (event) => {
    const text = projectEvent(event, state);
    if (text) stream.text(text);
  });
  await started.done;
  return null;
}
