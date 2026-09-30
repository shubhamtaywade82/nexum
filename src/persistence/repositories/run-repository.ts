import { eq } from "drizzle-orm";
import type { Database } from "../database.js";
import { runs, type RunRow } from "../schema/run.js";
import type { NexumRunStatus } from "../../protocol/types.js";

export class RunRepository {
  constructor(private readonly db: Database) {}

  async create(id: string, sessionId: string, goal: string): Promise<RunRow> {
    const [row] = await this.db.insert(runs).values({ id, sessionId, goal, status: "running" }).returning();
    return row;
  }

  async complete(
    id: string,
    status: Exclude<NexumRunStatus, "queued" | "running">,
    fields: { output?: string; error?: string },
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({ status, output: fields.output ?? null, error: fields.error ?? null, finishedAt: new Date() })
      .where(eq(runs.id, id));
  }

  async get(id: string): Promise<RunRow | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ?? null;
  }
}
