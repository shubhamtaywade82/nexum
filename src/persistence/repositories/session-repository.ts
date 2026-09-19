import { desc, eq } from "drizzle-orm";
import type { Database } from "../database.js";
import { sessions, type SessionRow } from "../schema/session.js";

export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(id: string, workspaceRoot: string, title?: string): Promise<SessionRow> {
    const [row] = await this.db
      .insert(sessions)
      .values({ id, workspaceRoot, title: title ?? null })
      .returning();
    return row;
  }

  async touch(id: string, messageCount: number): Promise<void> {
    await this.db.update(sessions).set({ updatedAt: new Date(), messageCount }).where(eq(sessions.id, id));
  }

  async get(id: string): Promise<SessionRow | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ?? null;
  }

  async list(limit = 50): Promise<SessionRow[]> {
    return this.db.select().from(sessions).orderBy(desc(sessions.updatedAt)).limit(limit);
  }
}
