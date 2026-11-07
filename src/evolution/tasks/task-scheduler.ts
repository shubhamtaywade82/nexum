/**
 * TaskScheduler — the cadence-driven sweep over the task catalogue.
 *
 * schedules.yml declares per-category cadences, evidence deltas, and an
 * initial batch, but nothing consumed them: cadence only acted as a ceiling
 * when someone ran a task manually — there was no recurring sweep at all.
 * This module closes that gap with the same policy invariants the
 * EvolutionWorker enforces for mutations:
 *
 *   1. NEVER RUN BECAUSE THE TIMER FIRED. Every tick re-evaluates
 *      eligibility through the anti-rules (new evidence / new commit, inside
 *      validateTaskRun) plus the cadence ceiling and the min-evidence delta.
 *      The schedule can only DEFER a task, never force one.
 *   2. ONE TASK PER TICK — the highest-priority eligible diagnose task (or
 *      the initial-batch order while the backlog is empty), so a long
 *      backlog cannot monopolize the process.
 *   3. BUDGETED FAILURE. Consecutive THROWN failures stop the scheduler. A
 *      blocked run (anti-rule) is a result, not a failure — same distinction
 *      as a clean hypothesis rejection.
 *
 * Architecture: docs/evolution/architecture.md §Dispatch
 */

import { BacklogTracker } from "./backlog-tracker.js";
import { TaskRunner, RunOutcome } from "./task-runner.js";
import { TaskRegistry } from "./task-registry.js";
import { SchedulesFile, TaskDefinition } from "./types.js";

/** Cadence name → minimum spacing between evaluations. null = commit-based. */
const CADENCE_MS: Record<string, number | null> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  "per-release": null,
};

/** Returns the cadence interval in ms, or null for commit-based cadences. */
export function cadenceMs(cadence: string): number | null {
  const v = CADENCE_MS[cadence];
  // NB: ?? would also catch the explicit null (per-release).
  return v === undefined ? CADENCE_MS.daily : v;
}

export interface SweepDeps {
  runner: TaskRunner;
  registry: TaskRegistry;
  backlog: BacklogTracker;
  schedules: SchedulesFile;
  /** Current HEAD of the repository (per-release cadence comparisons). */
  getCurrentCommit: () => Promise<string>;
  /** Episodes persisted since the task's last report (evidence delta). */
  getNewEvidenceCount: (taskId: string) => number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface SweepOutcome {
  /** True when a task actually ran (validated OR blocked by an anti-rule). */
  ran: boolean;
  /** True when a task was eligible but the cadence/evidence ceiling deferred it. */
  deferred: boolean;
  /** False only when the sweep threw. Blocked runs are results, not failures. */
  ok: boolean;
  detail: string;
}

/**
 * Runs AT MOST ONE catalogue task: walks the ranked eligible list (or the
 * initial-batch order while the backlog is empty), applies the cadence
 * ceiling and min-evidence delta from schedules.yml, and runs the first task
 * they allow. The TaskRunner's anti-rules get the final word inside runOne.
 *
 * A task deferred by its cadence/evidence ceiling does NOT wedge the sweep:
 * the sweep moves down the ranking and runs the next task the ceilings allow,
 * so a long backlog keeps making progress while a recently-evaluated task
 * waits out its cadence.
 */
export async function sweepOnce(deps: SweepDeps): Promise<SweepOutcome> {
  const now = deps.now ?? Date.now;
  const candidates = await pickSweepCandidates(deps);
  if (candidates.length === 0) {
    return { ran: false, deferred: false, ok: true, detail: "no eligible task (backlog drained or all blocked)" };
  }

  let firstDeferral: string | null = null;
  for (const task of candidates) {
    const entry = deps.backlog.get(task.id);

    // First evaluation (no backlog entry) always runs — the cadence ceiling
    // only bounds RE-evaluation.
    if (entry) {
      const category = deps.schedules.categories[task.category] ?? {
        cadence: deps.schedules.default_cadence,
        reason: "",
        min_evidence_delta_to_re_run: 0,
      };

      // Evidence delta: "at least N new episodes since the last report".
      const delta = deps.getNewEvidenceCount(task.id);
      if (delta < category.min_evidence_delta_to_re_run) {
        firstDeferral ??= `${task.id} deferred: ${delta} new evidence item(s) < ${category.min_evidence_delta_to_re_run} required by schedules.yml (${task.category})`;
        continue;
      }

      // Cadence ceiling.
      if (category.cadence === "per-release") {
        const current = await deps.getCurrentCommit();
        if (entry.lastEvaluatedCommit === current) {
          firstDeferral ??= `${task.id} deferred: per-release cadence and HEAD has not advanced since the last evaluation`;
          continue;
        }
      } else {
        const spacing = cadenceMs(category.cadence) ?? 0;
        if (entry.updatedAt + spacing > now()) {
          firstDeferral ??= `${task.id} deferred: ${category.cadence} cadence ceiling not yet reached`;
          continue;
        }
      }
    }

    // The anti-rules (no_new_evidence, duplicate_hypothesis, …) fire inside
    // runOne; a blocked outcome is a legitimate result.
    let outcome: RunOutcome;
    try {
      outcome = await deps.runner.runOne({ taskId: task.id });
    } catch (err) {
      return {
        ran: false,
        deferred: false,
        ok: false,
        detail: `${task.id} threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      ran: true,
      deferred: false,
      ok: true,
      detail: outcome.summary,
    };
  }

  // Every candidate was deferred: report the highest-priority deferral.
  return { ran: false, deferred: true, ok: true, detail: firstDeferral ?? "all candidates deferred" };
}

/**
 * Builds the sweep's candidate list: the initial-batch order while the
 * backlog is completely empty (the bootstrap path declared in
 * schedules.yml), then the ranked eligible list via TaskRunner.pickRanked.
 * Non-diagnose tasks are never selected — they are not runnable from the
 * catalogue CLI and would otherwise wedge the sweep at the top of the queue.
 * Bounded to the first MAX_SWEEP_CANDIDATES ranks.
 */
const MAX_SWEEP_CANDIDATES = 25;

async function pickSweepCandidates(deps: SweepDeps): Promise<TaskDefinition[]> {
  const tracked = deps.backlog.list();
  const hasAnyEntry = tracked.length > 0;

  if (!hasAnyEntry && deps.schedules.initial_batch.length > 0) {
    const bootstrap = deps.schedules.initial_batch
      .map((id) => deps.registry.get(id) as TaskDefinition | undefined)
      .filter((t): t is TaskDefinition => Boolean(t && t.execution.mode === "diagnose" && !deps.backlog.get(t.id)));
    if (bootstrap.length > 0) return bootstrap;
  }

  const ranked = await deps.runner.pickRanked({ mode: "diagnose" });
  return ranked.slice(0, MAX_SWEEP_CANDIDATES).map((r) => r.task);
}

// ── The persistent loop ────────────────────────────────────────────────────

export interface TaskSchedulerOptions {
  /** Runs at most one task per tick (sweepOnce is the canonical impl). */
  sweep: () => Promise<SweepOutcome>;
  /** Sleep between ticks that ran a task (default 1 hour). */
  intervalMs?: number;
  /** Sleep between idle/deferred ticks (default: same as intervalMs). */
  idleIntervalMs?: number;
  /** Hard cap on tasks actually run (default: unlimited). */
  maxTasks?: number;
  /** Hard cap on consecutive idle ticks — the evidence budget (default: unlimited). */
  maxIdleTicks?: number;
  /** Consecutive failed sweeps before stopping (default 3). */
  maxConsecutiveFailures?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: { log: (message: string) => void; error: (message: string) => void };
}

export interface SchedulerRunSummary {
  tasksRun: number;
  tasksDeferred: number;
  failedSweeps: number;
  idleTicks: number;
  stoppedReason: "max-tasks" | "max-idle-ticks" | "consecutive-failures" | "stopped";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TaskScheduler {
  private readonly sweep: TaskSchedulerOptions["sweep"];
  private readonly intervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly maxTasks: number;
  private readonly maxIdleTicks: number;
  private readonly maxConsecutiveFailures: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { log: (m: string) => void; error: (m: string) => void };
  private stopped = false;

  constructor(opts: TaskSchedulerOptions) {
    this.sweep = opts.sweep;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.idleIntervalMs = opts.idleIntervalMs ?? this.intervalMs;
    this.maxTasks = opts.maxTasks ?? Number.POSITIVE_INFINITY;
    this.maxIdleTicks = opts.maxIdleTicks ?? Number.POSITIVE_INFINITY;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger ?? { log: console.log, error: console.error };
  }

  /** Requests the loop to exit after the current step (SIGINT-safe). */
  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<SchedulerRunSummary> {
    const summary: SchedulerRunSummary = {
      tasksRun: 0,
      tasksDeferred: 0,
      failedSweeps: 0,
      idleTicks: 0,
      stoppedReason: "stopped",
    };
    let consecutiveFailures = 0;

    while (!this.stopped) {
      if (summary.tasksRun >= this.maxTasks) {
        summary.stoppedReason = "max-tasks";
        break;
      }
      if (summary.idleTicks >= this.maxIdleTicks) {
        summary.stoppedReason = "max-idle-ticks";
        this.logger.log(`[TaskScheduler] ${summary.idleTicks} idle tick(s) without an eligible task — stopping.`);
        break;
      }

      let outcome: SweepOutcome;
      try {
        outcome = await this.sweep();
      } catch (err) {
        outcome = {
          ran: false,
          deferred: false,
          ok: false,
          detail: `sweep threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!outcome.ok) {
        summary.failedSweeps++;
        consecutiveFailures++;
        this.logger.error(`[TaskScheduler] ${outcome.detail}`);
        if (consecutiveFailures >= this.maxConsecutiveFailures) {
          summary.stoppedReason = "consecutive-failures";
          this.logger.error(
            `[TaskScheduler] ${consecutiveFailures} consecutive failed sweeps — stopping to protect the budget.`,
          );
          break;
        }
        await this.sleep(this.idleIntervalMs);
        continue;
      }

      if (outcome.ran) {
        summary.tasksRun++;
        consecutiveFailures = 0;
        this.logger.log(`[TaskScheduler] ${outcome.detail}`);
        if (summary.tasksRun >= this.maxTasks) {
          summary.stoppedReason = "max-tasks";
          break;
        }
        await this.sleep(this.intervalMs);
        continue;
      }

      // Deferred and no-eligible outcomes both count toward the idle budget:
      // a deferred sweep is waiting for cadence/evidence, which IS idling.
      // Without this, a pathological all-deferred loop would never stop even
      // under --max-idle-ticks.
      summary.idleTicks++;
      if (outcome.deferred) {
        summary.tasksDeferred++;
        this.logger.log(`[TaskScheduler] ${outcome.detail}`);
      } else {
        this.logger.log(`[TaskScheduler] Idle tick: ${outcome.detail}`);
      }
      await this.sleep(this.idleIntervalMs);
    }

    if (this.stopped) summary.stoppedReason = "stopped";
    this.logger.log(
      `[TaskScheduler] Loop finished: ${summary.tasksRun} task(s) run, ${summary.tasksDeferred} deferred, ${summary.failedSweeps} failed sweep(s), ${summary.idleTicks} idle tick(s) — ${summary.stoppedReason}.`,
    );
    return summary;
  }
}
