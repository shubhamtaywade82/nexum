/**
 * DurableJobQueue — SQLite-backed work queue with leases and dead-lettering.
 *
 * The JobService runs in-process background jobs; a durable runtime also
 * needs work that SURVIVES the process: jobs persisted in SQLite, claimed
 * under leases, kept alive by heartbeats, reclaimed when a worker dies,
 * and dead-lettered after too many attempts.
 *
 *   enqueue(payload, {dedupeKey})  → effectively-once logical jobs
 *   claim(worker, {leaseMs})       → atomic lease (at-most-one worker per job)
 *   heartbeat(job, worker)         → extend the lease while working
 *   complete/fail(job, worker)     → done | retry | dead-letter
 *   reap()                         → reclaim expired leases (crashed workers)
 *
 * Semantics: at-least-once delivery with exactly-once *effects* achievable
 * through dedupeKey (duplicate logical jobs are refused at enqueue) plus
 * idempotent handlers — the same contract SQS/river/Graphile Worker use.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type DurableJobState = "queued" | "leased" | "done" | "failed" | "dead";

export interface DurableJobSpec {
  /** The work to do (opaque to the queue). */
  payload: unknown;
  /** Higher claims first within the same run_at (default 0, range suggested -100..100). */
  priority?: number;
  /** Don't run before now + delayMs. */
  delayMs?: number;
  /** Attempts before dead-lettering (default 3, min 1). */
  maxAttempts?: number;
  /** Refuse duplicate logical jobs (effectively-once enqueue). */
  dedupeKey?: string;
  tags?: string[];
}

export interface DurableJob {
  id: string;
  payload: unknown;
  priority: number;
  state: DurableJobState;
  attempts: number;
  maxAttempts: number;
  leaseUntil?: number;
  leasedBy?: string;
  runAt: number;
  dedupeKey?: string;
  tags: string[];
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface QueueStats {
  queued: number;
  leased: number;
  done: number;
  failed: number;
  dead: number;
}

interface JobRow {
  id: string;
  payload: string;
  priority: number;
  state: string;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  leased_by: string | null;
  run_at: number;
  dedupe_key: string | null;
  tags: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(row: JobRow): DurableJob {
  return {
    id: row.id,
    payload: JSON.parse(row.payload),
    priority: row.priority,
    state: row.state as DurableJobState,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    ...(row.leased_by !== null ? { leasedBy: row.leased_by } : {}),
    runAt: row.run_at,
    ...(row.dedupe_key !== null ? { dedupeKey: row.dedupe_key } : {}),
    tags: row.tags !== null ? (JSON.parse(row.tags) as string[]) : [],
    ...(row.result !== null ? { result: JSON.parse(row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DurableJobQueue {
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
      CREATE TABLE IF NOT EXISTS durable_jobs (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        lease_until INTEGER,
        leased_by TEXT,
        run_at INTEGER NOT NULL,
        dedupe_key TEXT,
        tags TEXT,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_dedupe ON durable_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_durable_claim ON durable_jobs(state, run_at, priority DESC);
    `);
  }

  /**
   * Enqueue a job. Returns the job id, or undefined when a job with the
   * same dedupeKey already exists (effectively-once enqueue).
   */
  enqueue(payload: unknown, opts: Omit<DurableJobSpec, "payload"> = {}): string | undefined {
    const now = Date.now();
    const id = `job_${randomUUID()}`;
    if (opts.dedupeKey !== undefined) {
      const existing = this.db.prepare("SELECT id FROM durable_jobs WHERE dedupe_key = ?").get(opts.dedupeKey) as
        { id: string } | undefined;
      if (existing) return undefined;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO durable_jobs
           (id, payload, priority, state, attempts, max_attempts, run_at, dedupe_key, tags, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          JSON.stringify(payload),
          opts.priority ?? 0,
          Math.max(1, opts.maxAttempts ?? 3),
          now + (opts.delayMs ?? 0),
          opts.dedupeKey ?? null,
          opts.tags ? JSON.stringify(opts.tags) : null,
          now,
          now,
        );
      return id;
    } catch (err) {
      // Unique dedupe race (concurrent enqueue of the same key).
      if (opts.dedupeKey !== undefined && String(err).includes("UNIQUE")) return undefined;
      throw err;
    }
  }

  /**
   * Atomically lease up to `limit` runnable jobs to one worker. Runnable =
   * queued, run_at due, ordered by priority desc then run_at asc.
   */
  claim(workerId: string, opts: { limit?: number; leaseMs?: number; tags?: string[] } = {}): DurableJob[] {
    const limit = Math.max(1, opts.limit ?? 1);
    const leaseMs = opts.leaseMs ?? 30_000;
    const now = Date.now();

    const claimTx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM durable_jobs WHERE state = 'queued' AND run_at <= ? ORDER BY priority DESC, run_at ASC LIMIT ?`,
        )
        .all(now, limit * 2) as JobRow[];
      const claimed: JobRow[] = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        if (opts.tags !== undefined && opts.tags.length > 0) {
          const tags = row.tags !== null ? (JSON.parse(row.tags) as string[]) : [];
          if (!opts.tags.some((t) => tags.includes(t))) continue;
        }
        const updated = this.db
          .prepare(
            `UPDATE durable_jobs SET state = 'leased', leased_by = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(workerId, now + leaseMs, now, row.id);
        if (updated.changes > 0) {
          const fresh = this.db.prepare("SELECT * FROM durable_jobs WHERE id = ?").get(row.id) as JobRow;
          claimed.push(fresh);
        }
      }
      return claimed;
    });
    return claimTx().map(rowToJob);
  }

  /** Extend the lease while still working. False when the job is gone, not
   *  leased, or leased to another worker. */
  heartbeat(jobId: string, workerId: string, extendMs = 30_000): boolean {
    const now = Date.now();
    const updated = this.db
      .prepare(
        `UPDATE durable_jobs SET lease_until = ?, updated_at = ?
         WHERE id = ? AND state = 'leased' AND leased_by = ? AND lease_until > ?`,
      )
      .run(now + extendMs, now, jobId, workerId, now);
    return updated.changes > 0;
  }

  /** Mark done (records the result). False when the worker doesn't own it. */
  complete(jobId: string, workerId: string, result?: unknown): boolean {
    const now = Date.now();
    const updated = this.db
      .prepare(
        `UPDATE durable_jobs SET state = 'done', result = ?, lease_until = NULL, leased_by = NULL, updated_at = ?
         WHERE id = ? AND state = 'leased' AND leased_by = ?`,
      )
      .run(result === undefined ? null : JSON.stringify(result), now, jobId, workerId);
    return updated.changes > 0;
  }

  /**
   * Report failure: retry (back to queued) while attempts < maxAttempts,
   * otherwise dead-letter. `retry: false` dead-letters immediately.
   */
  fail(
    jobId: string,
    workerId: string,
    error: string,
    opts: { retry?: boolean; retryDelayMs?: number } = {},
  ): "retried" | "dead" | "ignored" {
    const now = Date.now();
    const row = this.db
      .prepare("SELECT attempts, max_attempts, state, leased_by FROM durable_jobs WHERE id = ?")
      .get(jobId) as { attempts: number; max_attempts: number; state: string; leased_by: string | null } | undefined;
    if (!row || row.state !== "leased" || row.leased_by !== workerId) return "ignored";

    const shouldRetry = (opts.retry ?? true) && row.attempts < row.max_attempts;
    if (shouldRetry) {
      this.db
        .prepare(
          `UPDATE durable_jobs SET state = 'queued', error = ?, lease_until = NULL, leased_by = NULL, run_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(error, now + (opts.retryDelayMs ?? 0), now, jobId);
      return "retried";
    }
    this.db
      .prepare(
        `UPDATE durable_jobs SET state = 'dead', error = ?, lease_until = NULL, leased_by = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(error, now, jobId);
    return "dead";
  }

  /** Reclaim expired leases (crashed/dead workers): retry or dead-letter. */
  reap(): number {
    const now = Date.now();
    const expired = this.db
      .prepare("SELECT id, attempts, max_attempts FROM durable_jobs WHERE state = 'leased' AND lease_until <= ?")
      .all(now) as Array<{ id: string; attempts: number; max_attempts: number }>;
    let reclaimed = 0;
    const tx = this.db.transaction(() => {
      for (const row of expired) {
        if (row.attempts < row.max_attempts) {
          this.db
            .prepare(
              `UPDATE durable_jobs SET state = 'queued', lease_until = NULL, leased_by = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(now, row.id);
        } else {
          this.db
            .prepare(
              `UPDATE durable_jobs SET state = 'dead', error = COALESCE(error, 'lease expired'), lease_until = NULL, leased_by = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(now, row.id);
        }
        reclaimed++;
      }
    });
    tx();
    return reclaimed;
  }

  get(jobId: string): DurableJob | undefined {
    const row = this.db.prepare("SELECT * FROM durable_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  deadLetters(): DurableJob[] {
    const rows = this.db
      .prepare("SELECT * FROM durable_jobs WHERE state = 'dead' ORDER BY updated_at DESC")
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  /** Requeue a dead-lettered job for another attempt cycle. */
  retryDead(jobId: string): boolean {
    const now = Date.now();
    const updated = this.db
      .prepare(
        `UPDATE durable_jobs SET state = 'queued', attempts = 0, error = NULL, run_at = ?, updated_at = ? WHERE id = ? AND state = 'dead'`,
      )
      .run(now, now, jobId);
    return updated.changes > 0;
  }

  stats(): QueueStats {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM durable_jobs GROUP BY state").all() as Array<{
      state: string;
      n: number;
    }>;
    const stats: QueueStats = { queued: 0, leased: 0, done: 0, failed: 0, dead: 0 };
    for (const row of rows) {
      if (row.state in stats) stats[row.state as keyof QueueStats] = row.n;
    }
    return stats;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

// ── Worker loop ─────────────────────────────────────────────────────────────

export interface QueueWorkerOptions {
  workerId?: string;
  /** Jobs claimed per cycle (default 1). */
  batchSize?: number;
  /** Lease duration + heartbeat extension (default 30s). */
  leaseMs?: number;
  /** Pause between empty claims (default 200ms). */
  idleMs?: number;
  tags?: string[];
  /** Reap expired leases each cycle (default true — single-writer setups). */
  reap?: boolean;
}

/**
 * Runs jobs from a DurableJobQueue: claim → heartbeat → run → complete/fail.
 * The handler receives the job payload and the job record; throw to fail.
 * `stop()` waits for the in-flight handler, then exits.
 */
export class QueueWorker {
  readonly workerId: string;
  private readonly queue: DurableJobQueue;
  private readonly opts: Required<Pick<QueueWorkerOptions, "batchSize" | "leaseMs" | "idleMs">> & QueueWorkerOptions;
  private running = false;
  private inFlight?: Promise<void>;

  constructor(
    queue: DurableJobQueue,
    handler: (payload: unknown, job: DurableJob) => Promise<unknown>,
    opts: QueueWorkerOptions = {},
  ) {
    this.queue = queue;
    this.workerId = opts.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
    this.opts = {
      batchSize: opts.batchSize ?? 1,
      leaseMs: opts.leaseMs ?? 30_000,
      idleMs: opts.idleMs ?? 200,
      ...opts,
    };
    this.handler = handler;
  }

  private readonly handler: (payload: unknown, job: DurableJob) => Promise<unknown>;

  start(): this {
    if (this.running) return this;
    this.running = true;
    void this.loop();
    return this;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.inFlight) await this.inFlight;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.opts.reap !== false) this.queue.reap();
      const jobs = this.queue.claim(this.workerId, {
        limit: this.opts.batchSize,
        leaseMs: this.opts.leaseMs,
        ...(this.opts.tags ? { tags: this.opts.tags } : {}),
      });
      if (jobs.length === 0) {
        await sleep(this.opts.idleMs);
        continue;
      }
      this.inFlight = this.runBatch(jobs);
      await this.inFlight;
      this.inFlight = undefined;
    }
  }

  private async runBatch(jobs: DurableJob[]): Promise<void> {
    const heartbeats = jobs.map((job) =>
      setInterval(
        () => this.queue.heartbeat(job.id, this.workerId, this.opts.leaseMs),
        Math.max(1000, this.opts.leaseMs / 3),
      ),
    );
    try {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            const result = await this.handler(job.payload, job);
            this.queue.complete(job.id, this.workerId, result);
          } catch (err) {
            this.queue.fail(job.id, this.workerId, err instanceof Error ? err.message : String(err));
          }
        }),
      );
    } finally {
      for (const timer of heartbeats) clearInterval(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
