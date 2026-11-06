/**
 * ReportStore — persists immutable reports to SQLite.
 *
 * Reports are write-once: an attempt to save a report with an existing id
 * will succeed only if the body is byte-identical (idempotent re-save),
 * otherwise it throws. This prevents accidental overwrites.
 *
 * Architecture: docs/evolution/architecture.md §6
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Report, ReportRef } from "../tasks/types.js";

interface ReportRow {
  id: string;
  task_id: string;
  task_schema_version: number;
  created_at: number;
  evaluated_commit: string;
  decision: string;
  confidence: number;
  independent_samples: number;
  body_json: string;
  body_sha256: string;
}

export class ReportStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        evaluated_commit TEXT NOT NULL,
        decision TEXT NOT NULL,
        confidence REAL NOT NULL,
        independent_samples INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        body_sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_reports_task_id ON task_reports(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_reports_created_at ON task_reports(created_at);
    `);
  }

  /**
   * Saves a report. Idempotent: re-saving a report with the same id and body
   * is a no-op. Throws if a report with the same id but a different body
   * already exists.
   */
  save(report: Report): void {
    const bodyJson = JSON.stringify(report);
    const bodySha = sha256(bodyJson);

    const existing = this.db.prepare("SELECT body_sha256 FROM task_reports WHERE id = ?").get(report.id) as
      { body_sha256: string } | undefined;

    if (existing) {
      if (existing.body_sha256 !== bodySha) {
        throw new Error(
          `Report id ${report.id} already exists with a different body. Report ids are deterministic; this is a bug.`,
        );
      }
      return; // idempotent re-save
    }

    this.db
      .prepare(
        `INSERT INTO task_reports
         (id, task_id, task_schema_version, created_at, evaluated_commit,
          decision, confidence, independent_samples, body_json, body_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.taskId,
        report.taskSchemaVersion,
        report.evaluationDate,
        report.evaluatedCommit,
        report.recommendation.decision,
        report.confidence.overall,
        report.confidence.independent_samples,
        bodyJson,
        bodySha,
      );
  }

  /** Loads a full report by id. */
  load(id: string): Report | null {
    const row = this.db.prepare("SELECT * FROM task_reports WHERE id = ?").get(id) as ReportRow | undefined;
    return row ? (JSON.parse(row.body_json) as Report) : null;
  }

  /** Returns the most recent report for a task, or null. */
  latestForTask(taskId: string): Report | null {
    const row = this.db
      .prepare("SELECT * FROM task_reports WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as ReportRow | undefined;
    return row ? (JSON.parse(row.body_json) as Report) : null;
  }

  /** Returns all reports for a task, oldest first. */
  listForTask(taskId: string): Report[] {
    const rows = this.db
      .prepare("SELECT * FROM task_reports WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(taskId) as ReportRow[];
    return rows.map((r) => JSON.parse(r.body_json) as Report);
  }

  /** Returns lightweight references for all reports, ordered by created_at desc. */
  listRefs(limit = 100): ReportRef[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, task_schema_version, created_at, evaluated_commit,
                decision, confidence, independent_samples
         FROM task_reports
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as ReportRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      taskSchemaVersion: r.task_schema_version,
      createdAt: r.created_at,
      evaluatedCommit: r.evaluated_commit,
      decision: r.decision as ReportRef["decision"],
      confidence: r.confidence,
      independentSamples: r.independent_samples,
    }));
  }

  /**
   * Builds a lightweight reference for a report object. Convenience wrapper
   * around ReportGenerator.refFor for callers that already have a Report in
   * hand and need a ref to store elsewhere (e.g. in the backlog).
   */
  refFor(report: Report): ReportRef {
    return {
      id: report.id,
      taskId: report.taskId,
      taskSchemaVersion: report.taskSchemaVersion,
      createdAt: report.evaluationDate,
      evaluatedCommit: report.evaluatedCommit,
      decision: report.recommendation.decision,
      confidence: report.confidence.overall,
      independentSamples: report.confidence.independent_samples,
    };
  }

  close(): void {
    this.db.close();
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
