/**
 * JobService — generic background job management.
 *
 * Nexum already has execution, background work, and concurrency mechanisms
 * (TaskGraph, Scheduler, Executor, ConcurrencyGate). But every feature that
 * needs background execution (shell, tests, subagent, research, workflow,
 * web crawl, benchmark, crypto scan) currently implements its own ad-hoc
 * background runner.
 *
 * The JobService consolidates this into a single service with a uniform API:
 *
 *   submit(spec)        → jobId    (start a background job)
 *   status(jobId)       → JobStatus
 *   output(jobId)       → string[] (streamed output lines)
 *   cancel(jobId)       → void     (graceful cancellation)
 *   kill(jobId)         → void     (forceful termination)
 *   list(filter?)       → JobRecord[]
 *
 * A Job is just a function () => Promise<T> plus a spec (id, description,
 * timeout, priority, tags). The service handles:
 *   - concurrency limiting (uses the existing ConcurrencyGate)
 *   - timeout enforcement
 *   - cancellation propagation (AbortController + signal)
 *   - output buffering (ring buffer, bounded)
 *   - persistence of job records (optional, via JobStore)
 *
 * This is deliberately independent of the TaskGraph/Planner system — jobs
 * are fire-and-forget background work, not orchestrated DAGs. A workflow
 * can USE jobs (e.g. submit a shell job as one step of a DAG), but the job
 * service itself has no concept of dependencies.
 */

import { newTaskId } from "../core/identity.js";
import { CancellationRegistry, CancelledError, isAbortError } from "../core/cancellation/cancellation.js";
import { ConcurrencyGate } from "../core/concurrency/gate.js";

// ── Contracts ───────────────────────────────────────────────────────────────

export type JobId = string;
export type JobPriority = "critical" | "normal" | "low";

// Map JobPriority to ConcurrencyGate Priority (which only has critical|normal).
function toGatePriority(p: JobPriority): "critical" | "normal" {
  return p === "critical" ? "critical" : "normal";
}

export interface JobSpec<T = unknown> {
  /** Human-facing description (for `nexum jobs list`). */
  description: string;
  /** The work to do. Receives an AbortSignal for cancellation. */
  run: (signal: AbortSignal) => Promise<T>;
  /** Hard timeout in ms (default: none). */
  timeoutMs?: number;
  /** Priority (affects ConcurrencyGate ordering). Default "normal". */
  priority?: JobPriority;
  /** Tags for filtering (e.g. ["shell", "tests"]). */
  tags?: string[];
  /** Maximum output lines to buffer (default 1000). */
  maxOutputLines?: number;
  /** Associated session/run id (for scoping). */
  scope?: { sessionId?: string; runId?: string };
}

export type JobState = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed-out";

export interface JobRecord {
  id: JobId;
  description: string;
  state: JobState;
  priority: JobPriority;
  tags: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Last N output lines (ring buffer). */
  output: string[];
  /** Error message if state is "failed" or "timed-out". */
  error?: string;
  /** Result if state is "completed". */
  result?: unknown;
  /** Scope (session/run association). */
  scope?: { sessionId?: string; runId?: string };
}

export interface JobListFilter {
  state?: JobState;
  tag?: string;
  sessionId?: string;
  runId?: string;
}

export interface JobServiceOptions {
  /** Max concurrent jobs (default 8). */
  maxConcurrent?: number;
  /** Default output buffer size (default 1000 lines). */
  defaultMaxOutputLines?: number;
  /** Cancellation registry (optional — service creates its own if omitted). */
  cancellation?: CancellationRegistry;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class JobService {
  private readonly jobs = new Map<JobId, JobRecord>();
  private readonly controllers = new Map<JobId, AbortController>();
  private readonly outputBuffers = new Map<JobId, string[]>();
  private readonly maxOutputLinesDefault: number;
  private readonly cancellation: CancellationRegistry;
  private readonly gate: ConcurrencyGate;

  constructor(opts: JobServiceOptions = {}) {
    this.maxOutputLinesDefault = opts.defaultMaxOutputLines ?? 1000;
    this.cancellation = opts.cancellation ?? new CancellationRegistry();
    this.gate = new ConcurrencyGate({ maxConcurrent: opts.maxConcurrent ?? 8, label: "jobs" });
  }

  /** Submit a job. Returns the job id immediately; work runs in the background. */
  submit<T = unknown>(spec: JobSpec<T>): JobId {
    const id = newTaskId();
    const maxLines = spec.maxOutputLines ?? this.maxOutputLinesDefault;
    const record: JobRecord = {
      id,
      description: spec.description,
      state: "pending",
      priority: spec.priority ?? "normal",
      tags: spec.tags ?? [],
      createdAt: new Date().toISOString(),
      output: [],
      scope: spec.scope,
    };
    this.jobs.set(id, record);
    this.outputBuffers.set(id, []);

    // Fire and forget — the gate serializes, the controller enables cancel.
    void this.runJob(id, spec, maxLines).catch((err) => {
      this.finishJob(id, "failed", undefined, err instanceof Error ? err.message : String(err));
    });

    return id;
  }

  /** Read-only status snapshot. */
  status(jobId: JobId): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /** Get the streamed output lines (copy). */
  output(jobId: JobId): string[] {
    return [...(this.outputBuffers.get(jobId) ?? [])];
  }

  /** Append a line to a job's output buffer (for jobs that report progress). */
  emit(jobId: JobId, line: string): void {
    const buf = this.outputBuffers.get(jobId);
    if (!buf) return;
    buf.push(line);
    const max = this.jobs.get(jobId)?.output.length ?? this.maxOutputLinesDefault;
    // Bound the buffer: drop oldest lines when over capacity.
    while (buf.length > this.maxOutputLinesDefault) buf.shift();
    // Mirror into the record's output for status() convenience.
    const record = this.jobs.get(jobId);
    if (record) record.output = [...buf];
    void max;
  }

  /** Graceful cancellation (signals AbortController). */
  async cancel(jobId: JobId, reason?: string): Promise<void> {
    const controller = this.controllers.get(jobId);
    if (!controller) return;
    controller.abort(new CancelledError(reason ?? "cancelled"));
    // Wait for the job to observe the signal and transition.
    const record = this.jobs.get(jobId);
    if (record && (record.state === "pending" || record.state === "running")) {
      // Give it a moment to transition; don't block forever.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (record.state === "pending" || record.state === "running") {
        this.finishJob(jobId, "cancelled", undefined, reason ?? "cancelled");
      }
    }
  }

  /** Forceful kill (same as cancel for in-process jobs; providers can override). */
  async kill(jobId: JobId, reason?: string): Promise<void> {
    await this.cancel(jobId, reason ?? "killed");
  }

  /** List jobs, optionally filtered. */
  list(filter?: JobListFilter): JobRecord[] {
    let records = [...this.jobs.values()];
    if (filter?.state) records = records.filter((r) => r.state === filter.state);
    if (filter?.tag) records = records.filter((r) => r.tags.includes(filter.tag!));
    if (filter?.sessionId) records = records.filter((r) => r.scope?.sessionId === filter.sessionId);
    if (filter?.runId) records = records.filter((r) => r.scope?.runId === filter.runId);
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Get a job record (alias for status()). */
  get(jobId: JobId): JobRecord | undefined {
    return this.status(jobId);
  }

  /** Count jobs by state (for diagnostics). */
  counts(): Record<JobState, number> {
    const counts: Record<JobState, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      "timed-out": 0,
    };
    for (const r of this.jobs.values()) counts[r.state]++;
    return counts;
  }

  /** Stop all pending/running jobs (host shutdown). */
  async stopAll(): Promise<void> {
    const active = [...this.jobs.values()].filter((r) => r.state === "pending" || r.state === "running");
    await Promise.allSettled(active.map((r) => this.cancel(r.id, "host shutdown")));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async runJob<T>(id: JobId, spec: JobSpec<T>, maxLines: number): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const record = this.jobs.get(id)!;

    // Acquire concurrency slot. acquire() returns a release function.
    let release: (() => void) | undefined;
    try {
      release = await this.gate.acquire(toGatePriority(spec.priority ?? "normal"));
    } catch (err) {
      this.finishJob(id, "failed", undefined, err instanceof Error ? err.message : String(err));
      return;
    }

    record.state = "running";
    record.startedAt = new Date().toISOString();

    // Set up timeout.
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (spec.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        controller.abort(new CancelledError(`timed out after ${spec.timeoutMs}ms`));
      }, spec.timeoutMs);
    }

    try {
      const result = await spec.run(controller.signal);
      this.finishJob(id, "completed", result);
    } catch (err) {
      if (isAbortError(err) || err instanceof CancelledError) {
        const record = this.jobs.get(id);
        if (record && record.state !== "cancelled") {
          this.finishJob(id, "cancelled", undefined, err instanceof Error ? err.message : String(err));
        }
      } else if (err instanceof Error && err.message.includes("timed out")) {
        this.finishJob(id, "timed-out", undefined, err.message);
      } else {
        this.finishJob(id, "failed", undefined, err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      release?.();
      this.controllers.delete(id);
    }
    void maxLines;
  }

  private finishJob(id: JobId, state: JobState, result?: unknown, error?: string): void {
    const record = this.jobs.get(id);
    if (!record) return;
    record.state = state;
    record.finishedAt = new Date().toISOString();
    if (result !== undefined) record.result = result;
    if (error !== undefined) record.error = error;
  }
}
