import { pgTable, text, timestamp, bigserial } from "drizzle-orm/pg-core";
import { sessions } from "./session.js";

/**
 * Durable conversation transcript (docs/plan Phase 5: "PostgreSQL becomes
 * the canonical session"). `seq` is the append-only ordering within a
 * session. This is populated from Agent's in-memory conversation
 * (src/cli/agent-conversation.ts) after each run — Agent's own JSON
 * SessionStore keeps writing too for now (it's still what Agent reads
 * back on resumeSessionById); this table is additive durability + the
 * read path for the host's session/message API, not a replacement yet.
 */
export const messages = pgTable("messages", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // system | user | assistant | tool
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
