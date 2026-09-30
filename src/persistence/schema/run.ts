import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sessions } from "./session.js";

/** One agent.runUserMessage() turn, tracked durably (docs/plan §5-6). */
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  goal: text("goal").notNull(),
  status: text("status").notNull(), // queued | running | completed | failed | cancelled
  output: text("output"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
