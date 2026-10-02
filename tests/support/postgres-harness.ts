import { sql } from "drizzle-orm";
import { openDatabase, type NexumDatabase, type Database } from "../../src/persistence/database.js";

export const DEFAULT_TEST_PG_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/nexum_test";

export class PostgresHarness {
  private nexumDb: NexumDatabase | null = null;

  async start(connectionString = DEFAULT_TEST_PG_URL): Promise<Database> {
    this.nexumDb = await openDatabase(connectionString);
    await this.cleanTables();
    return this.nexumDb.db;
  }

  get db(): Database {
    if (!this.nexumDb) throw new Error("PostgresHarness not started");
    return this.nexumDb.db;
  }

  async cleanTables(): Promise<void> {
    if (!this.nexumDb) return;
    await this.nexumDb.db.execute(
      sql`TRUNCATE TABLE execution_events, messages, runs, sessions CASCADE;`,
    );
  }

  async stop(): Promise<void> {
    if (this.nexumDb) {
      await this.nexumDb.close();
      this.nexumDb = null;
    }
  }
}
