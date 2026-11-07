/**
 * Experiment Schema for Nexum's closed-loop self-development.
 *
 * Every harness mutation becomes a persistent EXPERIMENT RECORD with full
 * provenance — parent/candidate harness versions and commits, the formed
 * target, the hypothesis, the frozen executor matrix, the visible / held-out
 * / transfer evaluation results, the two-stage decision, CI status, and
 * review state.
 *
 * The GitHub PR is generated FROM this record, making the PR a persistent
 * experiment log rather than merely a code review artifact.
 */

import { ImprovementTarget } from "../targets/target-engine.js";
import { EvolutionState } from "../state-machine.js";

export interface ExperimentParent {
  harness: string;
  commit: string;
}

export interface ExperimentCandidate {
  harness: string;
  commit: string;
}

export interface ExperimentTargetSummary {
  capability: string;
  targetId: string;
  desiredOutcome: string;
}

export interface ExperimentHypothesis {
  id: string;
  statement: string;
  predictedEffect: string;
}

export interface ExecutorConfig {
  primary: string;
  /** Fixed-executor protocol: transfer executors the candidate must also pass. */
  transfer: string[];
}

export interface ExperimentEvaluation {
  visible: Record<string, number>;
  held_out: Record<string, number>;
  transfer: Record<string, number>;
}

export interface ExperimentMetrics {
  capability: number;
  reliability: number;
  efficiency: number;
  generalization: number;
}

export interface ExperimentDecision {
  result: "eligible" | "rejected" | "inconclusive";
  stageA: "valid" | "invalid" | "not_run";
  stageB: "improved" | "not_improved" | "not_run";
  rationale: string;
}

export type ExperimentCiStatus = "pending" | "passed" | "failed";
export type ExperimentReviewState = "pending" | "approved" | "changes_requested";

/**
 * The complete provenance record for one harness evolution experiment.
 * Serialized as YAML into the evolution PR body (see delivery.ts).
 */
export interface ExperimentRecord {
  id: string;
  parent: ExperimentParent;
  candidate: ExperimentCandidate;
  target: ExperimentTargetSummary;
  hypothesis: ExperimentHypothesis;
  executor: ExecutorConfig;
  evaluation: ExperimentEvaluation;
  metrics: ExperimentMetrics;
  decision: ExperimentDecision;
  ci: {
    status: ExperimentCiStatus;
    runUrl?: string;
  };
  review: {
    state: ExperimentReviewState;
    reviewer?: string;
  };
  /** Lifecycle state from the evolution state machine. */
  lifecycle: {
    state: EvolutionState;
    enteredAt: number;
  };
  /** Mutation scope components used for this experiment (single or compound). */
  scopeComponents?: string[];
  /**
   * The commit that landed on the base branch, recorded only after a merge was
   * confirmed against GitHub. Activation must match it. Absent until then.
   */
  mergeCommitSha?: string;
  createdAt: number;
}

/** Validation helper: ensures a record has all mandatory provenance fields. */
export function validateExperimentRecord(rec: ExperimentRecord): string[] {
  const problems: string[] = [];
  if (!rec.id) problems.push("experiment.id is required");
  if (!rec.parent?.harness) problems.push("parent.harness is required");
  if (!rec.parent?.commit) problems.push("parent.commit is required");
  if (!rec.candidate?.harness) problems.push("candidate.harness is required");
  if (!rec.candidate?.commit) problems.push("candidate.commit is required");
  if (!rec.target?.capability) problems.push("target.capability is required");
  if (!rec.hypothesis?.statement) problems.push("hypothesis.statement is required");
  if (!rec.executor?.primary) problems.push("executor.primary is required");
  if (!rec.decision?.result) problems.push("decision.result is required");
  return problems;
}

/** Builds the target summary embedded in the experiment record. */
export function targetSummaryFrom(target: ImprovementTarget): ExperimentTargetSummary {
  return {
    targetId: target.id,
    capability: target.capability,
    desiredOutcome: target.desiredOutcome,
  };
}
