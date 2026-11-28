/**
 * MAC v1 P7 — the deterministic evaluation runner (SPEC §15, issue #85 PR 7.1).
 *
 * Runs every case in the suite, aggregates the subject counts, computes the
 * metrics, records labeled outcomes (idempotently), and applies the held-out
 * split: held-out cases RUN and are REPORTED but never enter the aggregates a
 * gate could read (TEST-STRATEGY §5.3 — evaluation data never leaks into
 * promotion decisions).
 *
 * Deterministic: no model, no network, no docker. The same suite always
 * produces the same metrics (modulo timestamps and generated ids).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldOutSplitDigest, isHeldOutCase } from "../../evolution/heldout-split.js";
import { buildMultiAgentCases, MULTI_AGENT_DATASET_VERSION } from "./cases.js";
import { calibrationStatus, subjectMetrics } from "./metrics.js";
import { LabeledOutcomeStore, LABELED_OUTCOMES_FILENAME } from "./labeled-outcomes.js";
import {
  EMPTY_COUNTS,
  MULTI_AGENT_SUBJECTS,
  type CaseOutcome,
  type CountsDelta,
  type LabeledOutcome,
  type MultiAgentCase,
  type MultiAgentEvalReport,
  type SubjectCounts,
  type SubjectReport,
} from "./types.js";

export interface RunMultiAgentEvalOptions {
  /** Directory for the labeled-outcome store (defaults to a temp dir: no persistence). */
  outDir?: string;
  /** ISO timestamp override (tests). */
  now?: string;
  /** Case list override (tests). */
  cases?: MultiAgentCase[];
}

export interface MultiAgentEvalResult {
  report: MultiAgentEvalReport;
  /** Per-case outcomes, suite order (audit trail). */
  caseResults: CaseOutcome[];
  /** Labeled outcomes recorded this run (already persisted to the store). */
  labelsRecorded: LabeledOutcome[];
  /** True when every development-set case passed (the PR 7.2 gate input). */
  allDevelopmentCasesPassed: boolean;
}

/** Merge one case's count deltas into the running subject totals. */
function mergeCounts(into: SubjectCounts, delta: CountsDelta): void {
  for (const subject of MULTI_AGENT_SUBJECTS) {
    const subjectDelta = delta[subject];
    if (!subjectDelta) continue;
    Object.assign(into[subject], subjectDelta);
  }
}

/**
 * Run the deterministic multi-agent evaluation suite. Held-out cases run and
 * report but do not contribute to the aggregated counts (split by the
 * evolution plane's hash-based `heldout-split-v1`).
 */
export async function runMultiAgentEvaluation(opts: RunMultiAgentEvalOptions = {}): Promise<MultiAgentEvalResult> {
  const cases = opts.cases ?? buildMultiAgentCases();
  const now = opts.now ?? new Date().toISOString();
  // No out dir: an ephemeral temp store (labels are returned, not persisted).
  const ephemeral = opts.outDir === undefined ? mkdtempSync(join(tmpdir(), "nexum-ma-eval-")) : null;
  const store = new LabeledOutcomeStore(join(opts.outDir ?? ephemeral ?? tmpdir(), LABELED_OUTCOMES_FILENAME));
  try {
    return await evaluate(cases, store, now);
  } finally {
    if (ephemeral !== null) rmSync(ephemeral, { recursive: true, force: true });
  }
}

async function evaluate(
  cases: MultiAgentCase[],
  store: LabeledOutcomeStore,
  now: string,
): Promise<MultiAgentEvalResult> {
  const counts: SubjectCounts = structuredClone(EMPTY_COUNTS);
  const caseResults: CaseOutcome[] = [];
  const heldOutIds: string[] = [];
  const developmentIds: string[] = [];

  for (const testCase of cases) {
    const result = await testCase.run();
    caseResults.push(result);
    if (isHeldOutCase(testCase.id)) {
      heldOutIds.push(testCase.id);
      continue; // reported, never aggregated into a gate-readable metric
    }
    developmentIds.push(testCase.id);
    mergeCounts(counts, result.counts);
  }

  const labels = caseResults.flatMap((r) => r.labels);
  store.appendAll(labels);

  const subjects: SubjectReport[] = MULTI_AGENT_SUBJECTS.map((subject) => {
    const subjectCases = caseResults.filter((r) => r.subject === subject);
    const developmentCases = subjectCases.filter((r) => !heldOutIds.includes(r.caseId));
    return {
      subject,
      casesTotal: subjectCases.length,
      casesPassed: developmentCases.filter((r) => r.pass).length,
      metrics: subjectMetrics(subject, counts),
      heldOutCases: subjectCases.length - developmentCases.length,
    };
  });

  const allLabels = store.load();
  const calibration = MULTI_AGENT_SUBJECTS.map((subject) => calibrationStatus(subject, allLabels));

  const report: MultiAgentEvalReport = {
    datasetVersion: MULTI_AGENT_DATASET_VERSION,
    generatedAt: now,
    heldOutSplitDigest: heldOutSplitDigest(cases.map((c) => c.id)),
    subjects,
    counters: missionCounters(counts, caseResults, heldOutIds.length),
    calibration,
    totalCases: caseResults.length,
    totalPassed: caseResults.filter((r) => !heldOutIds.includes(r.caseId) && r.pass).length,
  };

  return {
    report,
    caseResults,
    labelsRecorded: labels,
    allDevelopmentCasesPassed: developmentIds.every((id) => caseResults.find((r) => r.caseId === id)?.pass === true),
  };
}

/**
 * mission_* telemetry counters — the P8 pilot dashboard criteria read these
 * (issue #85: "false-success counter wired into the pilot dashboard criteria").
 */
function missionCounters(counts: SubjectCounts, caseResults: CaseOutcome[], heldOut: number): Record<string, number> {
  return {
    mission_eval_cases_total: caseResults.length,
    mission_eval_cases_passed: caseResults.filter((r) => r.pass).length,
    mission_eval_heldout_cases: heldOut,
    mission_false_success_total: counts.mission.falseSuccesses,
    mission_verified_completions_total: counts.mission.verifiedCompletions,
    mission_claims_refused_without_evidence_total: counts.mission.claimsRefusedWithoutEvidence,
    mission_budget_exhausted_total: counts.runtime.budgetTerminationsClean,
    mission_budget_adherence_total: counts.runtime.missionsWithBudget,
    mission_cancellations_total: counts.runtime.cancellationsTotal,
    mission_successful_escalations_total: counts.runtime.successfulEscalations,
    mission_tracker_fabricated_changes_total: counts.tracker.changesFabricated,
    mission_tracker_collector_failures_total: counts.tracker.collectorFailures,
    mission_predictor_abstentions_total: counts.predictor.abstentionsCorrect,
    mission_predictor_uncalibrated_probabilities_total: counts.predictor.uncalibratedProbabilities,
    mission_commander_invalid_dag_rejected_total: counts.commander.invalidDagRejected,
    mission_commander_recoveries_total: counts.commander.recoveriesSucceeded,
  };
}
