import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClosedLoopEngine, deriveValidity } from "../../src/evolution/engine-v2.js";
import { ExperienceStore } from "../../src/evolution/experience/experience-store.js";
import { HarnessRegistry } from "../../src/evolution/registry.js";
import { TaskExecutionResult } from "../../src/evolution/evaluator.js";
import { Episode } from "../../src/learning/types.js";

function failureEpisode(id: string, goal: string): Episode {
  return {
    id,
    goal,
    startedAt: 1000,
    endedAt: 2000,
    terminal: "loop_abort",
    toolEvents: [
      { name: "read_file", args: {}, ok: true, durationMs: 50, at: 1001 },
      { name: "run_shell", args: {}, ok: false, durationMs: 100, at: 1002, errorLabel: "Argument validation failed" },
      { name: "run_shell", args: {}, ok: false, durationMs: 100, at: 1003, errorLabel: "Argument validation failed" },
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

function results(successRate: number, tokens: number, heldOutSuccess = successRate): TaskExecutionResult[] {
  const specs: Array<[string, boolean, boolean]> = [
    ["v1", true, false],
    ["v2", true, false],
    ["v3", successRate >= 0.34, false],
    ["v4", successRate >= 0.67, false],
    ["v5", successRate >= 0.67, false],
    ["v6", successRate >= 0.34, false],
    ["h1", heldOutSuccess >= 0.34, true],
    ["h2", heldOutSuccess >= 0.67, true],
    ["h3", heldOutSuccess, true],
  ];
  return specs.map(([taskId, success, isHeldOut]) => ({
    taskId,
    success,
    verificationPassed: success,
    toolCalls: 4,
    toolErrors: success ? 0 : 1,
    tokens,
    latencyMs: 900,
    loopAborted: false,
    isHeldOut,
  }));
}

describe("ClosedLoopEngine (v2 integration)", () => {
  let tmpDir: string;
  let registry: HarnessRegistry;
  let experienceStore: ExperienceStore;
  let engine: ClosedLoopEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "closed-loop-test-"));
    registry = new HarnessRegistry(join(tmpDir, "registry.db"));
    experienceStore = new ExperienceStore(join(tmpDir, "experience.db"));
    engine = new ClosedLoopEngine({
      registry,
      experienceStore,
      executorModels: ["qwen3-coder", "gemini-2.5"],
    });
  });

  afterEach(async () => {
    registry.close();
    experienceStore.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("observation pipeline: episodes → diagnoses → target → scope", () => {
    const episodes = [
      failureEpisode("ep-1", "Fix tool selection"),
      failureEpisode("ep-2", "Tool argument error again"),
    ];
    const observation = engine.observe(episodes);
    expect(observation.diagnoses.length).toBeGreaterThan(0);
    expect(observation.target).not.toBeNull();
    expect(observation.plan).not.toBeNull();
    expect(observation.mutationScope).not.toBeNull();
    expect(observation.mutationScope!.kind).toBe("single_component");
  });

  it("ingests graded episodes into the experience store with evidence", () => {
    const episodes = [failureEpisode("ep-1", "Fix the login bug"), failureEpisode("ep-2", "Add retry feature")];
    engine.ingestExperience(episodes, "H0");
    expect(experienceStore.count()).toBe(2);
    const digests = engine.digestExperience();
    expect(digests.length).toBeGreaterThan(0);
    const analysis = engine.analyzeTransfer();
    expect(analysis.verdicts.length).toBeGreaterThan(0);
  });

  it("runs a full experiment: eligible candidate reaches REVIEWED with provenance", () => {
    // Establish baseline H0 in the registry.
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.55, verificationPassRate: 0.55 },
        reliability: { toolErrorRate: 0.3, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.33, transferScore: 0.33 },
      },
      status: "promoted",
    });

    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    const outcome = engine.runExperiment({
      experimentId: "exp-001",
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H1",
      candidateCommit: "sha-h1",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: results(0.9, 1600, true),
      baselineResults: results(0.4, 2000, false),
      matrixCells: [
        {
          harnessId: "H0",
          executorModel: "qwen3-coder",
          split: "held_out",
          taskSuccessRate: 0.33,
          verificationPassRate: 0.33,
          runs: 5,
        },
        {
          harnessId: "H1",
          executorModel: "qwen3-coder",
          split: "held_out",
          taskSuccessRate: 0.9,
          verificationPassRate: 0.9,
          runs: 5,
        },
        {
          harnessId: "H0",
          executorModel: "gemini-2.5",
          split: "transfer",
          taskSuccessRate: 0.33,
          verificationPassRate: 0.33,
          runs: 5,
        },
        {
          harnessId: "H1",
          executorModel: "gemini-2.5",
          split: "transfer",
          taskSuccessRate: 0.85,
          verificationPassRate: 0.85,
          runs: 5,
        },
      ],
    });

    expect(outcome.twoStage.stageA.decision).toBe("valid");
    expect(outcome.twoStage.decision).toBe("eligible");
    expect(outcome.generalization?.generalized).toBe(true);
    expect(outcome.experiment.decision.result).toBe("eligible");
    expect(outcome.delivery).not.toBeNull();
    // PR body contains machine-readable provenance (persistent experiment log).
    expect(outcome.delivery!.prBody).toContain("### 4. Experiment Provenance (machine-readable)");
    expect(outcome.delivery!.prBody).toContain("id: exp-001");
    // Lifecycle: candidate is explicitly awaiting its CI verdict.
    expect(outcome.experiment.lifecycle.state).toBe("CI_PENDING");
  });

  it("completes the acceptance loop: CI pass + review approval → ACTIVE in registry", () => {
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.5, verificationPassRate: 0.5 },
        reliability: { toolErrorRate: 0.3, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.33, transferScore: 0.33 },
      },
      status: "promoted",
    });
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    engine.runExperiment({
      experimentId: "exp-002",
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H1",
      candidateCommit: "sha-h1",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: results(0.9, 1800, true),
      baselineResults: results(0.4, 2000, false),
    });

    engine.reportCi("exp-002", true, "https://ci/run/9");
    // CI pass explicitly advanced the lifecycle to review.
    expect(engine.experiments.record("exp-002").lifecycle.state).toBe("REVIEW_PENDING");
    engine.reportReview("exp-002", true, "maintainer");
    expect(engine.experiments.record("exp-002").lifecycle.state).toBe("APPROVED");
    expect(engine.finalizeAcceptance("exp-002")).toBe(true);

    expect(registry.getActiveVersion()?.id).toBe("H1");
    const switchRecord = engine.metrics.records().find((s) => s.versionId === "H1");
    expect(switchRecord?.accepted).toBe(true);
  });

  it("rejects invalid experiments and leaves the baseline active", () => {
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.8, verificationPassRate: 0.8 },
        reliability: { toolErrorRate: 0.1, falseSuccessRate: 0.05, loopAbortRate: 0.05 },
        efficiency: { avgTokens: 1500, avgLatencyMs: 900 },
        generalization: { heldOutScore: 0.8, transferScore: 0.8 },
      },
      status: "promoted",
    });
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    const outcome = engine.runExperiment({
      experimentId: "exp-003",
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H_bad",
      candidateCommit: "sha-bad",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: [results(0.1, 4000, false)[0]], // 1 run: fails Stage A sample size
      baselineResults: results(0.8, 1500, true),
    });
    expect(outcome.twoStage.decision).toBe("rejected");
    expect(outcome.delivery).toBeNull();
    expect(outcome.experiment.decision.result).toBe("rejected");
    expect(registry.getActiveVersion()?.id).toBe("H0");
  });

  it("handles post-deployment regression through rollback", () => {
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.5, verificationPassRate: 0.5 },
        reliability: { toolErrorRate: 0.3, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.33, transferScore: 0.33 },
      },
      status: "promoted",
    });
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    engine.runExperiment({
      experimentId: "exp-004",
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H1",
      candidateCommit: "sha-h1",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: results(0.9, 1800, true),
      baselineResults: results(0.4, 2000, false),
    });
    engine.reportCi("exp-004", true);
    engine.reportReview("exp-004", true, "maintainer");
    engine.finalizeAcceptance("exp-004");
    expect(registry.getActiveVersion()?.id).toBe("H1");

    // Post-deployment monitoring detects a regression → rollback to H0.
    engine.handleRegression("exp-004", "held-out success regressed 10% in production");
    expect(registry.getActiveVersion()?.id).toBe("H0");
    const switchRecord = engine.metrics.records().find((s) => s.versionId === "H1");
    expect(switchRecord?.rolledBack).toBe(true);
  });

  it("deriveValidity computes Stage-A facts from raw runs", () => {
    const candidate = results(0.9, 1500, true);
    const baseline = results(0.4, 2000, false);
    const validity = deriveValidity(candidate, baseline);
    expect(validity.completedRuns).toBe(candidate.length);
    expect(validity.verifierCoverage).toBeGreaterThan(0);
    expect(validity.catastrophicRegression).toBe(false);
  });

  it("two-stage rejection drives EVALUATING → REJECTED (no stuck candidates)", () => {
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.8, verificationPassRate: 0.8 },
        reliability: { toolErrorRate: 0.1, falseSuccessRate: 0.05, loopAbortRate: 0.05 },
        efficiency: { avgTokens: 1500, avgLatencyMs: 900 },
        generalization: { heldOutScore: 0.8, transferScore: 0.8 },
      },
      status: "promoted",
    });
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    engine.runExperiment({
      experimentId: "exp-reject",
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H_bad2",
      candidateCommit: "sha-bad2",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: [results(0.1, 4000, false)[0]], // 1 run: fails Stage A sample size
      baselineResults: results(0.8, 1500, true),
    });
    expect(engine.experiments.record("exp-reject").lifecycle.state).toBe("REJECTED");
  });

  describe("held-out results are reported, never decided on", () => {
    // Development results: the candidate passes 7 of 9 tasks, the baseline 3 of 9.
    const CANDIDATE_DEV = [true, true, true, true, true, true, true, false, false];
    const BASELINE_DEV = [true, true, true, false, false, false, false, false, false];

    function tasks(devSuccess: boolean[], heldOutSuccess: boolean[]): TaskExecutionResult[] {
      const make = (taskId: string, success: boolean, isHeldOut: boolean): TaskExecutionResult => ({
        taskId,
        success,
        verificationPassed: success,
        toolCalls: 4,
        toolErrors: success ? 0 : 1,
        tokens: 1500,
        tokensEstimated: false,
        latencyMs: 900,
        loopAborted: false,
        isHeldOut,
      });
      return [
        ...devSuccess.map((s, i) => make(`dev-${i}`, s, false)),
        ...heldOutSuccess.map((s, i) => make(`held-${i}`, s, true)),
      ];
    }

    function transferCells(candidateId: string, heldOutSuccess: boolean[]) {
      const rate = heldOutSuccess.filter(Boolean).length / heldOutSuccess.length;
      return [
        {
          harnessId: "H0",
          executorModel: "qwen3-coder",
          split: "held_out" as const,
          taskSuccessRate: 0.33,
          verificationPassRate: 0.33,
          runs: 3,
        },
        {
          harnessId: candidateId,
          executorModel: "qwen3-coder",
          split: "held_out" as const,
          taskSuccessRate: rate,
          verificationPassRate: rate,
          runs: 3,
        },
        {
          harnessId: "H0",
          executorModel: "gemini-2.5",
          split: "transfer" as const,
          taskSuccessRate: 0.33,
          verificationPassRate: 0.33,
          runs: 5,
        },
        {
          harnessId: candidateId,
          executorModel: "gemini-2.5",
          split: "transfer" as const,
          taskSuccessRate: 0.85,
          verificationPassRate: 0.85,
          runs: 5,
        },
      ];
    }

    it("reaches the identical decision whatever the held-out results, which are reported beside it", () => {
      registry.saveVersion({
        id: "H0",
        commitSha: "sha-h0",
        parentId: null,
        createdAt: Date.now(),
        targetComponent: "execution",
        hypothesis: "baseline",
        metrics: {
          capability: { taskSuccessRate: 0.33, verificationPassRate: 0.33 },
          reliability: { toolErrorRate: 0.3, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
          efficiency: { avgTokens: 1500, avgLatencyMs: 900 },
          generalization: { heldOutScore: 0.33, transferScore: 0.33 },
        },
        status: "promoted",
      });
      const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
      const run = (experimentId: string, candidateHeld: boolean[]) => {
        const candidateId = `H-${experimentId}`;
        return engine.runExperiment({
          experimentId,
          parentHarnessId: "H0",
          parentCommit: "sha-h0",
          candidateHarnessId: candidateId,
          candidateCommit: `sha-${experimentId}`,
          target: observation.target!,
          diagnosis: observation.diagnoses[0],
          scope: observation.mutationScope!,
          candidateResults: tasks(CANDIDATE_DEV, candidateHeld),
          baselineResults: tasks(BASELINE_DEV, [true, false, false]),
          matrixCells: transferCells(candidateId, candidateHeld),
        });
      };

      // Same development results; held-out results that collapse versus ones that are perfect.
      const collapsed = run("exp-held-collapsed", [false, false, false]);
      const perfect = run("exp-held-perfect", [true, true, true]);

      expect(collapsed.twoStage.decision).toBe("eligible");
      expect(perfect.twoStage.decision).toBe(collapsed.twoStage.decision);
      expect(perfect.experiment.decision.result).toBe(collapsed.experiment.decision.result);
      expect(perfect.generalization?.generalized).toBe(collapsed.generalization?.generalized);
      expect(perfect.comparison.scoreDeltas.capability).toBe(collapsed.comparison.scoreDeltas.capability);
      expect(perfect.comparison.scoreDeltas.reliability).toBe(collapsed.comparison.scoreDeltas.reliability);

      // The held-out endpoint is still measured and reported. It is the only thing that differs.
      expect(collapsed.heldOut.candidateRuns).toBe(3);
      expect(collapsed.heldOut.gain).toBeLessThan(0);
      expect(perfect.heldOut.gain).toBeGreaterThan(collapsed.heldOut.gain!);
    });
  });
});

describe("ClosedLoopEngine generalization policy", () => {
  let tmpDir: string;
  let registry: HarnessRegistry;
  let engine: ClosedLoopEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "genpolicy-test-"));
    registry = new HarnessRegistry(join(tmpDir, "registry.db"));
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.5, verificationPassRate: 0.5 },
        reliability: { toolErrorRate: 0.3, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.33, transferScore: 0.33 },
      },
      status: "promoted",
    });
  });

  afterEach(async () => {
    registry.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function run(engine: ClosedLoopEngine, id: string, withMatrix: boolean): ExperimentOutcomeLike {
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    const matrix = [
      {
        harnessId: "H0",
        executorModel: "qwen3-coder",
        split: "held_out" as const,
        taskSuccessRate: 0.33,
        verificationPassRate: 0.33,
        runs: 5,
      },
      {
        harnessId: "H1",
        executorModel: "qwen3-coder",
        split: "held_out" as const,
        taskSuccessRate: 0.9,
        verificationPassRate: 0.9,
        runs: 5,
      },
      {
        harnessId: "H0",
        executorModel: "gemini-2.5",
        split: "transfer" as const,
        taskSuccessRate: 0.33,
        verificationPassRate: 0.33,
        runs: 5,
      },
      {
        harnessId: "H1",
        executorModel: "gemini-2.5",
        split: "transfer" as const,
        taskSuccessRate: 0.85,
        verificationPassRate: 0.85,
        runs: 5,
      },
    ];
    return engine.runExperiment({
      experimentId: id,
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H1",
      candidateCommit: "sha-h1",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: results(0.9, 1600, true),
      baselineResults: results(0.4, 2000, false),
      matrixCells: withMatrix ? matrix : undefined,
    });
  }

  it("policy 'optional' keeps eligibility without fixed-executor evidence (development mode)", () => {
    engine = new ClosedLoopEngine({
      registry,
      generalizationPolicy: "optional",
      executorModels: ["qwen3-coder", "gemini-2.5"],
    });
    const outcome = run(engine, "exp-optional", false);
    expect(outcome.twoStage.decision).toBe("eligible");
    expect(outcome.generalization).toBeNull();
    expect(outcome.experiment.decision.result).toBe("eligible");
    expect(outcome.experiment.lifecycle.state).toBe("CI_PENDING");
  });

  it("policy 'required' blocks candidates without a fixed-executor matrix", () => {
    engine = new ClosedLoopEngine({
      registry,
      generalizationPolicy: "required",
      executorModels: ["qwen3-coder", "gemini-2.5"],
    });
    const outcome = run(engine, "exp-required", false);
    expect(outcome.twoStage.decision).toBe("eligible"); // benchmark said yes…
    expect(outcome.experiment.decision.result).toBe("inconclusive"); // …but policy blocked it
    expect(outcome.delivery).toBeNull();
    expect(outcome.experiment.lifecycle.state).toBe("REJECTED");
    expect(outcome.experiment.decision.rationale).toContain("required");
  });

  it("policy 'required' passes candidates WITH a generalizing matrix", () => {
    engine = new ClosedLoopEngine({
      registry,
      generalizationPolicy: "required",
      executorModels: ["qwen3-coder", "gemini-2.5"],
    });
    const outcome = run(engine, "exp-required-matrix", true);
    expect(outcome.experiment.decision.result).toBe("eligible");
    expect(outcome.experiment.lifecycle.state).toBe("CI_PENDING");
  });

  it("policy 'required-for-production' also demands transfer-executor evidence", () => {
    engine = new ClosedLoopEngine({
      registry,
      generalizationPolicy: "required-for-production",
      executorModels: ["qwen3-coder", "gemini-2.5"],
    });
    // Matrix with held-out cells only — no transfer cells.
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    const outcome = engine.runExperiment({
      experimentId: "exp-prod-missing-transfer",
      parentHarnessId: "H0",
      parentCommit: "sha-h0",
      candidateHarnessId: "H1",
      candidateCommit: "sha-h1",
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      candidateResults: results(0.9, 1600, true),
      baselineResults: results(0.4, 2000, false),
      matrixCells: [
        {
          harnessId: "H0",
          executorModel: "qwen3-coder",
          split: "held_out",
          taskSuccessRate: 0.33,
          verificationPassRate: 0.33,
          runs: 5,
        },
        {
          harnessId: "H1",
          executorModel: "qwen3-coder",
          split: "held_out",
          taskSuccessRate: 0.9,
          verificationPassRate: 0.9,
          runs: 5,
        },
      ],
    });
    expect(outcome.generalization).not.toBeNull();
    expect(outcome.experiment.decision.result).toBe("inconclusive");
    expect(outcome.experiment.lifecycle.state).toBe("REJECTED");
  });
});

type ExperimentOutcomeLike = ReturnType<ClosedLoopEngine["runExperiment"]>;
