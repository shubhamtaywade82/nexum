import { asc, eq, gt, and } from "drizzle-orm";
import type { Database } from "../database.js";
import { executionEvents } from "../schema/event.js";
import type { NexumRunEvent } from "../../protocol/types.js";

export interface SequencedRunEvent {
  seq: number;
  event: NexumRunEvent;
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  async append(event: NexumRunEvent): Promise<number> {
    const [row] = await this.db
      .insert(executionEvents)
      .values({
        runId: event.runId,
        type: event.type,
        payload: event,
        ts: new Date(event.ts),
      })
      .returning({ seq: executionEvents.seq });
    return row.seq;
  }

  async listByRun(runId: string, afterSeq = 0): Promise<SequencedRunEvent[]> {
    const condition =
      afterSeq > 0
        ? and(eq(executionEvents.runId, runId), gt(executionEvents.seq, afterSeq))
        : eq(executionEvents.runId, runId);

    const rows = await this.db
      .select({
        seq: executionEvents.seq,
        payload: executionEvents.payload,
      })
      .from(executionEvents)
      .where(condition)
      .orderBy(asc(executionEvents.seq));

    return rows.map((r) => ({
      seq: r.seq,
      event: r.payload as NexumRunEvent,
    }));
  }
}
