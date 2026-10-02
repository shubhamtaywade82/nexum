import { eq, inArray, and } from "drizzle-orm";
import type { Database } from "../database.js";
import { runs, type RunRow } from "../schema/run.js";
import type { NexumRunOutput, NexumRunStatus } from "../../protocol/types.js";

export class RunRepository {
  constructor(private readonly db: Database) {}

  async create(id: string, sessionId: string, goal: string, status: NexumRunStatus = "queued"): Promise<RunRow> {
    const [row] = await this.db.insert(runs).values({ id, sessionId, goal, status }).returning();
    return row;
  }

  async updateStatus(
    id: string,
    status: NexumRunStatus,
    fields: { output?: NexumRunOutput; error?: string } = {},
  ): Promise<void> {
    const isTerminal = ["completed", "failed", "cancelled", "interrupted"].includes(status);
    await this.db
      .update(runs)
      .set({
        status,
        output: fields.output?.content ?? null,
        outputFormat: fields.output?.format ?? null,
        error: fields.error ?? null,
        finishedAt: isTerminal ? new Date() : null,
      })
      .where(eq(runs.id, id));
  }

  async complete(
    id: string,
    status: Exclude<NexumRunStatus, "queued" | "running">,
    fields: { output?: NexumRunOutput; error?: string },
  ): Promise<void> {
    await this.updateStatus(id, status, fields);
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
