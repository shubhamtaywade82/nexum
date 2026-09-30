import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * Host-level session record — the durable, API-facing counterpart to
 * Agent's own JSON-file conversation transcript (src/runtime/session.ts).
 * That transcript stays as Agent's internal memory for now; this table is
 * the source of truth the Nexum Host's Session/Run/Event API reads from
 * (docs/plan: "PostgreSQL is the durable source of truth"). Unifying the
 * two is later work — Phase 5 in the merge plan, not this table's job.
 */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  workspaceRoot: text("workspace_root").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  messageCount: integer("message_count").notNull().default(0),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
