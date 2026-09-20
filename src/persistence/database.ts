import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export interface NexumDatabase {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Opens the Postgres pool, runs pending migrations, and returns a ready
 * database handle. PostgreSQL is first-class infrastructure for the Nexum
 * Host (docs/plan) — there is no in-memory/SQLite fallback here; callers
 * (src/cli/serve.ts) are expected to fail fast if DATABASE_URL is unset.
 */
export async function openDatabase(connectionString: string): Promise<NexumDatabase> {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
