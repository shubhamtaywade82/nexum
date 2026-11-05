import { randomUUID } from "node:crypto";
import { describeError } from "../http.js";
import type { RunServices } from "../run-starter.js";
import type { Conversation } from "./messages.js";

export type OpenAiContext = RunServices & { workspaceRoot: string };

/**
 * Runs `run` on the session for this chat request. A client that names its conversation (`externalKey`) gets a
 * persistent session that later requests with the same key continue, so Nexum remembers the thread. Without a
 * key the client keeps its own transcript: the run happens on a throwaway session seeded with the earlier turns
 * and deleted afterwards, before this returns, so callers can respond knowing no trace is left.
 */
export async function withChatSession<T>(
  ctx: OpenAiContext,
  { externalKey, history }: Conversation,
  run: (sessionId: string) => Promise<T>,
): Promise<T> {
  if (externalKey) return run(await findOrCreateKeyedSession(ctx, externalKey, history));
  return withTemporarySession(ctx, history, run);
}

async function findOrCreateKeyedSession(
  ctx: OpenAiContext,
  externalKey: string,
  history: Conversation["history"],
): Promise<string> {
  const existing = await ctx.repos.sessions.findByExternalKey(externalKey);
  if (existing) return existing.id;

  const sessionId = randomUUID();
  try {
    await ctx.repos.sessions.create(sessionId, ctx.workspaceRoot, "openai-compat", externalKey);
  } catch (err) {
    // Two first requests for one chat can race; the loser joins the winner's session.
    const winner = await ctx.repos.sessions.findByExternalKey(externalKey);
    if (winner) return winner.id;
    throw err;
  }
  // Only a brand-new session needs the client's earlier turns; an existing one already holds them.
  if (history.length > 0) await ctx.repos.messages.append(sessionId, history);
  return sessionId;
}

async function withTemporarySession<T>(
  ctx: OpenAiContext,
  history: Conversation["history"],
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
