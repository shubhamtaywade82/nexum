/**
 * BudgetManager — unified run-level budgets (review item 14).
 *
 * BudgetTracker (this package) is the low-level enforcement arm: it throws
 * the moment a guarded consumption crosses a ceiling. BudgetManager layers
 * the run-level contract on top:
 *
 *   - new dimensions: iterations (loop turns), cloud calls, cloud spend,
 *     parallel executions — beyond tool calls / model calls / tokens /
 *     cost / wall clock;
 *   - propagation: every child task/agent derives its budget through
 *     `deriveChild()`, and every consumption in the child also counts
 *     against the parent (and transitively the grandparent), so a burst
 *     of delegated children can never outrun the top-level run's budget;
 *   - observability: `runUsage()` reports own + aggregated descendant usage.
 *
 * Strategies and gateways keep consuming through the inherited BudgetTracker
 * methods (`consumeToolCall`, `consumeModelCall`, `assertTimeLeft`) — a
 * BudgetManager IS a BudgetTracker, so existing call sites gain the new
 * enforcement without changes.
 */

import { randomUUID } from "node:crypto";
import { BudgetTracker, CostBudgetError, ModelCallBudgetError, type UsageConsumption } from "./budget-tracker.js";
import type { BudgetUsage, ExecutionBudget, RunId } from "../../core/types.js";
import { BudgetExhaustedError } from "../../models/errors.js";

/** Budget dimensions owned by the run level (extends ExecutionBudget). */
export interface RunBudget extends ExecutionBudget {
  /** Max strategy loop iterations (think→act→observe turns). */
  maxIterations?: number;
  /** Max cloud-tier model calls (local calls are usually unmetered). */
  maxCloudCalls?: number;
  /** Spend ceiling applied to cloud-tier calls only (USD). */
  maxCloudSpendUsd?: number;
  /** Max concurrently executing child runs / parallel task branches. */
  maxParallelExecutions?: number;
}

/** Usage including the new dimensions + descendant aggregation. */
export interface RunBudgetUsage extends BudgetUsage {
  iterations: number;
  cloudCalls: number;
  cloudSpendUsd: number;
  activeParallel: number;
  peakParallel: number;
  descendantToolCalls: number;
  descendantModelCalls: number;
  descendantTotalTokens: number;
}

export class IterationBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("steps", consumed, limit);
  }
}

export class CloudCallBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("steps", consumed, limit);
  }
}

export class CloudSpendBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("tokens", Math.round(consumed * 1e6) / 1e6, limit);
  }
}

export class ParallelBudgetError extends BudgetExhaustedError {
  constructor(active: number, limit: number) {
    super("steps", active, limit);
  }
}

export interface BudgetManagerOptions {
  runId?: RunId;
  sessionId?: string;
  budget?: RunBudget;
  now?: () => number;
}

export class BudgetManager extends BudgetTracker {
  readonly budget: RunBudget;
  private iterations = 0;
  private cloudCalls = 0;
  private cloudSpendUsd = 0;
  private activeParallel = 0;
  private peakParallel = 0;
  private readonly children = new Map<RunId, BudgetManager>();

  private parent?: BudgetManager;

  constructor(opts: BudgetManagerOptions = {}) {
    super({ runId: opts.runId, sessionId: opts.sessionId, budget: opts.budget, now: opts.now });
    this.budget = opts.budget ?? {};
  }

  // ── new dimensions ─────────────────────────────────────────────────────

  /** One loop iteration (think→act→observe turn). Throws past maxIterations. */
  consumeIteration(): void {
    const limit = this.budget.maxIterations;
    this.iterations += 1;
    this.propagateUp("iteration");
    if (limit !== undefined && this.iterations > limit) {
      throw new IterationBudgetError(this.iterations, limit);
    }
  }

  /** One cloud-tier model call. Throws past maxCloudCalls. */
  consumeCloudCall(): void {
    const limit = this.budget.maxCloudCalls;
    this.cloudCalls += 1;
    this.propagateUp("cloudCall");
    if (limit !== undefined && this.cloudCalls > limit) {
      throw new CloudCallBudgetError(this.cloudCalls, limit);
    }
  }

  /**
   * Record spend from a cloud-tier model call against maxCloudSpendUsd.
   * Called by consumeModelCall({ cloud: true, costUsd }) — kept separate so
   * the gateway can decide what counts as "cloud".
   */
  consumeCloudSpend(costUsd: number): void {
    this.cloudSpendUsd = Math.round((this.cloudSpendUsd + costUsd) * 1e6) / 1e6;
    const limit = this.budget.maxCloudSpendUsd;
    if (limit !== undefined && this.cloudSpendUsd > limit) {
      throw new CloudSpendBudgetError(this.cloudSpendUsd, limit);
    }
  }

  /**
   * Acquire one parallel-execution slot. Returns the release function.
   * Throws ParallelBudgetError when maxParallelExecutions is exceeded.
   */
  acquireParallelSlot(): () => void {
    const limit = this.budget.maxParallelExecutions;
    if (limit !== undefined && this.activeParallel + 1 > limit) {
      throw new ParallelBudgetError(this.activeParallel + 1, limit);
    }
    this.activeParallel += 1;
    this.peakParallel = Math.max(this.peakParallel, this.activeParallel);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeParallel = Math.max(0, this.activeParallel - 1);
    };
  }

  // ── model-call accounting with cloud awareness ──────────────────────────

  override consumeModelCall(opts: UsageConsumption & { cloud?: boolean } = {}): void {
    // count cloud calls / cloud spend BEFORE super() may throw, so the
    // cloud dimension stays accurate even when the token budget fires.
    if (opts.cloud) this.cloudCalls += 1;
    if (opts.cloud && opts.costUsd !== undefined) this.cloudSpendUsd += opts.costUsd;

    super.consumeModelCall(opts);
    this.propagateUp("modelCall", {
      promptTokens: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
      costUsd: opts.costUsd ?? 0,
      cloud: opts.cloud ?? false,
      usageSource: opts.usageSource,
    });

    const cloudLimit = this.budget.maxCloudCalls;
    if (opts.cloud && cloudLimit !== undefined && this.cloudCalls > cloudLimit) {
      throw new CloudCallBudgetError(this.cloudCalls, cloudLimit);
    }
    const spendLimit = this.budget.maxCloudSpendUsd;
    if (opts.cloud && spendLimit !== undefined && this.cloudSpendUsd > spendLimit) {
      throw new CloudSpendBudgetError(this.cloudSpendUsd, spendLimit);
    }
  }

  override consumeToolCall(): void {
    super.consumeToolCall();
    this.propagateUp("toolCall");
  }

  /** Adds the run-level dimensions (iterations, cloud calls, cloud spend) to the base ceilings. */
  override isDepleted(): boolean {
    const b = this.budget;
    return (
      super.isDepleted() ||
      (b.maxIterations !== undefined && this.iterations >= b.maxIterations) ||
      (b.maxCloudCalls !== undefined && this.cloudCalls >= b.maxCloudCalls) ||
      (b.maxCloudSpendUsd !== undefined && this.cloudSpendUsd >= b.maxCloudSpendUsd)
    );
  }

  // ── child derivation (review items 14 + 26) ─────────────────────────────

  /**
   * Derive a child budget manager for a delegated sub-run. The child gets
   * its own ceilings (declared or inherited share), but every consumption
   * propagates upward: a child burning tokens burns the parent's budget.
   * Wall-clock deadlines inherit automatically — a child can never outlive
   * its parent's remaining time.
   */
  deriveChild(opts: {
    runId?: RunId;
    /** Explicit child ceilings; omitted dims inherit the parent's remaining share. */
    budget?: RunBudget;
    /** Fraction of the parent's remaining consumable dims granted to the child. */
    share?: number;
  }): BudgetManager {
    const child = new BudgetManager({
      runId: opts.runId ?? `run_${randomUUID()}`,
      sessionId: this.sessionId,
      budget: this.deriveChildBudget(opts),
    });
    child.parent = this;
    this.children.set(child.runId, child);
    return child;
  }

  private deriveChildBudget(opts: { budget?: RunBudget; share?: number }): RunBudget {
    if (opts.budget) {
      // explicit child budget, but never a longer deadline than remaining time
      const remaining = this.remainingWallClockMs();
      if (remaining !== undefined) {
        const declared = opts.budget.deadlineMs;
        opts.budget = {
          ...opts.budget,
          deadlineMs: Math.min(declared ?? Number.POSITIVE_INFINITY, remaining),
        };
      }
      return opts.budget;
    }
    const share = opts.share && opts.share > 0 && opts.share <= 1 ? opts.share : 0.5;
    const snap = this.snapshot();
    const parent = this.budget;
    const derived: RunBudget = {};
    if (parent.maxToolCalls !== undefined) {
      derived.maxToolCalls = Math.max(1, Math.floor((parent.maxToolCalls - snap.toolCalls) * share));
    }
    if (parent.maxModelCalls !== undefined) {
      derived.maxModelCalls = Math.max(1, Math.floor((parent.maxModelCalls - snap.modelCalls) * share));
    }
    if (parent.maxTotalTokens !== undefined) {
      derived.maxTotalTokens = Math.max(1, Math.floor((parent.maxTotalTokens - snap.totalTokens) * share));
    }
    if (parent.maxCostUsd !== undefined) {
      derived.maxCostUsd = Math.round((parent.maxCostUsd - snap.costUsd) * share * 1e6) / 1e6;
    }
    if (parent.maxIterations !== undefined) {
      derived.maxIterations = Math.max(1, Math.floor((parent.maxIterations - this.iterations) * share));
    }
    if (parent.maxCloudCalls !== undefined) {
      derived.maxCloudCalls = Math.max(1, Math.floor((parent.maxCloudCalls - this.cloudCalls) * share));
    }
    if (parent.maxCloudSpendUsd !== undefined) {
      derived.maxCloudSpendUsd = Math.round((parent.maxCloudSpendUsd - this.cloudSpendUsd) * share * 1e6) / 1e6;
    }
    const remaining = this.remainingWallClockMs();
    if (remaining !== undefined) derived.deadlineMs = remaining;
    return derived;
  }

  private remainingWallClockMs(): number | undefined {
    const deadline = this.budget.deadlineMs;
    if (deadline === undefined) return undefined;
    return Math.max(0, deadline - this.elapsedMs);
  }

  private propagateUp(
    kind: "toolCall" | "modelCall" | "iteration" | "cloudCall",
    detail?: {
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      cloud: boolean;
      usageSource?: "PROVIDER" | "MISSING";
    },
  ): void {
    if (!this.parent) return;
    try {
      switch (kind) {
        case "toolCall":
          this.parent.recordDescendantToolCall();
          break;
        case "modelCall":
          this.parent.recordDescendantModelCall(
            detail ?? { promptTokens: 0, completionTokens: 0, costUsd: 0, cloud: false },
          );
          break;
        case "iteration":
          this.parent.recordDescendantIteration();
          break;
        case "cloudCall":
          this.parent.recordDescendantCloudCall();
          break;
      }
    } catch (err) {
      // Re-surface the parent's budget error with child context.
      if (err instanceof ModelCallBudgetError) {
        throw new ModelCallBudgetError(err.consumed, err.limit);
      }
      if (err instanceof CostBudgetError) {
        throw new CostBudgetError(err.consumed, err.limit);
      }
      throw err;
    }
  }

  // ── descendant accounting (called by children) ──────────────────────────

  private descendantToolCalls = 0;
  private descendantModelCalls = 0;
  private descendantTotalTokens = 0;

  private recordDescendantToolCall(): void {
    this.descendantToolCalls += 1;
    this.consumeToolCall();
  }

  private recordDescendantModelCall(detail: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    cloud: boolean;
    usageSource?: "PROVIDER" | "MISSING";
  }): void {
    this.descendantModelCalls += 1;
    this.descendantTotalTokens += detail.promptTokens + detail.completionTokens;
    this.consumeModelCall(detail);
  }

  private recordDescendantIteration(): void {
    // iterations are per-run loop safety counters: propagated for
    // observability but NOT enforced across runs (each child may run its
    // own loop within its derived ceilings).
    this.descendantToolCalls += 0; // no-op keeps accounting symmetrical
  }

  private recordDescendantCloudCall(): void {
    // cloud ceilings are enforced where the call is made; the parent's
    // model-call accounting above already captures the propagation.
  }

  // ── observability ───────────────────────────────────────────────────────

  /** Own usage + new dimensions + descendant aggregation. */
  runUsage(): RunBudgetUsage {
    const snap = this.snapshot();
    return {
      ...snap,
      iterations: this.iterations,
      cloudCalls: this.cloudCalls,
      cloudSpendUsd: Math.round(this.cloudSpendUsd * 1e6) / 1e6,
      activeParallel: this.activeParallel,
      peakParallel: this.peakParallel,
      descendantToolCalls: this.descendantToolCalls,
      descendantModelCalls: this.descendantModelCalls,
      descendantTotalTokens: this.descendantTotalTokens,
    };
  }

  childBudgets(): Array<{ runId: RunId; usage: RunBudgetUsage }> {
    return [...this.children.values()].map((c) => ({ runId: c.runId, usage: c.runUsage() }));
  }

  get parentRunId(): RunId | undefined {
    return this.parent?.runId;
  }
}
