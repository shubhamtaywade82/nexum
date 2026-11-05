import { eq, inArray, and } from "drizzle-orm";
import type { Database } from "../database.js";
import { runs, type RunRow } from "../schema/run.js";
import { runStatusPredecessors, type NexumRunOutput, type NexumRunStatus } from "../../protocol/types.js";

export class RunRepository {
  constructor(private readonly db: Database) {}

  async create(id: string, sessionId: string, goal: string, status: NexumRunStatus = "queued"): Promise<RunRow> {
    const [row] = await this.db.insert(runs).values({ id, sessionId, goal, status }).returning();
    return row;
  }

  /**
   * Move a run to `status` only if its current status allows it
   * (isValidRunTransition), atomically: a run already cancelled or
   * interrupted is never overwritten by a loop that finishes late, and a
   * terminal run never changes again. Returns false when the transition was
   * refused (late or duplicate update), which callers may ignore.
   */
  async updateStatus(
    id: string,
    status: NexumRunStatus,
    fields: { output?: NexumRunOutput; error?: string } = {},
  ): Promise<boolean> {
    const allowedFrom = runStatusPredecessors(status);
    if (allowedFrom.length === 0) return false;
    const isTerminal = ["completed", "failed", "cancelled", "interrupted"].includes(status);
    const updated = await this.db
      .update(runs)
      .set({
        status,
        output: fields.output?.content ?? null,
        outputFormat: fields.output?.format ?? null,
        error: fields.error ?? null,
        finishedAt: isTerminal ? new Date() : null,
      })
      .where(and(eq(runs.id, id), inArray(runs.status, allowedFrom)))
      .returning({ id: runs.id });
    return updated.length > 0;
  }

  async complete(
    id: string,
    status: Exclude<NexumRunStatus, "queued" | "running">,
    fields: { output?: NexumRunOutput; error?: string },
  ): Promise<boolean> {
    return this.updateStatus(id, status, fields);
  }

  async get(id: string): Promise<RunRow | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ?? null;
  }

  async findActiveBySession(sessionId: string): Promise<RunRow | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.sessionId, sessionId), inArray(runs.status, ["queued", "running"])))
      .limit(1);
    return row ?? null;
  }

  async findOrphaned(): Promise<RunRow[]> {
    return this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, ["queued", "running"]));
  }
}
