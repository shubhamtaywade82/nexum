import { sql } from "drizzle-orm";
import { openDatabase, type NexumDatabase, type Database } from "../../src/persistence/database.js";

export const DEFAULT_TEST_PG_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/nexum_test";

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

  /**
   * Empty every table between tests. The host finishes some work after the
   * HTTP response is sent (e.g. an OpenAI-compat temporary session is evicted
   * and deleted in a `finally`), so the previous test's trailing DELETE can
   * hold row locks while this TRUNCATE wants an exclusive lock. Postgres then
   * aborts one side with deadlock_detected (40P01); when it aborts the
   * TRUNCATE, the DELETE completes and a retry succeeds.
   */
  async cleanTables(): Promise<void> {
    if (!this.nexumDb) return;
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.nexumDb.db.execute(sql`TRUNCATE TABLE execution_events, messages, runs, sessions CASCADE;`);
        return;
      } catch (err) {
        if (attempt >= maxAttempts || !isDeadlock(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.nexumDb) {
      await this.nexumDb.close();
      this.nexumDb = null;
    }
  }
}

/** SQLSTATE 40P01, on the error itself or on the driver error drizzle wraps. */
function isDeadlock(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "40P01") return true;
  }
  return false;
}
