/**
 * The authorization context of one tool call, as the gateway receives it.
 *
 * It is built in ONE place from the run's canonical ExecutionContext (see `toolInvocationFor` in
 * runtime/context/execution-context.ts), so a strategy cannot forget a field: every policy input the
 * run owns is carried, typed with the domain's own types, rather than re-threaded as loose optionals.
 */

import type { AgentId, BudgetMeter, BudgetUsage, ExecutionBudget, RunId, TaskSpec } from "../types.js";
import type { TaskId } from "../identity.js";
import type { EnvironmentPolicyContext, WorkspacePolicyContext } from "../policy/policy-engine.js";

/** The run's budget as the policy saw it when the call was authorized. */
export interface BudgetContext {
  readonly usage: BudgetUsage;
  /** The ceilings in force for the run. */
  readonly limits: ExecutionBudget;
  /** True when a ceiling was already reached before this call. Judged before the call consumes anything. */
  readonly depleted: boolean;
  /** Live deadline check, so a call cannot start after the run's wall-clock budget is spent. */
  assertTimeLeft(): void;
}

export interface ToolInvocationContext {
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly task: TaskSpec;
  readonly budget: BudgetContext;
  readonly workspace?: WorkspacePolicyContext;
  readonly environment?: EnvironmentPolicyContext;
  readonly mode?: string;
  readonly unattended: boolean;
  readonly signal: AbortSignal;
  /** A human has already approved this exact call (set on the retry after a ConfirmationRequired outcome). */
  readonly confirmed?: boolean;
}

/**
 * Captures a meter's state now. Depletion is read here, so the caller must capture before it consumes
 * for the call being authorized.
 */
export function budgetContextOf(meter: BudgetMeter): BudgetContext {
  return {
    usage: meter.snapshot(),
    limits: { ...(meter.limits?.() ?? {}) },
    depleted: meter.isDepleted?.() === true,
    assertTimeLeft: () => meter.assertTimeLeft(),
  };
}
