import { pgTable, text, timestamp, jsonb, bigserial } from "drizzle-orm/pg-core";
import { runs } from "./run.js";

/**
 * Durable execution history — every NexumRunEvent a run emits, in order.
 * `seq` is the durable ordering (bigserial, gap-free per insert order);
 * `payload` carries the full event so replay never depends on this
 * schema's other columns catching up with protocol/types.ts additions.
 */
export const executionEvents = pgTable("execution_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});

export type ExecutionEventRow = typeof executionEvents.$inferSelect;
export type NewExecutionEventRow = typeof executionEvents.$inferInsert;
