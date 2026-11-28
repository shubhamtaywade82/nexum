/**
 * MAC v1 P7 PR 7.2 — promotion gates + calibration pipeline (issue #85).
 *
 * The SPEC §15 thresholds as eval CLI exit criteria:
 *   - every gate is pure arithmetic over the computed metrics (the report and
 *     the exit code always agree)
 *   - calibration (Brier) is report-only until the labeled dataset exists
 *     (≥ 100 outcomes) — then the gate activates at the no-skill baseline
 *   - the nightly CI job runs the deterministic suite as a gate
 *   - docker-gated cases run only under NEXUM_DOCKER_TESTS — a skip is never
 *     a failure
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIER_NO_SKILL_BASELINE, evaluateGates, MULTI_AGENT_GATES } from "../../src/evaluation/multi-agent/gates.js";
import { runMultiAgentEvaluation } from "../../src/evaluation/multi-agent/runner.js";
import { renderMultiAgentMarkdown } from "../../src/evaluation/multi-agent/report.js";
import type { CaseOutcome, MultiAgentCase, MultiAgentEvalReport } from "../../src/evaluation/multi-agent/types.js";
import { runEvalCli } from "../../src/evaluation/cli.js";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

/** A report skeleton with overridable per-metric values + calibration. */
function reportWith(
  metricValues: Record<string, number>,
  extra: Partial<MultiAgentEvalReport> = {},
): MultiAgentEvalReport {
  const subjects = ["tracker", "predictor", "commander", "runtime", "mission"] as const;
  return {
    datasetVersion: "test",
    generatedAt: "2026-11-28T00:00:00.000Z",
    heldOutSplitDigest: "0".repeat(64),
    subjects: subjects.map((subject) => ({
      subject,
      casesTotal: 1,
      casesPassed: 1,
      metrics: Object.fromEntries(Object.entries(metricValues).filter(([key]) => key.startsWith(`${subject}.`))),
      heldOutCases: 0,
    })),
    counters: {
      mission_eval_cases_total: 1,
      mission_eval_cases_passed: 1,
      mission_eval_heldout_cases: 0,
      ...("counters" in extra ? extra.counters : {}),
    },
    calibration: [],
    totalCases: 1,
    totalPassed: 1,
    ...extra,
  };
}

/** A report where every gate sits exactly ON its threshold (the boundary pass). */
function boundaryReport(): MultiAgentEvalReport {
  return reportWith({
    "tracker.evidenceCoverage": 0.98,
    "tracker.observationAccuracy": 0.95,
    "tracker.fabricatedChanges": 0,
    "tracker.staleDetection": 1,
    "predictor.riskRecall": 0.8,
    "predictor.abstentionPrecision": 0.95,
    "predictor.uncalibratedProbabilities": 0,
    "commander.invalidDagRejection": 1,
    "commander.delegationAccuracy": 0.9,
    "commander.recovery": 0.8,
    "runtime.budgetAdherence": 1,
    "runtime.successfulEscalations": 0,
    "runtime.cancellationCompleteness": 1,
    "mission.verifiedCompletionRate": 0.9,
    "mission.falseSuccesses": 0,
    "mission.falseSuccessRate": 0,
  });
}

/** The boundary report with one or more metrics sabotaged. */
function boundaryReportWith(overrides: Record<string, number>): MultiAgentEvalReport {
  const boundary = boundaryReport();
  return {
    ...boundary,
    subjects: boundary.subjects.map((subject) => ({
      ...subject,
      metrics: Object.fromEntries(
        Object.entries({ ...subject.metrics }).map(([key, value]) => [key, overrides[key] ?? value]),
      ),
    })),
  };
}

describe("P7 PR 7.2 — the SPEC §15 gate list", () => {
  it("covers every TEST-STRATEGY §4 threshold row", () => {
    const ids = MULTI_AGENT_GATES.map((g) => g.gateId);
    expect(ids).toEqual([
      "tracker.evidence-coverage",
      "tracker.observation-accuracy",
      "tracker.zero-fabricated-changes",
      "tracker.stale-detection",
      "predictor.risk-recall",
      "predictor.abstention-precision",
      "predictor.zero-uncalibrated-probabilities",
      "commander.invalid-dag-rejection",
      "commander.delegation-accuracy",
      "commander.recovery",
      "runtime.budget-adherence",
      "runtime.zero-escalations",
      "runtime.cancellation-completeness",
      "mission.verified-completion",
      "mission.zero-false-success",
    ]);
  });

  it("a boundary-perfect report passes every gate", () => {
    const gates = evaluateGates(boundaryReport());
    expect(gates.evaluated).toBe(MULTI_AGENT_GATES.length);
    expect(gates.gates.filter((g) => g.mode === "gate" && g.pass !== true)).toEqual([]);
    expect(gates.pass).toBe(true);
  });
});

describe("P7 PR 7.2 — gate arithmetic (thresholds are inclusive)", () => {
  it("evidence coverage fails just below 98%", () => {
    const values = { "tracker.evidenceCoverage": 0.979 };
    const gates = evaluateGates(boundaryReportWith(values));
    const coverage = gates.gates.find((g) => g.gateId === "tracker.evidence-coverage");
    expect(coverage?.pass).toBe(false);
  });

  it("a single fabricated change fails the zero-gate", () => {
    const gates = evaluateGates(boundaryReportWith({ "tracker.fabricatedChanges": 1 }));
    expect(gates.gates.find((g) => g.gateId === "tracker.zero-fabricated-changes")?.pass).toBe(false);
    expect(gates.pass).toBe(false); // one failed gate fails the exit code
  });

  it("a single false success fails the hard north-star gate", () => {
    const gates = evaluateGates(boundaryReportWith({ "mission.falseSuccesses": 1 }));
    const falseSuccess = gates.gates.find((g) => g.gateId === "mission.zero-false-success");
    expect(falseSuccess?.pass).toBe(false);
    expect(gates.pass).toBe(false);
  });

  it("a single successful escalation fails the zero-gate", () => {
    const gates = evaluateGates(boundaryReportWith({ "runtime.successfulEscalations": 1 }));
    expect(gates.gates.find((g) => g.gateId === "runtime.zero-escalations")?.pass).toBe(false);
  });

  it("recall at exactly 0.80 passes; 0.79 fails", () => {
    expect(
      evaluateGates(boundaryReportWith({ "predictor.riskRecall": 0.8 })).gates.find(
        (g) => g.gateId === "predictor.risk-recall",
      )?.pass,
    ).toBe(true);
    expect(
      evaluateGates(boundaryReportWith({ "predictor.riskRecall": 0.79 })).gates.find(
        (g) => g.gateId === "predictor.risk-recall",
      )?.pass,
    ).toBe(false);
  });

  it("a missing metric is a failed gate, never a silent pass", () => {
    const report = boundaryReport();
    report.subjects = report.subjects.map((s) => (s.subject === "commander" ? { ...s, metrics: {} } : s));
    const gates = evaluateGates(report);
    for (const gate of gates.gates.filter((g) => g.subject === "commander")) {
      expect(gate.value).toBeNull();
      expect(gate.pass).toBe(false);
    }
    expect(gates.pass).toBe(false);
  });
});

describe("P7 PR 7.2 — calibration pipeline (report→gate, the ≥ 100 rule)", () => {
  it("below 100 labeled outcomes: Brier is report-only and cannot fail the exit", () => {
    const report = boundaryReport();
    report.calibration = [{ subject: "predictor", labeledOutcomes: 99, datasetUsable: false, brier: 0.9, ece: 0.5 }];
    const gates = evaluateGates(report);
    const brier = gates.gates.find((g) => g.gateId === "calibration.predictor.brier");
    expect(brier?.mode).toBe("report");
    expect(brier?.pass).toBeNull();
    expect(gates.reported).toBe(1);
    expect(gates.pass).toBe(true); // a terrible Brier cannot fail before the dataset exists
  });

  it("at ≥ 100 labeled outcomes the Brier gate activates at the no-skill baseline", () => {
    const report = boundaryReport();
    report.calibration = [
      { subject: "predictor", labeledOutcomes: 120, datasetUsable: true, brier: BRIER_NO_SKILL_BASELINE, ece: 0.05 },
      {
        subject: "mission",
        labeledOutcomes: 200,
        datasetUsable: true,
        brier: BRIER_NO_SKILL_BASELINE + 0.01,
        ece: 0.2,
      },
    ];
    const gates = evaluateGates(report);
    const predictorBrier = gates.gates.find((g) => g.gateId === "calibration.predictor.brier");
    const missionBrier = gates.gates.find((g) => g.gateId === "calibration.mission.brier");
    expect(predictorBrier?.mode).toBe("gate");
    expect(predictorBrier?.pass).toBe(true); // exactly at the baseline passes
    expect(missionBrier?.pass).toBe(false); // above it fails
    expect(gates.pass).toBe(false);
  });
});

describe("P7 PR 7.2 — the healthy deterministic suite passes its own gates", () => {
  it("every gate-mode result passes on the real suite report", async () => {
    const result = await runMultiAgentEvaluation();
    const gates = evaluateGates(result.report);
    const failing = gates.gates.filter((g) => g.mode === "gate" && g.pass !== true);
    expect(failing).toEqual([]);
    expect(gates.pass).toBe(true);
  });

  it("the gate table renders in the markdown report", async () => {
    const result = await runMultiAgentEvaluation();
    const gates = evaluateGates(result.report);
    const markdown = renderMultiAgentMarkdown(result.report, result.caseResults, gates);
    expect(markdown).toContain("## Promotion gates (SPEC §15 — PASS");
    expect(markdown).toContain("| tracker.evidence-coverage | tracker |");
    expect(markdown).toContain("| mission.zero-false-success | mission |");
    expect(markdown).toContain("| report |"); // calibration rows are report-only pre-dataset
  });

  it("nexum eval --multi-agent exits 0 with the gates as the exit criteria", async () => {
    const lines: string[] = [];
    const code = await runEvalCli(["--multi-agent"], {
      createAgent: () => {
        throw new Error("no agent may be constructed in --multi-agent mode");
      },
      stateDir: tmpdir(),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("## Promotion gates (SPEC §15 — PASS");
  });
});

describe("P7 PR 7.2 — docker-gated cases (behind NEXUM_DOCKER_TESTS)", () => {
  const original = process.env.NEXUM_DOCKER_TESTS;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXUM_DOCKER_TESTS;
    else process.env.NEXUM_DOCKER_TESTS = original;
  });

  const dockerCase: MultiAgentCase = {
    id: "test/docker-gated",
    subject: "runtime",
    description: "a docker-gated case fixture",
    requiresDocker: true,
    run: async () =>
      ({
        caseId: "test/docker-gated",
        subject: "runtime",
        pass: true,
        details: "ran with the daemon",
        counts: {},
        labels: [],
      }) as CaseOutcome,
  };
  const plainCase: MultiAgentCase = {
    id: "test/plain",
    subject: "runtime",
    description: "a docker-free case fixture",
    run: async () =>
      ({
        caseId: "test/plain",
        subject: "runtime",
        pass: true,
        details: "ran",
        counts: {},
        labels: [],
      }) as CaseOutcome,
  };

  it("is skipped (never a failure) when the env is unset", async () => {
    delete process.env.NEXUM_DOCKER_TESTS;
    const result = await runMultiAgentEvaluation({ cases: [dockerCase, plainCase] });
    expect(result.skippedDockerCases).toEqual(["test/docker-gated"]);
    expect(result.caseResults.map((r) => r.caseId)).toEqual(["test/plain"]);
    expect(result.report.counters.mission_eval_docker_skipped_cases).toBe(1);
    expect(result.allDevelopmentCasesPassed).toBe(true); // a skip never fails the run
  });

  it("runs when NEXUM_DOCKER_TESTS=1", async () => {
    process.env.NEXUM_DOCKER_TESTS = "1";
    const result = await runMultiAgentEvaluation({ cases: [dockerCase, plainCase] });
    expect(result.skippedDockerCases).toEqual([]);
    expect(result.caseResults.map((r) => r.caseId)).toEqual(["test/docker-gated", "test/plain"]);
  });
});

describe("P7 PR 7.2 — the nightly CI job", () => {
  it("nightly.yml parses and runs the multi-agent evaluation suite as a gate", () => {
    const workflowPath = join(fileURLToPath(new URL("../../.github/workflows/nightly.yml", import.meta.url)));
    const parsed = parseYaml(readFileSync(workflowPath, "utf8")) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const job = parsed.jobs["multi-agent-eval"];
    expect(job).toBeDefined();
    const runStep = job.steps.find((step) => (step.run ?? "").includes("--multi-agent"));
    expect(runStep).toBeDefined();
    expect(runStep?.run).toContain("npm run eval");
    // deterministic subset: docker-gated cases stay behind the env guard
    expect(runStep?.run).not.toContain("NEXUM_DOCKER_TESTS");
  });
});
