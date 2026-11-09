/**
 * The indexes the repositories rely on are declared in the schema and created
 * by the checked-in migration. The two must not drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { executionEvents } from "../../src/persistence/schema/event.js";
import { messages } from "../../src/persistence/schema/message.js";
import { runs } from "../../src/persistence/schema/run.js";

const MIGRATIONS = join(process.cwd(), "src", "persistence", "migrations");

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}

describe("Postgres access-path indexes", () => {
  it("declares an index for each access path the foreign keys do not cover", () => {
    expect(indexNames(executionEvents)).toContain("execution_events_run_seq_idx");
    expect(indexNames(messages)).toContain("messages_session_seq_idx");
    expect(indexNames(runs)).toContain("runs_session_status_idx");
  });

  it("creates each declared index in a checked-in migration", () => {
    const sql = readFileSync(join(MIGRATIONS, "0004_add_fk_access_indexes.sql"), "utf8");
    for (const name of ["execution_events_run_seq_idx", "messages_session_seq_idx", "runs_session_status_idx"]) {
      expect(sql).toContain(`CREATE INDEX "${name}"`);
    }
  });
});
