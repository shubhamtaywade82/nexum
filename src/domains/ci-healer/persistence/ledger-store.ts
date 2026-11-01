/**
 * SQLite source of truth for the healer: lineages, handled heads, an append-only
 * event log, and worker leases. better-sqlite3 is synchronous, so every mutation
 * is one transaction and the state never disagrees with its audit trail.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertTransition, type HeadOutcome, type LineageState } from "../domain/lineage.js";
import { StateError } from "../errors.js";

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
  CREATE TABLE lineages (
    repository TEXT NOT NULL,
    heal_branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    origin_run_id INTEGER NOT NULL,
    origin_sha TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('HEALING','PR_OPEN','GREEN','EXHAUSTED','CLOSED')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    last_attempted_sha TEXT,
    last_pushed_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repository, heal_branch)
  );
  CREATE INDEX lineages_by_base ON lineages (repository, base_branch, state);

  CREATE TABLE head_outcomes (
    repository TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('HEALING','PR_OPEN','NO_PATCH','ERRORED')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repository, base_branch, head_sha)
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    heal_branch TEXT,
    base_branch TEXT,
    head_sha TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_by_repo ON events (repository, id);

  CREATE TABLE worker_leases (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

export interface Lineage {
  repository: string;
  healBranch: string;
  baseBranch: string;
  originRunId: number;
  originSha: string;
  prNumber: number;
  state: LineageState;
  attempts: number;
  lastAttemptedSha: string | null;
  lastPushedSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewLineage {
  healBranch: string;
  baseBranch: string;
  originRunId: number;
  originSha: string;
  prNumber: number;
  attempts: number;
}

export interface LineagePatch {
  attempts?: number;
  lastAttemptedSha?: string;
  lastPushedSha?: string;
}

export interface EventRecord {
  id: number;
  at: string;
  kind: string;
  healBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  detail: Record<string, unknown>;
}

interface LineageRow {
  repository: string;
  heal_branch: string;
  base_branch: string;
  origin_run_id: number;
  origin_sha: string;
  pr_number: number;
  state: LineageState;
  attempts: number;
  last_attempted_sha: string | null;
  last_pushed_sha: string | null;
  created_at: string;
  updated_at: string;
}

export class LedgerStore {
  private readonly db: Database.Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.migrate();
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError(`ledger ${path} cannot be opened (${(error as Error).message}). Refusing to run.`);
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new StateError(`ledger schema ${version} is newer than this build (${SCHEMA_VERSION})`);
    }
    if (version === 0) {
      this.db.transaction(() => {
        this.db.exec(SCHEMA_V1);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  /**
   * Acquires a named lease, or refuses if another owner holds an unexpired one.
   * IMMEDIATE takes the write lock up front, so two workers cannot both read "free".
   */
  acquireLease(name: string, owner: string, ttlMs: number, nowMs: number = this.now().getTime()): boolean {
    return this.db
      .transaction(() => {
        const row = this.db.prepare("SELECT owner, expires_at FROM worker_leases WHERE name = ?").get(name) as
          { owner: string; expires_at: number } | undefined;
        if (row && row.expires_at > nowMs && row.owner !== owner) return false;
        this.db
          .prepare(
            `INSERT INTO worker_leases (name, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
          )
          .run(name, owner, nowMs + ttlMs);
        return true;
      })
      .immediate();
  }

  releaseLease(name: string, owner: string): void {
    this.db.prepare("DELETE FROM worker_leases WHERE name = ? AND owner = ?").run(name, owner);
  }

  getLineage(repository: string, healBranch: string): Lineage | undefined {
    const row = this.db
      .prepare("SELECT * FROM lineages WHERE repository = ? AND heal_branch = ?")
      .get(repository, healBranch) as LineageRow | undefined;
    return row ? toLineage(row) : undefined;
  }

  activeLineages(repository: string): Lineage[] {
    const rows = this.db
      .prepare("SELECT * FROM lineages WHERE repository = ? AND state != 'CLOSED' ORDER BY heal_branch")
      .all(repository) as LineageRow[];
    return rows.map(toLineage);
  }

  activeForBase(repository: string, baseBranch: string): Lineage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM lineages WHERE repository = ? AND base_branch = ? AND state != 'CLOSED' ORDER BY heal_branch",
      )
      .all(repository, baseBranch) as LineageRow[];
    return rows.map(toLineage);
  }

  addLineage(repository: string, input: NewLineage): Lineage {
    return this.db.transaction(() => {
      const at = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO lineages (repository, heal_branch, base_branch, origin_run_id, origin_sha, pr_number,
           state, attempts, last_attempted_sha, last_pushed_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PR_OPEN', ?, ?, NULL, ?, ?)`,
        )
        .run(
          repository,
          input.healBranch,
          input.baseBranch,
          input.originRunId,
          input.originSha,
          input.prNumber,
          input.attempts,
          input.originSha,
          at,
          at,
        );
      this.recordEvent(repository, "lineage_opened", {
        healBranch: input.healBranch,
        baseBranch: input.baseBranch,
        headSha: input.originSha,
        detail: { pr: input.prNumber, origin_run: input.originRunId },
      });
      return this.getLineage(repository, input.healBranch) as Lineage;
    })();
  }

  /** Moves a lineage to `to`, validating the transition against the state machine. */
  transition(repository: string, healBranch: string, to: LineageState, detail: Record<string, unknown> = {}): Lineage {
    return this.db.transaction(() => {
      const current = this.requireLineage(repository, healBranch);
      assertTransition(healBranch, current.state, to);
      this.db
        .prepare("UPDATE lineages SET state = ?, updated_at = ? WHERE repository = ? AND heal_branch = ?")
        .run(to, this.timestamp(), repository, healBranch);
      if (current.state !== to) {
        this.recordEvent(repository, "lineage_state", { healBranch, detail: { from: current.state, to, ...detail } });
      }
      return this.requireLineage(repository, healBranch);
    })();
  }

  update(repository: string, healBranch: string, patch: LineagePatch): Lineage {
    return this.db.transaction(() => {
      this.requireLineage(repository, healBranch);
      this.db
        .prepare(
          `UPDATE lineages SET
           attempts = COALESCE(?, attempts),
           last_attempted_sha = COALESCE(?, last_attempted_sha),
           last_pushed_sha = COALESCE(?, last_pushed_sha),
           updated_at = ?
         WHERE repository = ? AND heal_branch = ?`,
        )
        .run(
          patch.attempts ?? null,
          patch.lastAttemptedSha ?? null,
          patch.lastPushedSha ?? null,
          this.timestamp(),
          repository,
          healBranch,
        );
      if (patch.attempts !== undefined) {
        this.recordEvent(repository, "attempt_started", { healBranch, detail: { attempt: patch.attempts } });
      }
      return this.requireLineage(repository, healBranch);
    })();
  }

  /** Resumes lineages a crashed process left in HEALING. The attempt was already counted. */
  recoverInterrupted(repository: string): string[] {
    return this.db.transaction(() => {
      const names = (
        this.db
          .prepare("SELECT heal_branch FROM lineages WHERE repository = ? AND state = 'HEALING' ORDER BY heal_branch")
          .all(repository) as { heal_branch: string }[]
      ).map((row) => row.heal_branch);
      for (const name of names) this.transition(repository, name, "PR_OPEN", { recovered: true });
      return names;
    })();
  }

  handledOutcome(repository: string, baseBranch: string, headSha: string): HeadOutcome | undefined {
    const row = this.db
      .prepare("SELECT outcome FROM head_outcomes WHERE repository = ? AND base_branch = ? AND head_sha = ?")
      .get(repository, baseBranch, headSha) as { outcome: HeadOutcome } | undefined;
    return row?.outcome;
  }

  markHead(repository: string, baseBranch: string, headSha: string, outcome: HeadOutcome): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO head_outcomes (repository, base_branch, head_sha, outcome, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repository, base_branch, head_sha)
         DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at`,
        )
        .run(repository, baseBranch, headSha, outcome, this.timestamp());
      this.recordEvent(repository, "head_outcome", { baseBranch, headSha, detail: { outcome } });
    })();
  }

  recentEvents(repository: string, limit: number): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE repository = ? ORDER BY id DESC LIMIT ?")
      .all(repository, limit) as {
      id: number;
      at: string;
      kind: string;
      heal_branch: string | null;
      base_branch: string | null;
      head_sha: string | null;
      detail: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      kind: row.kind,
      healBranch: row.heal_branch,
      baseBranch: row.base_branch,
      headSha: row.head_sha,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    }));
  }

  private requireLineage(repository: string, healBranch: string): Lineage {
    const lineage = this.getLineage(repository, healBranch);
    if (!lineage) throw new StateError(`unknown lineage ${healBranch}`);
    return lineage;
  }

  private recordEvent(
    repository: string,
    kind: string,
    fields: { healBranch?: string; baseBranch?: string; headSha?: string; detail?: Record<string, unknown> },
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (repository, at, kind, heal_branch, base_branch, head_sha, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        repository,
        this.timestamp(),
        kind,
        fields.healBranch ?? null,
        fields.baseBranch ?? null,
        fields.headSha ?? null,
        JSON.stringify(fields.detail ?? {}),
      );
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function toLineage(row: LineageRow): Lineage {
  return {
    repository: row.repository,
    healBranch: row.heal_branch,
    baseBranch: row.base_branch,
    originRunId: row.origin_run_id,
    originSha: row.origin_sha,
    prNumber: row.pr_number,
    state: row.state,
    attempts: row.attempts,
    lastAttemptedSha: row.last_attempted_sha,
    lastPushedSha: row.last_pushed_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
