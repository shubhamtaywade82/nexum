/**
 * Run-scoped resource accounting. One BudgetTracker per execution — it is
 * the enforcement arm of ExecutionBudget (src/kernel/types.ts).
 *
 * The tracker throws BudgetExhaustedError (from provider/errors.ts) the
 * moment a guarded consumption exceeds its ceiling, so strategies fail
 * fast instead of silently burning resources.
 */

import { randomUUID } from "node:crypto";
import { BudgetExhaustedError } from "../../models/errors.js";
import type { BudgetMeter, BudgetUsage, ExecutionBudget, RunId, SessionId } from "../../core/types.js";

/** Error thrown when a run exceeds a declared budget dimension. */
export class WallClockBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("wallclock", consumed, limit);
  }
}

export class ToolCallBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("steps", consumed, limit);
  }
}

export class ModelCallBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("steps", consumed, limit);
  }
}

export class TokenBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("tokens", consumed, limit);
  }
}

export class CostBudgetError extends BudgetExhaustedError {
  constructor(consumed: number, limit: number) {
    super("tokens", Math.round(consumed * 1e6) / 1e6, limit);
  }
}

export interface BudgetTrackerOptions {
  runId?: RunId;
  sessionId?: SessionId;
  budget?: ExecutionBudget;
  now?: () => number;
}

/** Usage handed to `consumeModelCall`. Counts are what the provider reported; an absent count is unknown. */
export interface UsageConsumption {
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  usageSource?: "PROVIDER" | "MISSING";
}

/** Unmetered: the provider said its usage is missing, or the call arrived with no counts at all. */
function isUnmetered(opts: UsageConsumption): boolean {
  if (opts.usageSource === "MISSING") return true;
  return opts.usageSource === undefined && opts.promptTokens === undefined && opts.completionTokens === undefined;
}

export class BudgetTracker implements BudgetMeter {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly budget: ExecutionBudget;

  private readonly startedAt: number;
  private readonly nowFn: () => number;
  private usage: BudgetUsage = {
    toolCalls: 0,
    modelCalls: 0,
    totalTokens: 0,
    costUsd: 0,
    elapsedMs: 0,
    unmeteredModelCalls: 0,
  };

  constructor(opts: BudgetTrackerOptions = {}) {
    this.runId = opts.runId ?? `run_${randomUUID()}`;
    this.sessionId = opts.sessionId ?? `sess_${randomUUID()}`;
    this.budget = opts.budget ?? {};
    this.nowFn = opts.now ?? (() => Date.now());
    this.startedAt = this.nowFn();
  }

  /** Current consumption. `elapsedMs` is computed live. */
  snapshot(): BudgetUsage {
    return { ...this.usage, elapsedMs: Math.max(0, this.nowFn() - this.startedAt) };
  }

  get elapsedMs(): number {
    return Math.max(0, this.nowFn() - this.startedAt);
  }

  /** Throws WallClockBudgetError once the run is past its deadline. */
  assertTimeLeft(): void {
    const deadline = this.budget.deadlineMs;
    if (deadline === undefined) return;
    const elapsed = this.elapsedMs;
    if (elapsed >= deadline) throw new WallClockBudgetError(elapsed, deadline);
  }

  /**
   * Record one tool call. Throws ToolCallBudgetError when the ceiling is
   * exceeded — call before executing the tool.
   */
  consumeToolCall(): void {
    const limit = this.budget.maxToolCalls;
    this.usage.toolCalls += 1;
    if (limit !== undefined && this.usage.toolCalls > limit) {
      throw new ToolCallBudgetError(this.usage.toolCalls, limit);
    }
  }

  /**
   * Record one model call with its token usage. Throws ModelCallBudgetError /
   * TokenBudgetError / CostBudgetError when a ceiling is exceeded.
   * `costUsd` is an optional per-call estimate from the model profile.
   *
   * A call whose usage the provider did not report (`usageSource: "MISSING"`, or no counts at all) still
   * counts as a model call, and is also counted as unmetered. Its tokens and cost are unknown, so none are
   * invented: the usage counters only ever hold what providers reported.
   */
  consumeModelCall(opts: UsageConsumption = {}): void {
    const limit = this.budget.maxModelCalls;
    this.usage.modelCalls += 1;
    if (limit !== undefined && this.usage.modelCalls > limit) {
      throw new ModelCallBudgetError(this.usage.modelCalls, limit);
    }
    if (isUnmetered(opts)) {
      this.usage.unmeteredModelCalls = (this.usage.unmeteredModelCalls ?? 0) + 1;
    }

    const tokens = (opts.promptTokens ?? 0) + (opts.completionTokens ?? 0);
    this.usage.totalTokens += tokens;
    const tokenLimit = this.budget.maxTotalTokens;
    if (tokenLimit !== undefined && this.usage.totalTokens > tokenLimit) {
      throw new TokenBudgetError(this.usage.totalTokens, tokenLimit);
    }

    if (opts.costUsd !== undefined) {
      this.usage.costUsd = Math.round((this.usage.costUsd + opts.costUsd) * 1e6) / 1e6;
      const costLimit = this.budget.maxCostUsd;
      if (costLimit !== undefined && this.usage.costUsd > costLimit) {
        throw new CostBudgetError(this.usage.costUsd, costLimit);
      }
    }
  }
}
