import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEngineWiring, buildPartialReport } from "../../../src/evolution/tasks/engine-wiring.js";
import { ClosedLoopEngine } from "../../../src/evolution/engine-v2.js";
import { loadCatalog } from "../../../src/evolution/tasks/task-loader.js";
import { TaskRegistry } from "../../../src/evolution/tasks/task-registry.js";
import { ReportStore } from "../../../src/evolution/reporting/report-store.js";
import { BacklogTracker } from "../../../src/evolution/tasks/backlog-tracker.js";
import { Episode } from "../../../src/learning/types.js";

/**
 * EVO-009-adjacent wiring: `evolve --task-run <id>` for diagnose tasks now
 * runs end-to-end through the closed-loop engine — episodes → observation →
 * 12-section report → report-store.db → backlog transition. These tests pin
 * that contract against the repository's own catalogue.
 */

function failureEpisode(id: string, goal: string, startedAt = 1000): Episode {
  return {
    id,
    goal,
    startedAt,
    endedAt: startedAt + 1000,
    terminal: "loop_abort",
    toolEvents: [
      { name: "read_file", args: {}, ok: true, durationMs: 50, at: startedAt + 1 },
      {
        name: "run_shell",
        args: {},
        ok: false,
        durationMs: 100,
        at: startedAt + 2,
        errorLabel: "Argument validation failed",
      },
      {
        name: "run_shell",
        args: {},
        ok: false,
        durationMs: 100,
        at: startedAt + 3,
        errorLabel: "Argument validation failed",
      },
    ],
    activatedSkillIds: [],
    finalAssistantText: "",
    grade: {
      verdict: "failure",
      score: 0.2,
      signals: {
        testsRan: true,
        testsPassed: false,
        toolErrorRate: 0.7,
        pathEscapes: 0,
        patchFailures: 0,
        loopAborted: true,
        turnCount: 5,
        retriedSameToolMax: 2,
      },
    },
  };
}

describe("task-catalogue engine wiring (--task-run)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "nexum-wiring-"));
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function wire(episodes: Episode[]) {
    return buildEngineWiring({
      workspaceRoot: workspace,
      currentCommit: "a".repeat(40),
      episodes,
    });
  }

  it("runs a diagnose task end-to-end: report committed, backlog investigated", async () => {
    const wiring = wire([failureEpisode("ep-1", "Fix tool selection"), failureEpisode("ep-2", "Tool argument error")]);
    try {
      const outcome = await wiring.runner.runOne({ taskId: "EVO-004" });
      expect(outcome.validated).toBe(true);
      expect(outcome.mode).toBe("diagnose");
      expect(outcome.reportRef).toBeDefined();

      // The report is durably stored and satisfies the 12-section contract.
      const report = wiring.reportStore.latestForTask("EVO-004");
      expect(report).not.toBeNull();
      expect(report!.identified_gaps.gaps.length).toBeGreaterThan(0);
      expect(report!.confidence.independent_samples).toBeGreaterThan(0);
      expect(["investigate_further", "implement"]).toContain(report!.recommendation.decision);

      // Episode provenance flows into gap evidence (independent samples).
      const evidenceStrings = report!.identified_gaps.gaps.flatMap((g) => g.evidence);
      expect(evidenceStrings).toContain("ep-1");
      expect(evidenceStrings).toContain("ep-2");

      // The backlog transitioned with the report id + evidence window.
      const entry = wiring.backlog.get("EVO-004");
      expect(entry?.state).toBe("investigated");
      expect(entry?.lastReportId).toBe(report!.id);
      expect(entry?.lastEvaluatedCommit).toBe("a".repeat(40));
    } finally {
      wiring.close();
    }
  });

  it("re-running the same hypothesis without new evidence is blocked by the anti-rule", async () => {
    const episodes = [failureEpisode("ep-1", "Fix tool selection")];
    const first = wire(episodes);
    let firstReportId: string;
    try {
      const outcome = await first.runner.runOne({ taskId: "EVO-004" });
      expect(outcome.validated).toBe(true);
      firstReportId = outcome.reportRef!.id;
    } finally {
      first.close();
    }

    // A second wiring over the SAME evidence must be blocked: duplicate
    // hypothesis + no new evidence (the report store persists across
    // wirings, seeding the known-hypothesis set).
    const second = wire(episodes);
    try {
      const outcome = await second.runner.runOne({ taskId: "EVO-004" });
      expect(outcome.validated).toBe(false);
      expect(["duplicate_hypothesis", "no_new_evidence"]).toContain(outcome.validationCode);
      // No new report was committed.
      expect(second.reportStore.latestForTask("EVO-004")?.id).toBe(firstReportId);
    } finally {
      second.close();
    }
  });

  it("new evidence unblocks a re-run and produces a fresh report", async () => {
    const first = wire([failureEpisode("ep-1", "Fix tool selection")]);
    try {
      await first.runner.runOne({ taskId: "EVO-004" });
    } finally {
      first.close();
    }

    const second = wire([
      failureEpisode("ep-1", "Fix tool selection"),
      // New episode, started LATER than the first report's evidence window.
      failureEpisode("ep-9", "Another failure", Date.now() + 10_000),
    ]);
    try {
      const outcome = await second.runner.runOne({ taskId: "EVO-004" });
      expect(outcome.validated).toBe(true);
      expect(outcome.reportRef).toBeDefined();
    } finally {
      second.close();
    }
  });

  it("declines to commit a report when there are no episodes (no evidence, no report)", async () => {
    const wiring = wire([]);
    try {
      const outcome = await wiring.runner.runOne({ taskId: "EVO-004" });
      expect(outcome.validated).toBe(true);
      expect(outcome.reportRef).toBeUndefined();
      expect(wiring.reportStore.latestForTask("EVO-004")).toBeNull();
    } finally {
      wiring.close();
    }
  });

  it("experiment/implement tasks refuse to run from the catalogue CLI", async () => {
    const wiring = wire([]);
    try {
      const { catalog } = loadCatalog();
      const experimentTask = catalog.tasks.find((t) => t.execution.mode === "experiment");
      if (experimentTask) {
        await expect(wiring.runner.runOne({ taskId: experimentTask.id })).rejects.toThrow(
          /not runnable from the catalogue CLI/,
        );
      }
      const implementTask = catalog.tasks.find((t) => t.execution.mode === "implement");
      if (implementTask) {
        await expect(wiring.runner.runOne({ taskId: implementTask.id })).rejects.toThrow(
          /not runnable from the catalogue CLI/,
        );
      }
    } finally {
      wiring.close();
    }
  });

  it("evidence functions are derived from the observation, not invented", async () => {
    const wiring = wire([failureEpisode("ep-1", "a"), failureEpisode("ep-2", "b"), failureEpisode("ep-3", "c")]);
    try {
      // Half the window's episodes produce diagnoses → observed frequency
      // is computed, and stays within [0, 1].
      const freq = wiring.deps.getObservedFrequency("EVO-004");
      expect(freq).toBeGreaterThan(0);
      expect(freq).toBeLessThanOrEqual(1);
      expect(wiring.deps.getNewEvidenceCount("EVO-004")).toBe(3);
      expect(wiring.deps.getEvidenceConfidence("EVO-004")).toBe(0);
      expect(wiring.deps.getCurrentCommit()).resolves.toBe("a".repeat(40));
    } finally {
      wiring.close();
    }
  });
});

describe("buildPartialReport mapping", () => {
  it("fills every section the contract requires from an observation", () => {
    const engine = new ClosedLoopEngine();
    const episodes = [failureEpisode("ep-1", "Fix tool selection")];
    const observation = engine.observe(episodes);
    expect(observation.diagnoses.length).toBeGreaterThan(0);

    const { catalog } = loadCatalog();
    const registry = new TaskRegistry(catalog.tasks);
    const task = registry.get("EVO-004")!;
    const partial = buildPartialReport(task, observation, episodes, 1);

    // Every section EVO-004 declares required is substantively present.
    expect(partial.current_implementation!.files.length).toBeGreaterThan(0);
    expect(partial.current_behavior!.summary.length).toBeGreaterThan(0);
    expect(partial.identified_gaps!.gaps.length).toBeGreaterThan(0);
    expect(partial.root_cause_analysis!.root_causes.length).toBeGreaterThan(0);
    expect(partial.improvement_proposals!.proposals.length).toBeGreaterThan(0);
    expect(partial.expected_impact!.measurement_basis).toBeTruthy();
    expect(partial.risk_assessment!.regression_risks.length).toBeGreaterThan(0);
    expect(partial.implementation_plan!.files_likely_to_change.length).toBeGreaterThan(0);
    expect(partial.verification_plan!.tests_required.length).toBeGreaterThan(0);
    expect(partial.recommendation!.decision).toBeTruthy();
    expect(partial.confidence!.overall).toBeGreaterThan(0);
    expect(partial.confidence!.limitations.length).toBeGreaterThan(0);
  });

  it("recommendation follows the evidence: target formed → implement, else investigate_further", () => {
    const engine = new ClosedLoopEngine();
    const episodes = [failureEpisode("ep-1", "Fix tool selection"), failureEpisode("ep-2", "Tool argument error")];
    const observation = engine.observe(episodes);
    const { catalog } = loadCatalog();
    const registry = new TaskRegistry(catalog.tasks);
    const task = registry.get("EVO-004")!;

    const partial = buildPartialReport(task, observation, episodes, 2);
    if (observation.target && observation.plan) {
      expect(partial.recommendation!.decision).toBe("implement");
      // The implement decision requires a proposal→gap chain (evaluation.yml).
      const gapDescs = new Set(observation.diagnoses.map((d) => `[${d.failureClass}] ${d.rootCause}`));
      const chained = partial.improvement_proposals!.proposals.some((p) =>
        p.rootCauseRefs.some((r) => gapDescs.has(r)),
      );
      expect(chained).toBe(true);
    } else {
      expect(partial.recommendation!.decision).toBe("investigate_further");
    }
  });
});

describe("engine-wiring store isolation", () => {
  it("closes cleanly and stores persist across wirings in the same workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "nexum-wiring-persist-"));
    try {
      const first = buildEngineWiring({
        workspaceRoot: workspace,
        currentCommit: "b".repeat(40),
        episodes: [failureEpisode("ep-1", "Fix tool selection")],
      });
      let reportId: string;
      try {
        const outcome = await first.runner.runOne({ taskId: "EVO-004" });
        reportId = outcome.reportRef!.id;
      } finally {
        first.close();
      }

      // Fresh handles over the same workspace see the persisted report.
      const reportStore = new ReportStore(join(workspace, ".nexum", "report-store.db"));
      const backlog = new BacklogTracker(join(workspace, ".nexum", "task-catalogue.db"));
      try {
        expect(reportStore.latestForTask("EVO-004")?.id).toBe(reportId);
        expect(backlog.get("EVO-004")?.state).toBe("investigated");
      } finally {
        reportStore.close();
        backlog.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
