/**
 * EvolutionWorker — the persistent, policy-controlled evolution loop (v2.4).
 *
 * `nexum evolve --mutate` runs exactly one cycle. A real self-developing
 * system needs a loop that keeps running: observe accumulated evidence,
 * decide whether an experiment is justified, run it, and repeat. This worker
 * owns that loop with two hard policy invariants:
 *
 *   1. NEVER MUTATE BECAUSE A SCHEDULE FIRED. Every tick re-observes the
 *      evidence and only proceeds when a capability target exists AND its
 *      confidence clears the configured threshold. No target → idle tick.
 *
 *   2. BUDGETED FAILURE. Consecutive failed cycles (prepare/implement/verify
 *      stage failures, not rejected hypotheses — a clean rejection is a
 *      RESULT) stop the worker instead of burning the improvement budget in a
 *      tight loop.
 *
 * The worker itself never touches the harness repository: `observe` and
 * `runCycle` are injected, so the loop logic is testable without git,
 * worktrees or models.
 */

import { ImprovementTarget } from "./targets/target-engine.js";

export interface EvolutionWorkerOptions {
  /** Loads current evidence and forms the improvement target WITHOUT mutating. */
  observe: () => Promise<{ target: ImprovementTarget | null }>;
  /** Runs one full mutation cycle (worktree → edits → verify → benchmark). */
  runCycle: () => Promise<EvolutionCycleResult>;
  /** Sleep between active cycles (default 1 hour). */
  intervalMs?: number;
  /** Sleep between idle ticks (default: same as intervalMs). */
  idleIntervalMs?: number;
  /** Hard cap on mutation cycles (default: unlimited). */
  maxCycles?: number;
  /** Hard cap on consecutive idle ticks — the evidence-gathering budget (default: unlimited). */
  maxIdleTicks?: number;
  /** Minimum target confidence required to run a cycle (default 0.5). */
  minTargetConfidence?: number;
  /** Consecutive failed cycles before the worker stops (default 3). */
  maxConsecutiveFailures?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: { log: (message: string) => void; error: (message: string) => void };
}

export interface EvolutionCycleResult {
  ok: boolean;
  /** True when nothing ran at all (e.g. no target formed between gate and cycle): counted as idle, not failure. */
  skipped?: boolean;
  /** Human-readable outcome (stage + reason, or rejection rationale). */
  detail: string;
}

export interface WorkerRunSummary {
  cyclesStarted: number;
  cyclesSucceeded: number;
  cyclesFailed: number;
  idleTicks: number;
  stoppedReason: "max-cycles" | "max-idle-ticks" | "consecutive-failures" | "stopped";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EvolutionWorker {
  private readonly observe: EvolutionWorkerOptions["observe"];
  private readonly runCycle: EvolutionWorkerOptions["runCycle"];
  private readonly intervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly maxCycles: number;
  private readonly maxIdleTicks: number;
  private readonly minTargetConfidence: number;
  private readonly maxConsecutiveFailures: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { log: (m: string) => void; error: (m: string) => void };
  private stopped = false;

  constructor(opts: EvolutionWorkerOptions) {
    this.observe = opts.observe;
    this.runCycle = opts.runCycle;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.idleIntervalMs = opts.idleIntervalMs ?? this.intervalMs;
    this.maxCycles = opts.maxCycles ?? Number.POSITIVE_INFINITY;
    this.maxIdleTicks = opts.maxIdleTicks ?? Number.POSITIVE_INFINITY;
    this.minTargetConfidence = opts.minTargetConfidence ?? 0.5;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger ?? { log: console.log, error: console.error };
  }

  /** Requests the loop to exit after the current step (SIGINT-safe). */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Runs the evolution loop until a stop condition is reached:
   * max-cycles reached, too many consecutive failures, or stop() called.
   */
  async run(): Promise<WorkerRunSummary> {
    const summary: WorkerRunSummary = {
      cyclesStarted: 0,
      cyclesSucceeded: 0,
      cyclesFailed: 0,
      idleTicks: 0,
      stoppedReason: "stopped",
    };
    let consecutiveFailures = 0;

    while (!this.stopped) {
      if (summary.cyclesStarted >= this.maxCycles) {
        summary.stoppedReason = "max-cycles";
        break;
      }
      if (summary.idleTicks >= this.maxIdleTicks) {
        summary.stoppedReason = "max-idle-ticks";
        this.logger.log(
          `[EvolutionWorker] ${summary.idleTicks} idle tick(s) without an operationalizable target — evidence budget exhausted, stopping.`,
        );
        break;
      }

      // 1. Policy gate: observe fresh evidence, form the target. The worker
      //    never mutates just because the timer fired.
      let observation: { target: ImprovementTarget | null };
      try {
        observation = await this.observe();
      } catch (err) {
        this.logger.error(`[EvolutionWorker] observation failed: ${err instanceof Error ? err.message : String(err)}`);
        summary.idleTicks++;
        await this.sleep(this.idleIntervalMs);
        continue;
      }
      const target = observation.target;

      if (!target) {
        summary.idleTicks++;
        this.logger.log(
          `[EvolutionWorker] No operationalizable target from current evidence — idling (tick ${summary.idleTicks}).`,
        );
        await this.sleep(this.idleIntervalMs);
        continue;
      }
      if (target.confidence < this.minTargetConfidence) {
        summary.idleTicks++;
        this.logger.log(
          `[EvolutionWorker] Target confidence ${(target.confidence * 100).toFixed(0)}% below policy threshold ${(this.minTargetConfidence * 100).toFixed(0)}% — gathering more evidence instead of mutating.`,
        );
        await this.sleep(this.idleIntervalMs);
        continue;
      }

      // 2. Run one full mutation cycle.
      this.logger.log(
        `[EvolutionWorker] Running mutation cycle (capability: ${target.capability}, confidence ${(target.confidence * 100).toFixed(0)}%).`,
      );
      let result: EvolutionCycleResult;
      try {
        result = await this.runCycle();
      } catch (err) {
        result = {
          ok: false,
          detail: `cycle threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (result.skipped) {
        // The gate passed but the cycle found no target (evidence changed
        // under us, or the single-shot safety guard fired): idle, not failure.
        summary.idleTicks++;
        this.logger.log(`[EvolutionWorker] Cycle skipped: ${result.detail}`);
        await this.sleep(this.idleIntervalMs);
        continue;
      }
      summary.cyclesStarted++;
      if (result.ok) {
        summary.cyclesSucceeded++;
        consecutiveFailures = 0;
        this.logger.log(`[EvolutionWorker] Cycle ${summary.cyclesStarted} completed: ${result.detail}`);
      } else {
        summary.cyclesFailed++;
        consecutiveFailures++;
        this.logger.error(`[EvolutionWorker] Cycle ${summary.cyclesStarted} failed: ${result.detail}`);
        if (consecutiveFailures >= this.maxConsecutiveFailures) {
          summary.stoppedReason = "consecutive-failures";
          this.logger.error(
            `[EvolutionWorker] ${consecutiveFailures} consecutive cycle failures — stopping to protect the improvement budget.`,
          );
          break;
        }
      }

      // 3. Cooldown before the next observation.
      if (!this.stopped && summary.cyclesStarted < this.maxCycles) {
        await this.sleep(this.intervalMs);
      }
    }

    if (this.stopped) summary.stoppedReason = "stopped";
    this.logger.log(
      `[EvolutionWorker] Loop finished: ${summary.cyclesStarted} cycle(s) (${summary.cyclesSucceeded} ok, ${summary.cyclesFailed} failed), ${summary.idleTicks} idle tick(s) — ${summary.stoppedReason}.`,
    );
    return summary;
  }
}
