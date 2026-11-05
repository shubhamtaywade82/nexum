/**
 * Orchestrator — the Control Plane's plan executor.
 *
 * Sits ABOVE the kernel (docs/guide/kernel.md layering): it schedules a DAG
 * of PlanSteps, delegates each step through the StepRunner port, and owns
 * the ASL step state machine, retry/replan budgets, rollback, and
 * checkpoint/resume. It never touches tools, models, or domains — step
 * execution is fully delegated (AgentStepRunner for product turns,
 * RuntimeStepRunner for kernel runs).
 *
 * Kernel ports it consumes (the "promotion" of the control plane):
 *   - GateRegistry  — the plan's concurrency gate is acquired from the same
 *     layered registry the kernel uses (scope "global", key
 *     "control-plane"), so plan-level parallelism shows up in gate
 *     snapshots and obeys one concurrency model.
 *   - EventSink     — every step transition is published as a `mission.step`
 *     RuntimeEvent (execution family) so headless consumers and the TUI can
 *     subscribe through the kernel's event stream, alongside the legacy
 *     onStepChange callback.
 *   - AbortSignal   — cooperative cancellation: on abort no new steps are
 *     scheduled, in-flight steps unwind through their own signals, every
 *     non-terminal step is marked cancelled, and neither replan nor
 *     rollback runs. The checkpoint is deliberately kept so the plan can be
 *     resumed (Agent.resumePlannedTask).
 *
 * Signal contract with the StepRunner: the orchestrator checks the signal
 * between batches and inside runStep, but in-flight step unwinding is the
 * runner's responsibility — embeddings thread the same signal into their
 * kernel runs (createExecutionContext's `signal` option) or product turns
 * (Agent's run scope).
 */

import { PlanStep, StepRunner, Planner, HistoryEntry, StepStatus } from "./types.js";
import { CheckpointStore } from "../runtime/checkpoint.js";
import { ConcurrencyGate } from "../core/concurrency/gate.js";
import type { GateRegistry } from "../core/concurrency/gate-registry.js";
import type { EventSink } from "../core/types.js";

export class OrchestratorError extends Error {}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_REPLANS = 5;

const VALID_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["analyzing", "blocked", "cancelled", "running", "skipped"],
  analyzing: ["planning", "blocked", "cancelled", "failed"],
  planning: ["implementing", "blocked", "cancelled", "failed"],
  implementing: ["testing", "blocked", "cancelled", "failed"],
  testing: ["reviewing", "blocked", "cancelled", "failed"],
  reviewing: ["completed", "rejected", "blocked", "cancelled", "failed"],
  completed: ["rolledback"],
  failed: ["pending", "rolledback"],
  rejected: ["pending", "planning", "implementing"],
  blocked: ["pending", "analyzing", "planning", "implementing", "testing", "reviewing", "cancelled", "skipped"],
  paused: ["pending", "analyzing", "planning", "implementing", "testing", "reviewing", "skipped"],
  cancelled: [],
  rolledback: [],
  skipped: ["pending"],
  running: ["completed", "failed", "blocked", "cancelled", "testing"],
};

export interface OrchestratorOptions {
  steps: PlanStep[];
  runner: StepRunner;
  planner: Planner;
  runRollback: (command: string) => Promise<void>;
  maxRetries?: number;
  maxReplans?: number;
  concurrencyLimit?: number;
  gate?: ConcurrencyGate;
  /** Kernel gate registry — the plan gate is derived as
   * `global:control-plane` (with `concurrencyLimit` as its ceiling) when no
   * explicit gate is supplied. Takes precedence order: `gate` > `gates` >
   * standalone gate. */
  gates?: GateRegistry;
  /** Cooperative cancellation (see class doc for the exact semantics). */
  signal?: AbortSignal;
  /** Kernel event sink — publishes `mission.step` on every transition. */
  events?: EventSink;
  logger?: Pick<Console, "info" | "warn" | "error">;
  onStepChange?: (step: PlanStep) => void;
  checkpoint?: CheckpointStore;
  /** Outcome log carried over from a checkpoint, so a resumed run replans with
   * the failure history that caused the checkpoint rather than from scratch. */
  history?: HistoryEntry[];
  /** Replans already spent before the checkpoint. Without it a crash-loop
   * resets the budget to zero on every resume and the guard never fires. */
  replanCount?: number;
  /** Mission goal, persisted with the checkpoint for resume. */
  goal?: string;
}

export class Orchestrator {
  private steps: Map<string, PlanStep>;
  private readonly runner: StepRunner;
  private readonly planner: Planner;
  private readonly runRollback: (command: string) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxReplans: number;
  private readonly gate: ConcurrencyGate;
  private readonly signal?: AbortSignal;
  private readonly events?: EventSink;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly executedOrder: PlanStep[] = [];
  private readonly history: HistoryEntry[];
  private replanCount: number;
  private readonly onStepChange?: (step: PlanStep) => void;
  private readonly checkpoint?: CheckpointStore;
  private readonly goal?: string;

  constructor(opts: OrchestratorOptions) {
    this.steps = new Map(opts.steps.map((s) => [s.id, s]));
    this.runner = opts.runner;
    this.planner = opts.planner;
    this.runRollback = opts.runRollback;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxReplans = opts.maxReplans ?? DEFAULT_MAX_REPLANS;
    this.gate =
      opts.gate ??
      opts.gates?.gate("global", "control-plane", { maxConcurrent: opts.concurrencyLimit ?? 4 }) ??
      new ConcurrencyGate({ maxConcurrent: opts.concurrencyLimit ?? 4, label: "orchestrator" });
    this.signal = opts.signal;
    this.events = opts.events;
    this.logger = opts.logger ?? console;
    this.onStepChange = opts.onStepChange;
    this.checkpoint = opts.checkpoint;
    this.history = opts.history ? [...opts.history] : [];
    this.replanCount = opts.replanCount ?? 0;
    this.goal = opts.goal;
  }

  private saveCheckpoint(): void {
    this.checkpoint?.save({
      steps: [...this.steps.values()],
      history: this.history,
      replanCount: this.replanCount,
      ...(this.goal ? { goal: this.goal } : {}),
    });
  }

  async run(): Promise<PlanStep[]> {
    let order = this.topologicalOrder();

    for (;;) {
      // Abort before scheduling anything new: no fresh step may start once
      // the operator has cancelled the plan.
      if (this.signal?.aborted) {
        this.cancelRemaining();
        break;
      }

      // All steps whose dependencies are already satisfied run concurrently —
      // bounded by the ConcurrencyGate so independent steps don't overwhelm resources.
      const ready = order.filter((s) => s.status === "pending" && this.dependenciesSatisfied(s));
      if (!ready.length) break;

      const results = await Promise.all(
        ready.map((s) => this.gate.run(() => this.runStep(s), s.priority === "critical" ? "critical" : "normal")),
      );

      // Abort after the in-flight batch unwound: whatever is left pending is
      // cancelled, no replan, no rollback (runStep already declined to fail
      // steps whose runs were cut short by the abort).
      if (this.signal?.aborted) {
        this.cancelRemaining();
        break;
      }

      const replanNeeded = results.some(Boolean);
      if (!replanNeeded) continue;

      this.replanCount += 1;
      if (this.replanCount > this.maxReplans) {
        throw new OrchestratorError(`exceeded ${this.maxReplans} re-plans — aborting to avoid an unbounded loop`);
      }

      const remaining = order.filter((s) => s.status !== "completed" && s.status !== "failed");
      const revised = await this.planner.replan(remaining, this.history);
      this.applyReplan(revised);
      order = this.topologicalOrder();
    }

    // Rollback is a failure-handling path, not a cancellation path: on abort
    // the operator owns cleanup, and the checkpoint preserves the plan for
    // resume. (The rollback command runs as a user message, which would
    // itself be aborted — it could not do useful work anyway.)
    if (!this.signal?.aborted && [...this.steps.values()].some((s) => s.status === "failed")) {
      await this.rollbackAll();
    }

    if (!this.signal?.aborted) this.checkpoint?.clear();
    return [...this.steps.values()];
  }

  /** Marks every non-terminal step cancelled (invalid transitions no-op via
   * transitionStatus) and logs the unwind. */
  private cancelRemaining(): void {
    const terminal: ReadonlySet<StepStatus> = new Set(["completed", "failed", "skipped", "cancelled", "rolledback"]);
    for (const step of this.steps.values()) {
      if (terminal.has(step.status)) continue;
      this.transitionStatus(step, "cancelled");
    }
    this.logger.warn("[Orchestrator] abort requested — remaining steps cancelled (checkpoint kept for resume)");
  }

  private dependenciesSatisfied(step: PlanStep): boolean {
    return step.dependencies.every((depId) => this.steps.get(depId)?.status === "completed");
  }

  private transitionStatus(step: PlanStep, to: StepStatus): void {
    const from = step.status;
    if (from === to) return;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      this.logger.warn(`[Orchestrator] Invalid ASL transition from '${from}' to '${to}' for step ${step.id}`);
      // Do not perform invalid transition; keep current status.
      return;
    }
    step.status = to;
    this.onStepChange?.(step);
    // Kernel event stream: a shallow copy so listeners holding the event do
    // not observe later in-place mutations of the PlanStep.
    this.events?.publish({ type: "mission.step", step: { ...step } });
    this.saveCheckpoint();
  }

  private async runStep(step: PlanStep): Promise<boolean> {
    // The abort may land while this step sat queued at the concurrency gate;
    // it must not start (transition to cancelled happens in cancelRemaining,
    // but the gate lease may already be held — bail before any transition).
    if (this.signal?.aborted) return false;

    this.transitionStatus(step, "analyzing");
    this.transitionStatus(step, "planning");
    this.transitionStatus(step, "implementing");

    const outcome = await this.runner.run(step);

    // A step whose run was cut short by the abort is cancelled, not failed:
    // it must not cascade to dependents as skipped, must not trigger a
    // replan, and must not join the rollback set. A step that actually
    // finished successfully before the abort landed is completed — the work
    // was done; only further scheduling stops. Its outcome still lands in
    // the history below so a resumed plan's replanner sees it.
    if (this.signal?.aborted && outcome.kind !== "success") {
      this.history.push({ stepId: step.id, outcome, at: Date.now() });
      this.transitionStatus(step, "cancelled");
      return false;
    }

    this.history.push({ stepId: step.id, outcome, at: Date.now() });

    if (outcome.kind === "success") {
      this.transitionStatus(step, "testing");
      this.transitionStatus(step, "reviewing");
      this.transitionStatus(step, "completed");
      this.executedOrder.push(step);
      return false;
    }

    if (outcome.kind === "retryable" && step.retryCount < this.maxRetries) {
      step.retryCount += 1;
      this.transitionStatus(step, "failed");
      this.transitionStatus(step, "pending");
      this.logger.warn(`[Orchestrator] ${step.id} retry ${step.retryCount}/${this.maxRetries}: ${outcome.error}`);
      return false;
    }

    this.transitionStatus(step, "failed");
    this.cascadeFailure(step.id);
    this.logger.warn(`[Orchestrator] ${step.id} failed — triggering RE_PLAN: ${outcome.error}`);
    return true;
  }

  private cascadeFailure(failedId: string): void {
    for (const step of this.steps.values()) {
      if (step.status === "pending" && step.dependencies.includes(failedId)) {
        this.transitionStatus(step, "skipped");
        this.cascadeFailure(step.id);
      }
    }
  }

  private applyReplan(revised: PlanStep[]): void {
    for (const step of revised) {
      this.steps.set(step.id, step);
    }
    this.saveCheckpoint();
  }

  private topologicalOrder(): PlanStep[] {
    const visited = new Set<string>();
    const order: PlanStep[] = [];

    const visit = (step: PlanStep, stack: Set<string>) => {
      if (visited.has(step.id)) return;
      if (stack.has(step.id)) throw new OrchestratorError(`dependency cycle detected at ${step.id}`);

      stack.add(step.id);
      for (const depId of step.dependencies) {
        const dep = this.steps.get(depId);
        if (!dep) throw new OrchestratorError(`${step.id} depends on unknown step ${depId}`);
        visit(dep, stack);
      }
      stack.delete(step.id);
      visited.add(step.id);
      order.push(step);
    };

    for (const step of this.steps.values()) visit(step, new Set());
    return order;
  }

  private async rollbackAll(): Promise<void> {
    for (const step of [...this.executedOrder].reverse()) {
      if (!step.rollbackCommand) continue;
      this.logger.info(`[Orchestrator] rolling back ${step.id}: ${step.rollbackCommand}`);
      try {
        await this.runRollback(step.rollbackCommand);
      } catch (e) {
        this.logger.error(`[Orchestrator] rollback for ${step.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
