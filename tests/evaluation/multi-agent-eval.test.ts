/**
 * MAC v1 P7 PR 7.1 — the deterministic multi-agent evaluation suite
 * (SPEC §15, TEST-STRATEGY §4–§6; issue #85).
 *
 * The suite under test is itself the deliverable: these tests assert the
 * acceptance criteria —
 *   - the deterministic suite is green without network and without models
 *   - the metric math is auditable (hand-computed expectations)
 *   - the labeled-outcome dataset schema + retention rules (≥ 100) hold, and
 *     re-runs never inflate it (idempotent labels)
 *   - the held-out split keeps evaluation data out of promotion decisions
 *   - the false-success counter exists and is wired into the mission_*
 *     telemetry (the P8 pilot dashboard criteria)
 *   - SPEC §6 rule 2 replay: a mission audit is reconstructible from the
 *     event chain + checkpoint on disk alone — no LLM, no coordinator
 */

import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMultiAgentCases, MULTI_AGENT_DATASET_VERSION } from "../../src/evaluation/multi-agent/cases.js";
import {
  brierScore,
  calibrationStatus,
  commanderMetrics,
  expectedCalibrationError,
  MIN_LABELED_OUTCOMES,
  missionMetrics,
  predictorMetrics,
  runtimeMetrics,
  subjectMetrics,
  trackerMetrics,
} from "../../src/evaluation/multi-agent/metrics.js";
import { runMultiAgentEvaluation } from "../../src/evaluation/multi-agent/runner.js";
import { renderMultiAgentMarkdown } from "../../src/evaluation/multi-agent/report.js";
import { LabeledOutcomeStore, LABELED_OUTCOMES_FILENAME } from "../../src/evaluation/multi-agent/labeled-outcomes.js";
import { EMPTY_COUNTS, type LabeledOutcome } from "../../src/evaluation/multi-agent/types.js";
import { isHeldOutCase, heldOutSplitDigest } from "../../src/evolution/heldout-split.js";
import { runEvalCli } from "../../src/evaluation/cli.js";

// ── The deterministic suite (the acceptance test itself) ─────────────────────

describe("P7 PR 7.1 — the deterministic multi-agent evaluation suite", () => {
  it("is green in CI without network and without models", async () => {
    const result = await runMultiAgentEvaluation();
    expect(result.allDevelopmentCasesPassed).toBe(true);
    expect(result.report.totalCases).toBeGreaterThanOrEqual(16);
    // every subject is covered by at least one case
    for (const subject of result.report.subjects) {
      expect(subject.casesTotal).toBeGreaterThan(0);
    }
    // no case failed at all (held-out included — they still must run green)
    expect(result.caseResults.filter((r) => !r.pass)).toEqual([]);
  });

  it("is deterministic: two runs compute identical metrics", async () => {
    const first = await runMultiAgentEvaluation();
    const second = await runMultiAgentEvaluation();
    expect(second.report.subjects.map((s) => s.metrics)).toEqual(first.report.subjects.map((s) => s.metrics));
    expect(second.report.counters).toEqual(first.report.counters);
    expect(second.report.heldOutSplitDigest).toBe(first.report.heldOutSplitDigest);
  });

  it("records the dataset version and the held-out split digest", async () => {
    const result = await runMultiAgentEvaluation();
    expect(result.report.datasetVersion).toBe(MULTI_AGENT_DATASET_VERSION);
    const cases = buildMultiAgentCases();
    expect(result.report.heldOutSplitDigest).toBe(heldOutSplitDigest(cases.map((c) => c.id)));
    // held-out cases: reported, never aggregated into gate-readable metrics
    const heldOut = cases.filter((c) => isHeldOutCase(c.id));
    expect(result.report.counters.mission_eval_heldout_cases).toBe(heldOut.length);
    expect(heldOut.length).toBeGreaterThan(0); // the split is real, not vacuous
  });

  it("emits mission_* telemetry with the false-success counter wired (the P8 dashboard criteria)", async () => {
    const result = await runMultiAgentEvaluation();
    const counters = result.report.counters;
    expect(counters.mission_eval_cases_total).toBe(result.report.totalCases);
    expect(counters.mission_eval_cases_passed).toBe(result.caseResults.filter((r) => r.pass).length);
    // the north-star safety metric: zero false successes in the deterministic suite
    expect(counters.mission_false_success_total).toBe(0);
    expect(counters.mission_verified_completions_total).toBeGreaterThan(0);
    expect(counters.mission_claims_refused_without_evidence_total).toBeGreaterThan(0);
    expect(counters.mission_predictor_uncalibrated_probabilities_total).toBe(0);
    expect(counters.mission_tracker_fabricated_changes_total).toBe(0);
    expect(counters.mission_successful_escalations_total).toBe(0);
  });

  it("renders the markdown report with subjects, calibration, counters, and the case trail", async () => {
    const result = await runMultiAgentEvaluation();
    const markdown = renderMultiAgentMarkdown(result.report, result.caseResults);
    expect(markdown).toContain("# Multi-agent evaluation");
    expect(markdown).toContain("## Subjects");
    expect(markdown).toContain("## Calibration (labeled outcomes — the ≥ 100 rule)");
    expect(markdown).toContain("## Telemetry counters (mission_*)");
    expect(markdown).toContain("mission_false_success_total");
    expect(markdown).toContain("## Case audit trail");
    for (const subject of result.report.subjects) {
      expect(markdown).toContain(`| ${subject.subject} |`);
    }
  });
});

// ── Metric math (auditable arithmetic) ───────────────────────────────────────

describe("P7 PR 7.1 — metric math", () => {
  it("tracker metrics: coverage, accuracy, fabrication, blocker honesty, staleness", () => {
    const metrics = trackerMetrics({
      ...EMPTY_COUNTS.tracker,
      observationsTotal: 50,
      observationsResolvable: 49, // 0.98 — exactly the gate
      changesExpected: 10,
      changesDetectedCorrect: 10,
      changesFabricated: 0,
      cleanFixtures: 2,
      cleanFixturesCorrect: 2, // accuracy 12/12
      collectorFailures: 3,
      collectorFailuresAsBlockers: 3,
      staleExpired: 4,
      staleDetected: 4,
    });
    expect(metrics["tracker.evidenceCoverage"]).toBe(0.98);
    expect(metrics["tracker.observationAccuracy"]).toBe(1);
    expect(metrics["tracker.fabricatedChanges"]).toBe(0);
    expect(metrics["tracker.blockerHonesty"]).toBe(1);
    expect(metrics["tracker.staleDetection"]).toBe(1);
  });

  it("empty denominators are vacuously satisfied (1), never NaN", () => {
    const metrics = trackerMetrics(EMPTY_COUNTS.tracker);
    for (const value of Object.values(metrics)) expect(Number.isFinite(value)).toBe(true);
    expect(metrics["tracker.evidenceCoverage"]).toBe(1);
  });

  it("predictor metrics: recall, abstention precision, uncalibrated fields", () => {
    const metrics = predictorMetrics({
      ...EMPTY_COUNTS.predictor,
      risksReal: 10,
      risksKept: 9,
      risksFabricatedKept: 1, // precision 9/10
      abstentionsRequired: 8,
      abstentionsCorrect: 8,
      falseAbstentions: 0,
      missedAbstentions: 0,
      uncalibratedProbabilities: 0,
    });
    expect(metrics["predictor.riskRecall"]).toBeCloseTo(0.9);
    expect(metrics["predictor.riskPrecision"]).toBeCloseTo(0.9);
    expect(metrics["predictor.abstentionPrecision"]).toBe(1);
    expect(metrics["predictor.uncalibratedProbabilities"]).toBe(0);
  });

  it("commander metrics: invalid-DAG rejection, delegation accuracy, recovery", () => {
    const metrics = commanderMetrics({
      ...EMPTY_COUNTS.commander,
      invalidDagSeeded: 5,
      invalidDagRejected: 5,
      validDecisionsSeeded: 4,
      validDecisionsAccepted: 4,
      forgedDecisionsSeeded: 3,
      forgedDecisionsRejected: 3,
      delegationsAccurate: 4,
      delegationsTotal: 4,
      recoveriesAttempted: 5,
      recoveriesSucceeded: 4, // 0.8 — exactly the gate
    });
    expect(metrics["commander.invalidDagRejection"]).toBe(1);
    expect(metrics["commander.delegationAccuracy"]).toBe(1);
    expect(metrics["commander.recovery"]).toBe(0.8);
  });

  it("runtime + mission metrics: adherence, escalation, false success", () => {
    const runtime = runtimeMetrics({
      ...EMPTY_COUNTS.runtime,
      missionsWithBudget: 3,
      budgetTerminationsClean: 3,
      cancellationsTotal: 2,
      cancellationsClean: 2,
      escalationAttempts: 1,
      successfulEscalations: 0,
    });
    expect(runtime["runtime.budgetAdherence"]).toBe(1);
    expect(runtime["runtime.cancellationCompleteness"]).toBe(1);
    expect(runtime["runtime.successfulEscalations"]).toBe(0);

    const mission = missionMetrics({
      ...EMPTY_COUNTS.mission,
      missionsCompleted: 2,
      verifiedCompletions: 2,
      falseSuccesses: 0,
      claimsRefusedWithoutEvidence: 1,
    });
    expect(mission["mission.verifiedCompletionRate"]).toBe(1);
    expect(mission["mission.falseSuccesses"]).toBe(0);
    expect(mission["mission.falseSuccessRate"]).toBe(0);
  });

  it("subjectMetrics dispatches per subject", () => {
    expect(Object.keys(subjectMetrics("tracker", EMPTY_COUNTS))).toContain("tracker.evidenceCoverage");
    expect(Object.keys(subjectMetrics("mission", EMPTY_COUNTS))).toContain("mission.falseSuccessRate");
  });
});

// ── Calibration math (earned, not asserted) ──────────────────────────────────

describe("P7 PR 7.1 — calibration math (the ≥ 100 rule)", () => {
  const label = (predicted: number, actual: number, id: string): LabeledOutcome => ({
    labelId: `predictor:case:${id}`,
    subject: "predictor",
    caseId: "case",
    predicted,
    actual,
    evidenceRefs: ["artifact:ma_x"],
    recordedAt: "2026-11-28T00:00:00.000Z",
  });

  it("Brier/ECE are null below the minimum sample size", () => {
    const few = Array.from({ length: MIN_LABELED_OUTCOMES - 1 }, (_, i) => label(0.5, i % 2, String(i)));
    expect(brierScore(few)).toBeNull();
    expect(expectedCalibrationError(few)).toBeNull();
    const status = calibrationStatus("predictor", few);
    expect(status.datasetUsable).toBe(false);
    expect(status.labeledOutcomes).toBe(MIN_LABELED_OUTCOMES - 1);
  });

  it("Brier is the mean squared error at ≥ 100 labels", () => {
    // 100 perfect predictions of 1.0 on actual 1 → Brier 0
    const perfect = Array.from({ length: 100 }, (_, i) => label(1, 1, `p${i}`));
    expect(brierScore(perfect)).toBe(0);
    // 100 predictions of 0.5 on actual 0 → Brier 0.25
    const half = Array.from({ length: 100 }, (_, i) => label(0.5, 0, `h${i}`));
    expect(brierScore(half)).toBe(0.25);
    // mixed count does not cross the boundary
    expect(calibrationStatus("predictor", perfect).datasetUsable).toBe(true);
  });

  it("ECE is 0 for a perfectly calibrated set", () => {
    // two bins: 50×(p=0.0, a=0) and 50×(p=1.0, a=1)
    const calibrated = [
      ...Array.from({ length: 50 }, (_, i) => label(0, 0, `z${i}`)),
      ...Array.from({ length: 50 }, (_, i) => label(1, 1, `o${i}`)),
    ];
    expect(expectedCalibrationError(calibrated)).toBe(0);
  });
});

// ── Labeled-outcome store (schema + retention, SPEC §6 rule 3) ───────────────

describe("P7 PR 7.1 — labeled-outcome store", () => {
  function tempStore(label: string): { store: LabeledOutcomeStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), `nexum-ma-labels-${label}-`));
    return { store: new LabeledOutcomeStore(join(dir, LABELED_OUTCOMES_FILENAME)), dir };
  }

  const record = (id: string, subject: LabeledOutcome["subject"] = "predictor"): LabeledOutcome => ({
    labelId: `${subject}:case:${id}`,
    subject,
    caseId: "case",
    predicted: 0.6,
    actual: true,
    evidenceRefs: ["artifact:ma_1"],
    recordedAt: "2026-11-28T00:00:00.000Z",
  });

  it("appends and reloads records across store instances", () => {
    const { store, dir } = tempStore("persist");
    try {
      store.append(record("1"));
      store.append(record("2", "commander"));
      const reopened = new LabeledOutcomeStore(join(dir, LABELED_OUTCOMES_FILENAME));
      expect(reopened.load().length).toBe(2);
      expect(reopened.forSubject("commander").length).toBe(1);
      expect(reopened.datasetUsable("predictor")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent per labelId: re-runs never inflate the dataset", () => {
    const { store, dir } = tempStore("idempotent");
    try {
      const first = store.append(record("1"));
      const second = store.append(record("1")); // deterministic re-run
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(store.load().length).toBe(1);
      expect(store.appendAll([record("1"), record("2")])).toBe(1);
      expect(store.load().length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the ≥ 100 rule flips usability only through accumulation", () => {
    const { store, dir } = tempStore("hundred");
    try {
      for (let i = 0; i < MIN_LABELED_OUTCOMES - 1; i += 1) store.append(record(String(i)));
      expect(store.datasetUsable("predictor")).toBe(false);
      store.append(record("final"));
      expect(store.datasetUsable("predictor")).toBe(true);
      const retention = store.retentionGuarantee();
      expect(retention.predictor).toBe(MIN_LABELED_OUTCOMES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the runner persists labels under the out dir (a real file with the retention rule)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-ma-eval-out-"));
    try {
      await runMultiAgentEvaluation({ outDir: dir });
      const raw = readFileSync(join(dir, LABELED_OUTCOMES_FILENAME), "utf8").trim();
      expect(raw.length).toBeGreaterThan(0);
      for (const line of raw.split("\n")) {
        const parsed = JSON.parse(line) as LabeledOutcome;
        expect(parsed.labelId).toMatch(/^[a-z]+:.+:.+$/); // subject:case:slot
        expect(typeof parsed.predicted).toBeDefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── SPEC §6 rule 2 replay: audit from the event chain + artifacts alone ────

describe("P7 — mission audit replay (SPEC §6 rule 2, no LLM, no coordinator)", () => {
  it("reconstructs a mission audit from events.jsonl + checkpoint.json on disk alone", async () => {
    const { MissionCoordinator, MissionJournal, reconstructMissionAudit } =
      await import("../../src/orchestration/mission/mission-coordinator.js");
    const { MissionCheckpointStore } = await import("../../src/orchestration/mission/mission-lifecycle.js");
    const { resolveMissionPolicy } = await import("../../src/orchestration/mission/mission-policy.js");

    const dir = mkdtempSync(join(tmpdir(), "nexum-ma-replay-"));
    try {
      const policy = resolveMissionPolicy({
        overrides: { budget: { maxChildren: 16 }, delegationPolicy: { maxTotalChildren: 16 } },
      });
      if (!policy.ok || !policy.policy) throw new Error("replay policy refused");
      let turn = 0;
      const decision = (partial: Record<string, unknown>) => ({
        decisionId: "cd_eval",
        missionId: "ms_ignored",
        action: "verify",
        rationale: "replay fixture decision",
        basedOnReports: ["tr_1", "pr_1"],
        evidenceRefs: ["artifact:ma_1"],
        schemaVersion: 1,
        ...partial,
      });
      const decisions = [
        decision({
          decisionId: "cd_d1",
          action: "delegate",
          taskIds: ["TASK-001"],
          delegation: { goal: "work", requiredCapabilities: ["code-edit"] },
        }),
        decision({ decisionId: "cd_v1", action: "verify", taskIds: ["TASK-001"] }),
        decision({ decisionId: "cd_c1", action: "complete" }),
      ];
      const coordinator = new MissionCoordinator({
        policy: policy.policy,
        roles: {
          observe: async () => ({
            report: { reportId: "tr_1", artifactId: "ma_1", health: "healthy", observationCount: 1, blockerCount: 0 },
            artifactPayload: {},
          }),
          assess: async () => ({ report: { reportId: "pr_1", artifactId: "ma_2", riskCount: 0 }, artifactPayload: {} }),
          decide: async () => decisions[Math.min(turn++, decisions.length - 1)],
        },
        workers: {
          review: () => ({ allowed: true, reason: "ok", childAgentId: "devagent" }),
          delegate: async () => ({ status: "completed" as const, output: "done" }),
        },
        verification: {
          verify: async () => [{ gate: "tests", passed: true, summary: "suite green", evidenceRefs: ["run:run_1"] }],
        },
        approvals: { resolve: async () => "approved" as const },
        missionsDir: dir,
        planSteps: [{ id: "TASK-001", description: "implement", status: "pending", dependencies: [], retryCount: 0 }],
      });
      const outcome = await coordinator.run({
        goal: "1. replay step one\n2. replay step two",
        successCriteria: [],
        constraints: [],
        submittedBy: "user",
      });
      expect(outcome.outcome).toBe("completed");

      // The replay: a FRESH journal + checkpoint loaded from disk only — no
      // coordinator instance, no LLM — reconstructs the audit (SPEC §6 rule 2).
      const freshJournal = new MissionJournal(join(dir, coordinator.missionId));
      const checkpoint = new MissionCheckpointStore(join(dir, coordinator.missionId)).load();
      const audit = reconstructMissionAudit(freshJournal, checkpoint);
      expect(audit.missionId).toBe(coordinator.missionId);
      expect(audit.outcome).toBe("completed");
      expect(audit.objective).toContain("replay step one");
      expect(audit.transitions.length).toBeGreaterThan(0);
      expect(audit.decisions.some((d) => d.decisionId === "cd_d1" && d.kind === "accepted")).toBe(true);
      expect(audit.degraded).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P7 PR 7.1 — nexum eval --multi-agent", () => {
  it("runs the deterministic suite and exits 0 when every development case passes", async () => {
    const lines: string[] = [];
    const code = await runEvalCli(["--multi-agent"], {
      // the multi-agent mode never constructs an agent (deterministic only) —
      // a throwing factory proves no model path is even touched
      createAgent: () => {
        throw new Error("no agent may be constructed in --multi-agent mode");
      },
      stateDir: tmpdir(),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("# Multi-agent evaluation");
    expect(lines.join("\n")).toContain("mission_false_success_total");
  });
});
