/**
 * BacklogTracker — persists per-task backlog state to SQLite.
 *
 * State machine: pending → investigated → in_progress → completed
 *                                └──→ rejected_deferred
 *
 * Architecture: docs/evolution/architecture.md §5
 * Policy:       docs/evolution/evolution-policy.md §5
 */

import Database from "better-sqlite3";
import { BacklogEntry, BacklogState } from "./types.js";

interface BacklogRow {
  task_id: string;
  state: string;
  last_evaluated_commit: string | null;
  last_report_id: string | null;
  related_experiment_id: string | null;
  evidence_window_from: number | null;
  evidence_window_to: number | null;
  next_evaluation_condition: string | null;
  updated_at: number;
}

function rowToEntry(row: BacklogRow): BacklogEntry {
  return {
    taskId: row.task_id,
    state: row.state as BacklogState,
    lastEvaluatedCommit: row.last_evaluated_commit,
    lastReportId: row.last_report_id,
    relatedExperimentId: row.related_experiment_id,
    evidenceWindowFrom: row.evidence_window_from,
    evidenceWindowTo: row.evidence_window_to,
    nextEvaluationCondition: row.next_evaluation_condition,
    updatedAt: row.updated_at,
  };
}

// Valid state transitions. Anything else is a programming error.
const ALLOWED_TRANSITIONS: Record<BacklogState, BacklogState[]> = {
  pending: ["investigated", "in_progress"],
  investigated: ["in_progress", "rejected_deferred"],
  in_progress: ["completed", "rejected_deferred", "investigated"],
  completed: [],
  rejected_deferred: ["pending"],
};

export class BacklogTracker {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_backlog (
        task_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_evaluated_commit TEXT,
        last_report_id TEXT,
        related_experiment_id TEXT,
        evidence_window_from INTEGER,
        evidence_window_to INTEGER,
        next_evaluation_condition TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Returns the backlog entry for a task, or null if never tracked. */
  get(taskId: string): BacklogEntry | null {
    const row = this.db.prepare("SELECT * FROM task_backlog WHERE task_id = ?").get(taskId) as BacklogRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Returns all backlog entries, ordered by task_id. */
  list(): BacklogEntry[] {
    const rows = this.db.prepare("SELECT * FROM task_backlog ORDER BY task_id ASC").all() as BacklogRow[];
    return rows.map(rowToEntry);
  }

  /** Returns backlog entries filtered by state. */
  byState(state: BacklogState): BacklogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM task_backlog WHERE state = ? ORDER BY task_id ASC")
      .all(state) as BacklogRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Initializes a backlog entry for a task that has never been tracked.
   * Does nothing if an entry already exists.
   */
  ensurePending(taskId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_backlog
         (task_id, state, last_evaluated_commit, last_report_id, related_experiment_id,
          evidence_window_from, evidence_window_to, next_evaluation_condition, updated_at)
         VALUES (?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(taskId, Date.now());
  }

  /**
   * Transitions a task to a new state. Throws if the transition is not allowed
   * by the state machine.
   */
  transition(
    taskId: string,
    to: BacklogState,
    patch: Partial<Omit<BacklogEntry, "taskId" | "state">> = {},
  ): BacklogEntry {
    const current = this.get(taskId);
    if (!current) {
      // If the task was never tracked and we're moving to a non-pending state,
      // we implicitly create it as pending first.
      if (to === "pending") {
        this.ensurePending(taskId);
        return this.get(taskId)!;
      }
      this.ensurePending(taskId);
      return this.transition(taskId, to, patch);
    }

    const allowed = ALLOWED_TRANSITIONS[current.state];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid backlog transition for ${taskId}: ${current.state} → ${to} is not allowed (allowed: ${allowed.join(", ") || "none"})`,
      );
    }

    const next: BacklogEntry = {
      ...current,
      ...patch,
      taskId,
      state: to,
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE task_backlog
         SET state = ?, last_evaluated_commit = ?, last_report_id = ?,
             related_experiment_id = ?, evidence_window_from = ?,
             evidence_window_to = ?, next_evaluation_condition = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(
        next.state,
        next.lastEvaluatedCommit,
        next.lastReportId,
        next.relatedExperimentId,
        next.evidenceWindowFrom,
        next.evidenceWindowTo,
        next.nextEvaluationCondition,
        next.updatedAt,
        next.taskId,
      );

    return next;
  }

  close(): void {
    this.db.close();
  }
}
