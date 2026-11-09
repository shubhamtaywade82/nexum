/**
 * Plan-step contracts: the vocabulary a plan is written in. Domain-neutral, so the runtime
 * (checkpoints, execution events, mission derivation) and the control plane (orchestration)
 * both depend on this module, and neither depends on the other.
 */

export type StepStatus =
  | "pending"
  | "analyzing"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked"
  | "paused"
  | "cancelled"
  | "rejected"
  | "rolledback"
  | "running"; // running kept for compatibility if needed

export interface PlanStep {
  id: string;
  description: string;
  status: StepStatus;
  dependencies: string[];
  rollbackCommand?: string;
  /**
   * Shell command that exits 0 only when this step is actually done (e.g. a
   * focused test run). When present, the step completes only through the
   * verification gate — the model saying it finished is not enough.
   */
  verify?: string;
  retryCount: number;
  priority?: "low" | "medium" | "high" | "critical";
}

export type StepOutcome =
  | { kind: "success"; output: Record<string, unknown> }
  | { kind: "retryable"; error: string }
  | { kind: "blocking"; error: string };

export interface HistoryEntry {
  stepId: string;
  outcome: StepOutcome;
  at: number;
}
