import { asc, eq } from "drizzle-orm";
import type { Database } from "../database.js";
import { executionEvents } from "../schema/event.js";
import type { NexumRunEvent } from "../../protocol/types.js";

export class EventRepository {
  constructor(private readonly db: Database) {}

  async append(event: NexumRunEvent): Promise<void> {
    await this.db.insert(executionEvents).values({
      runId: event.runId,
      type: event.type,
      payload: event,
      ts: new Date(event.ts),
    });
  }

  async listByRun(runId: string): Promise<NexumRunEvent[]> {
    const rows = await this.db
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.runId, runId))
      .orderBy(asc(executionEvents.seq));
    return rows.map((r) => r.payload as NexumRunEvent);
  }
}
