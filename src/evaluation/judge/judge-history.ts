/**
 * Judge history — persisted verdicts for audits and calibration.
 *
 * Every verdict an LlmJudge produces is recorded (rubric, subject digest,
 * scores, model, prompt/response usage) so evaluation runs are reproducible
 * and JudgeCalibration can compare verdicts against known-good labels.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export interface JudgeVerdict {
  /** Verdict id (verdict_...). */
  id: string;
  rubricId: string;
  /** sha256 digest of the judged subject (input+output+context). */
  subjectDigest: string;
  criteriaScores: CriterionScore[];
  /** Weighted overall score, normalized 0..1. */
  overall: number;
  pass: boolean;
  explanation: string;
  /** Model that judged (for audits + calibration drift analysis). */
  judgeModel: string;
  confidence?: number;
  ts: number;
}

export interface CriterionScore {
  criterionId: string;
  score: number;
  maxScore: number;
  normalized: number;
  pass: boolean;
  rationale?: string;
}

export interface JudgeHistory {
  record(verdict: JudgeVerdict): void;
  list(filter?: { rubricId?: string; judgeModel?: string; since?: number }): JudgeVerdict[];
  stats(rubricId: string): { count: number; avgOverall: number; passRate: number };
}

/** Stable digest of a judged subject — verdicts reference subjects without
 *  storing their full text (products may persist the text separately). */
export function subjectDigest(parts: Array<string | undefined>): string {
  return createHash("sha256")
    .update(parts.filter((p) => p !== undefined).join("\n\u0000\n"))
    .digest("hex")
    .slice(0, 32);
}

export function newVerdictId(): string {
  return `verdict_${randomUUID()}`;
}

export class InMemoryJudgeHistory implements JudgeHistory {
  private readonly verdicts: JudgeVerdict[] = [];

  record(verdict: JudgeVerdict): void {
    this.verdicts.unshift(verdict);
    if (this.verdicts.length > 10_000) this.verdicts.length = 10_000;
  }

  list(filter?: { rubricId?: string; judgeModel?: string; since?: number }): JudgeVerdict[] {
    return this.verdicts.filter(
      (v) =>
        (!filter?.rubricId || v.rubricId === filter.rubricId) &&
        (!filter?.judgeModel || v.judgeModel === filter.judgeModel) &&
        (!filter?.since || v.ts >= filter.since),
    );
  }

  stats(rubricId: string): { count: number; avgOverall: number; passRate: number } {
    const rows = this.list({ rubricId });
    if (rows.length === 0) return { count: 0, avgOverall: 0, passRate: 0 };
    const avg = rows.reduce((s, v) => s + v.overall, 0) / rows.length;
    const passRate = rows.filter((v) => v.pass).length / rows.length;
    return { count: rows.length, avgOverall: round3(avg), passRate: round3(passRate) };
  }
}

/** SQLite-backed history (table judge_verdicts). */
export class SqliteJudgeHistory implements JudgeHistory {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS judge_verdicts (
        id TEXT PRIMARY KEY,
        rubric_id TEXT NOT NULL,
        subject_digest TEXT NOT NULL,
        criteria_scores TEXT NOT NULL,
        overall REAL NOT NULL,
        pass INTEGER NOT NULL,
        explanation TEXT NOT NULL,
        judge_model TEXT NOT NULL,
        confidence REAL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_judge_verdicts_rubric ON judge_verdicts(rubric_id);
    `);
  }

  record(verdict: JudgeVerdict): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO judge_verdicts
         (id, rubric_id, subject_digest, criteria_scores, overall, pass, explanation, judge_model, confidence, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        verdict.id,
        verdict.rubricId,
        verdict.subjectDigest,
        JSON.stringify(verdict.criteriaScores),
        verdict.overall,
        verdict.pass ? 1 : 0,
        verdict.explanation,
        verdict.judgeModel,
        verdict.confidence ?? null,
        verdict.ts,
      );
  }

  list(filter?: { rubricId?: string; judgeModel?: string; since?: number }): JudgeVerdict[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.rubricId) {
      conditions.push("rubric_id = ?");
      params.push(filter.rubricId);
    }
    if (filter?.judgeModel) {
      conditions.push("judge_model = ?");
      params.push(filter.judgeModel);
    }
    if (filter?.since) {
      conditions.push("ts >= ?");
      params.push(filter.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM judge_verdicts ${where} ORDER BY ts DESC LIMIT 10000`)
      .all(...params) as Array<{
      id: string;
      rubric_id: string;
      subject_digest: string;
      criteria_scores: string;
      overall: number;
      pass: number;
      explanation: string;
      judge_model: string;
      confidence: number | null;
      ts: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      rubricId: row.rubric_id,
      subjectDigest: row.subject_digest,
      criteriaScores: JSON.parse(row.criteria_scores) as CriterionScore[],
      overall: row.overall,
      pass: row.pass === 1,
      explanation: row.explanation,
      judgeModel: row.judge_model,
      ...(row.confidence !== null ? { confidence: row.confidence } : {}),
      ts: row.ts,
    }));
  }

  stats(rubricId: string): { count: number; avgOverall: number; passRate: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n, AVG(overall) AS avg, SUM(pass) AS passes FROM judge_verdicts WHERE rubric_id = ?")
      .get(rubricId) as { n: number; avg: number | null; passes: number | null };
    if (row.n === 0) return { count: 0, avgOverall: 0, passRate: 0 };
    return {
      count: row.n,
      avgOverall: round3(row.avg ?? 0),
      passRate: round3((row.passes ?? 0) / row.n),
    };
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

function round3(n: number): number {
  return Math.round(n * 1e3) / 1e3;
}
