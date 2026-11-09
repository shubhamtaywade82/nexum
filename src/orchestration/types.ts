import type { HistoryEntry, PlanStep, StepOutcome } from "../core/plan/plan-contracts.js";

// The plan-step contracts moved to core/plan (the runtime depends on them, so they cannot live in
// the control plane). Re-exported here so existing control-plane imports keep working.
export type { HistoryEntry, PlanStep, StepOutcome, StepStatus } from "../core/plan/plan-contracts.js";

export interface StepRunner {
  run(step: PlanStep): Promise<StepOutcome>;
}

export interface Planner {
  replan(remaining: PlanStep[], history: HistoryEntry[]): Promise<PlanStep[]>;
}
