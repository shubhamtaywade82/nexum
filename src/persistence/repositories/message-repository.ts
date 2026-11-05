import { asc, eq } from "drizzle-orm";
import type { Database } from "../database.js";
import { messages, type MessageRow } from "../schema/message.js";

export interface NewMessage {
  role: string;
  content: string;
}

export class MessageRepository {
  constructor(private readonly db: Database) {}

  /** Appends messages to a session's transcript. Callers pass only the
   * messages new since the last sync (see appendSince) — this never
   * dedupes or truncates on its own. */
  async append(sessionId: string, newMessages: NewMessage[]): Promise<void> {
    if (newMessages.length === 0) return;
    await this.db.insert(messages).values(newMessages.map((m) => ({ sessionId, role: m.role, content: m.content })));
  }

  async listBySession(sessionId: string): Promise<MessageRow[]> {
    return this.db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.seq));
  }
}
