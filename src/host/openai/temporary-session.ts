import { randomUUID } from "node:crypto";
import { describeError } from "../http.js";
import type { RunServices } from "../run-starter.js";
import type { ClientTurn } from "./messages.js";

export type OpenAiContext = RunServices & { workspaceRoot: string };

/**
 * Runs `run` on a throwaway session seeded with the client's earlier turns, and deletes the session afterwards.
 * An OpenAI client keeps its own transcript, so there is nothing for Nexum to remember between calls. Cleanup
 * finishes before this returns, so callers can respond knowing no trace is left.
 */
export async function withTemporarySession<T>(
  ctx: OpenAiContext,
  history: ClientTurn[],
  run: (sessionId: string) => Promise<T>,
): Promise<T> {
  const sessionId = randomUUID();
  await ctx.repos.sessions.create(sessionId, ctx.workspaceRoot, "openai-compat");
  try {
    if (history.length > 0) await ctx.repos.messages.append(sessionId, history);
    return await run(sessionId);
  } finally {
    await ctx.registry.evict(sessionId);
    await ctx.repos.sessions.delete(sessionId).catch((err) => {
      process.stderr.write(`[nexum host] could not delete temporary session ${sessionId}: ${describeError(err)}\n`);
    });
  }
}
