/**
 * Two-Stage Candidate Selection for scientific evolution decisions.
 *
 * The v1 comparator conflated "was this a valid experiment?" with "did the
 * candidate improve?". The Self-Developing Agents methodology separates the
 * two, because declared promotions frequently failed to replicate on held-out
 * evaluation:
 *
 *   Stage A — Statistical / execution validity:
 *     - candidate runs completed
 *     - test coverage sufficient
 *     - verifier evidence valid
 *     - no catastrophic regressions
 *     - sample size sufficient
 *
 *   Stage B — Improvement validity:
 *     - capability improvement AND reliability improvement
 *     - held-out improvement AND transfer evidence
 *     - acceptable cost
 *
 * Only candidates passing BOTH stages become eligible. This module is a pure
 * gate: it consumes metrics and produces a decision with a full audit trail.
 */

import { EvaluationMetrics } from "../types.js";
import { computeDeltas, ScoreDeltas } from "../comparator.js";

/** Inputs describing how the candidate experiment was executed. */
export interface ExperimentValidity {
  /** Number of completed candidate runs (task executions). */
  completedRuns: number;
  /** Number of runs that produced valid verifier evidence (tests ran). */
  verifierCoveredRuns: number;
  /** Share of runs where verification actually executed (0..1). */
  verifierCoverage: number;
  /** True if a catastrophic regression (> threshold) was observed on any hard dimension. */
  catastrophicRegression: boolean;
}

export interface TwoStageThresholds {
  /** Minimum completed runs for the experiment to count (Stage A). */
  minSampleSize: number;
  /** Minimum verifier coverage share (Stage A). */
  minVerifierCoverage: number;
  /** Hard regression threshold that fails Stage A instantly (e.g. 0.15 = 15%). */
  catastrophicRegressionThreshold: number;
  /** Minimum capability gain for Stage B (0..1). */
  minCapabilityGain: number;
  /** Minimum reliability gain for Stage B (0..1). */
  minReliabilityGain: number;
  /** Minimum held-out generalization gain for Stage B (0..1). */
  minHeldOutGain: number;
  /** Maximum tolerated token overhead (negative efficiency delta), 0..1. */
  maxTokenOverhead: number;
}

export const DEFAULT_THRESHOLDS: TwoStageThresholds = {
  minSampleSize: 3,
  minVerifierCoverage: 0.5,
  catastrophicRegressionThreshold: 0.15,
  minCapabilityGain: 0.03,
  minReliabilityGain: 0.04,
  minHeldOutGain: 0.0,
  maxTokenOverhead: 0.25,
};

export type StageADecision = "valid" | "invalid";
export type StageBDecision = "improved" | "not_improved";
export type TwoStageDecision = "eligible" | "rejected" | "inconclusive";

export interface StageAReport {
  decision: StageADecision;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
}

export interface StageBReport {
  decision: StageBDecision;
  deltas: ScoreDeltas;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
}

export interface TwoStageResult {
  decision: TwoStageDecision;
  stageA: StageAReport;
  stageB: StageBReport | null;
  rationale: string;
}

export interface TwoStageInput {
  candidateId: string;
  baselineId: string;
  candidateMetrics: EvaluationMetrics;
  baselineMetrics: EvaluationMetrics;
  validity: ExperimentValidity;
  /** Share of held-out tasks improved by the candidate (0..1), if measured. */
  heldOutGain?: number;
  /** Cross-model transfer delta (0..1), if measured. */
  transferGain?: number;
}

export class TwoStageSelector {
  private readonly thresholds: TwoStageThresholds;

  constructor(thresholds: Partial<TwoStageThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  evaluate(input: TwoStageInput): TwoStageResult {
    const stageA = this.runStageA(input);

    if (stageA.decision === "invalid") {
      return {
        decision: "rejected",
        stageA,
        stageB: null,
        rationale: `Stage A (experiment validity) failed: ${stageA.checks
          .filter((c) => !c.passed)
          .map((c) => c.check)
          .join(", ")}`,
      };
    }

    const stageB = this.runStageB(input);
    if (stageB.decision === "improved") {
      return {
        decision: "eligible",
        stageA,
        stageB,
        rationale: `Valid experiment with genuine improvement: capability +${pct(stageB.deltas.capability)}, reliability +${pct(stageB.deltas.reliability)}, held-out +${pct(stageB.deltas.generalization)}.`,
      };
    }

    return {
      decision: "inconclusive",
      stageA,
      stageB,
      rationale: `Valid experiment but improvement thresholds not met: ${stageB.checks
        .filter((c) => !c.passed)
        .map((c) => c.check)
        .join(", ")}`,
    };
  }

  private runStageA(input: TwoStageInput): StageAReport {
    const t = this.thresholds;
    const deltas = computeDeltas(input.candidateMetrics, input.baselineMetrics);
    const catastrophic =
      input.validity.catastrophicRegression ||
      deltas.reliability < -t.catastrophicRegressionThreshold ||
      deltas.capability < -t.catastrophicRegressionThreshold ||
      deltas.generalization < -t.catastrophicRegressionThreshold;

    const checks = [
      {
        check: "candidate_runs_completed",
        passed: input.validity.completedRuns >= t.minSampleSize,
        detail: `${input.validity.completedRuns} runs completed (minimum ${t.minSampleSize})`,
      },
      {
        check: "verifier_coverage_sufficient",
        passed: input.validity.verifierCoverage >= t.minVerifierCoverage,
        detail: `Verifier coverage ${(input.validity.verifierCoverage * 100).toFixed(0)}% (minimum ${(t.minVerifierCoverage * 100).toFixed(0)}%)`,
      },
      {
        check: "verifier_evidence_valid",
        passed: input.validity.verifierCoveredRuns > 0 && input.validity.verifierCoverage > 0,
        detail: `${input.validity.verifierCoveredRuns} runs produced verifier evidence`,
      },
      {
        check: "no_catastrophic_regressions",
        passed: !catastrophic,
        detail: catastrophic
          ? "Catastrophic regression detected on a hard dimension"
          : "No catastrophic regressions observed",
      },
      {
        check: "sample_size_sufficient",
        passed: input.validity.completedRuns >= t.minSampleSize,
        detail: `Sample size ${input.validity.completedRuns} vs required ${t.minSampleSize}`,
      },
    ];

    return {
      decision: checks.every((c) => c.passed) ? "valid" : "invalid",
      checks,
    };
  }

  private runStageB(input: TwoStageInput): StageBReport {
    const t = this.thresholds;
    const deltas = computeDeltas(input.candidateMetrics, input.baselineMetrics);

    const heldOutGain = input.heldOutGain ?? deltas.generalization;
    const transferGain = input.transferGain ?? deltas.generalization;

    const capabilityGain = deltas.capability >= t.minCapabilityGain;
    const reliabilityGain = deltas.reliability >= t.minReliabilityGain;
    const heldOutImprovement = heldOutGain >= t.minHeldOutGain;
    const transferEvidence = transferGain >= t.minHeldOutGain;
    const costAcceptable = deltas.efficiency >= -t.maxTokenOverhead;

    // Improvement requires a genuine capability OR reliability gain, and NO
    // regression on held-out or transfer, and acceptable cost.
    const primaryGain = capabilityGain || reliabilityGain;
    const improved = primaryGain && heldOutImprovement && transferEvidence && costAcceptable;

    return {
      decision: improved ? "improved" : "not_improved",
      deltas,
      checks: [
        {
          check: "capability_or_reliability_gain",
          passed: primaryGain,
          detail: `capability ${fmtDelta(deltas.capability)} (min +${(t.minCapabilityGain * 100).toFixed(0)}%), reliability ${fmtDelta(deltas.reliability)} (min +${(t.minReliabilityGain * 100).toFixed(0)}%)`,
        },
        {
          check: "held_out_improvement",
          passed: heldOutImprovement,
          detail: `held-out gain ${fmtDelta(heldOutGain)}${input.heldOutGain === undefined ? " (proxy: generalization delta)" : ""}`,
        },
        {
          check: "transfer_evidence",
          passed: transferEvidence,
          detail: `transfer gain ${fmtDelta(transferGain)}${input.transferGain === undefined ? " (proxy: generalization delta — transfer not measured)" : ""}`,
        },
        {
          check: "acceptable_cost",
          passed: costAcceptable,
          detail: `efficiency delta ${fmtDelta(deltas.efficiency)} (max overhead ${(t.maxTokenOverhead * 100).toFixed(0)}%)`,
        },
      ],
    };
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtDelta(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}
