/**
 * Core domain types for the Nexum Harness Evolution System.
 *
 * Implements the meta-harness representation H = <E, T, C, S, L, V> and the
 * evolutionary feedback loop: telemetry → diagnosis → hypothesis → evaluation → promotion.
 */

export type HarnessComponent =
  "execution" | "tools" | "context" | "state" | "lifecycle" | "verification" | "routing" | "memory";

export type FailureClass =
  | "premature_completion"
  | "insufficient_context"
  | "context_overflow"
  | "bad_context_selection"
  | "tool_selection"
  | "tool_argument_error"
  | "tool_protocol_error"
  | "retry_failure"
  | "loop_failure"
  | "state_loss"
  | "checkpoint_failure"
  | "verification_gap"
  | "routing_failure"
  | "unknown"
  /** Success-driven evolution: a successful episode that succeeded wastefully. */
  | "efficiency_opportunity"
  /** Success-driven evolution: an efficient pattern observed across successful episodes. */
  | "success_pattern";

export interface Evidence {
  type: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface ExpectedImpact {
  capability: number;
  reliability: number;
  cost: number;
}

export interface HarnessDiagnosis {
  failureClass: FailureClass;
  component: HarnessComponent;
  evidence: Evidence[];
  confidence: number;
  rootCause: string;
  proposedFix: string;
  expectedImpact: ExpectedImpact;
}

export interface HarnessHypothesis {
  id: string;
  targetComponent: HarnessComponent;
  statement: string;
  predictedEffect: string;
  evaluationPlan: string;
  createdAt: number;
}

export interface EvaluationMetrics {
  capability: {
    taskSuccessRate: number;
    verificationPassRate: number;
  };
  reliability: {
    toolErrorRate: number;
    falseSuccessRate: number;
    loopAbortRate: number;
  };
  efficiency: {
    avgTokens: number;
    avgLatencyMs: number;
  };
  generalization: {
    heldOutScore: number;
    transferScore: number;
  };
}

export type VersionStatus = "candidate" | "validated" | "promoted" | "rejected" | "rolled_back";

export interface HarnessVersion {
  id: string;
  commitSha: string;
  parentId: string | null;
  createdAt: number;
  targetComponent: HarnessComponent;
  hypothesis: string;
  metrics: EvaluationMetrics;
  status: VersionStatus;
}

export interface ComparisonResult {
  candidateId: string;
  baselineId: string;
  decision: "promote" | "reject" | "inconclusive";
  scoreDeltas: {
    capability: number;
    reliability: number;
    efficiency: number;
    generalization: number;
  };
  rationale: string;
}
