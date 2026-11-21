import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { GitWorktreeMutationExecutor } from "../../src/evolution/mutation/mutation-executor.js";
import { ActivationMonitor } from "../../src/evolution/monitoring/activation-monitor.js";
import { HarnessRegistry } from "../../src/evolution/registry.js";
import { TaskExecutionResult } from "../../src/evolution/evaluator.js";
import { Episode } from "../../src/learning/types.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  return res.stdout;
}

async function makeRepo(): Promise<{ repoRoot: string; wsRoot: string; head: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "actrepo-"));
  await mkdir(join(repoRoot, "src", "tools"), { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", repoRoot]);
  await writeFile(join(repoRoot, "src", "tools", "index.ts"), "export const tools = 1;\n", "utf8");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-q", "-m", "init"]);
  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const wsRoot = await mkdtemp(join(tmpdir(), "actws-"));
  return { repoRoot, wsRoot, head };
}

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

function results(successRate: number, tokens: number): TaskExecutionResult[] {
  const specs: Array<[string, boolean, boolean]> = [
    ["v1", successRate >= 0.34, false],
    ["v2", successRate >= 0.34, false],
    ["v3", successRate >= 0.67, false],
    ["h1", successRate >= 0.34, true],
    ["h2", successRate >= 0.67, true],
    ["h3", successRate, true],
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

/**
 * Passing fixed-executor matrix (held-out + transfer, candidate beats baseline
 * on both executors). The engine's default generalization policy is now
 * "required", so lifecycle tests must supply real evidence to reach
 * CI_PENDING — exactly as the production path would.
 */
function passingMatrixCells(
  candidateId = "H1",
  baselineId = "H0",
  executor = "qwen3-coder",
): Parameters<ClosedLoopEngine["runExperiment"]>[0]["matrixCells"] {
  return [
    {
      harnessId: baselineId,
      executorModel: "qwen3-coder",
      split: "held_out" as const,
      taskSuccessRate: 0.33,
      verificationPassRate: 0.33,
      runs: 5,
    },
    {
      harnessId: candidateId,
      executorModel: "qwen3-coder",
      split: "held_out" as const,
      taskSuccessRate: 0.9,
      verificationPassRate: 0.9,
      runs: 5,
    },
    {
      harnessId: baselineId,
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

describe("ClosedLoopEngine self-development actuator", () => {
  let repoRoot: string;
  let wsRoot: string;
  let head: string;
  let registry: HarnessRegistry;
  let engine: ClosedLoopEngine;

  beforeEach(async () => {
    ({ repoRoot, wsRoot, head } = await makeRepo());
    registry = new HarnessRegistry(":memory:");
    engine = new ClosedLoopEngine({
      registry,
      executorModels: ["qwen3-coder", "gemini-2.5"],
      mutationExecutor: new GitWorktreeMutationExecutor({
        worktreeParentDir: wsRoot,
        verifyCommands: [["node", "--version"]],
      }),
    });
  });

  afterEach(async () => {
    registry.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  it("runs the FULL self-development cycle: mutation → commit → benchmark → experiment", async () => {
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    const res = await engine.runEvolutionCycle({
      experimentId: "exp-act-1",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      baselineResults: results(0.4, 2000),
      evaluateCandidate: () => results(0.9, 1600),
      matrixCells: passingMatrixCells(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The candidate commit recorded in the experiment IS the mutation commit.
    expect(res.outcome.experiment.candidate.commit).toBe(res.mutation.artifact!.commitSha);
    expect(res.mutation.artifact!.changedFiles).toEqual(["nexum.harness.json"]);
    expect(res.mutation.workspace!.branchName).toBe("evolution/h1");
    // Two-stage evaluation ran on the benchmark callback's results.
    expect(res.outcome.twoStage.decision).toBe("eligible");
    expect(res.outcome.experiment.lifecycle.state).toBe("CI_PENDING");
  });

  it("fails at the verify stage when the mutation violates the scope", async () => {
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    // tools scope, but force an out-of-scope edit path via a custom strategy.
    const engine2 = new ClosedLoopEngine({
      registry,
      executorModels: ["qwen3-coder", "gemini-2.5"],
      mutationExecutor: new GitWorktreeMutationExecutor({
        worktreeParentDir: wsRoot,
        verifyCommands: [["node", "--version"]],
        strategy: {
          name: "rogue-strategy",
          inspectTarget: (input) => ({
            planId: "rogue-1",
            targetId: input.target.id,
            summary: "rogue out-of-scope edit",
            strategy: "rogue-strategy",
            edits: [{ path: "README.md", content: "rogue\n", component: "tools", rationale: "violates scope" }],
            createdAt: Date.now(),
          }),
        },
      }),
    });
    const res = await engine2.runEvolutionCycle({
      experimentId: "exp-act-2",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H2",
      repoRoot,
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      baselineResults: results(0.4, 2000),
      evaluateCandidate: () => results(0.9, 1600),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The scope guard rejects every edit at implementation time.
    expect(res.stage).toBe("implement");
    expect(res.reason).toContain("scope guard");
    // No experiment record was created for the failed mutation.
    expect(() => engine2.experiments.record("exp-act-2")).toThrow();
  });

  it("surfaces benchmark failures as an 'evaluate' stage result (artifact preserved)", async () => {
    const observation = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    const res = await engine.runEvolutionCycle({
      experimentId: "exp-act-3",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H3",
      repoRoot,
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: observation.mutationScope!,
      baselineResults: results(0.4, 2000),
      evaluateCandidate: () => {
        throw new Error("provider unavailable");
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("evaluate");
    expect(res.reason).toContain("provider unavailable");
    // The mutation artifact still exists for inspection/rework.
    expect(res.mutation.artifact!.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("ClosedLoopEngine post-activation monitoring", () => {
  let registry: HarnessRegistry;
  let monitor: ActivationMonitor;
  let engine: ClosedLoopEngine;

  beforeEach(async () => {
    registry = new HarnessRegistry(":memory:");
    monitor = new ActivationMonitor({ minSampleSize: 10 });
    engine = new ClosedLoopEngine({ registry, monitor, executorModels: ["qwen"] });
  });

  afterEach(() => {
    registry.close();
  });

  function setupActiveExperiment(): void {
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.6, verificationPassRate: 0.8 },
        reliability: { toolErrorRate: 0.2, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.5, transferScore: 0.5 },
      },
      status: "promoted",
    });
    // Seed the promotion-precision ledger the acceptance loop will update.
    engine.metrics.record({
      versionId: "H1",
      parentVersionId: "H0",
      visibleGain: 0.1,
      heldOutGain: 0.05,
      transferGain: 0.05,
      promoted: true,
      genuinelyBetterOnHeldOut: true,
      accepted: false,
      rolledBack: false,
      retainedBySuccessor: "unknown",
      executorModels: ["qwen"],
      executorSensitivity: 0,
    });
    engine.experiments.startExperiment({
      id: "exp-mon-1",
      parentHarness: "H0",
      parentCommit: "sha-h0",
      candidateHarness: "H1",
      candidateCommit: "sha-h1",
      targetId: "t1",
      targetCapability: "tool_utilization",
      desiredOutcome: "fewer tool errors",
      hypothesisId: "hyp-1",
      hypothesisStatement: "prune schemas",
      predictedEffect: "reliability +10%",
      executorPrimary: "qwen",
      executorTransfer: [],
    });
    // The candidate must exist in the registry for activation promotion.
    registry.saveVersion({
      id: "H1",
      commitSha: "sha-h1",
      parentId: "H0",
      createdAt: Date.now(),
      targetComponent: "tools",
      hypothesis: "prune schemas",
      metrics: {
        capability: { taskSuccessRate: 0.7, verificationPassRate: 0.85 },
        reliability: { toolErrorRate: 0.15, falseSuccessRate: 0.08, loopAbortRate: 0.08 },
        efficiency: { avgTokens: 1900, avgLatencyMs: 1100 },
        generalization: { heldOutScore: 0.55, transferScore: 0.55 },
      },
      status: "validated",
    });
    for (const s of ["EVALUATING", "VALIDATED", "GENERALIZED", "ELIGIBLE", "DELIVERED"] as const) {
      engine.experiments.advance("exp-mon-1", s);
    }
    engine.reportCi("exp-mon-1", true);
    engine.reportReview("exp-mon-1", true, "maintainer");
    expect(engine.finalizeAcceptance("exp-mon-1")).toBe(true);
  }

  function sample(over: Partial<Record<string, number>> = {}) {
    return {
      at: Date.now(),
      harnessId: "H1",
      experimentId: "exp-mon-1",
      episodes: 10,
      taskSuccessRate: 0.6,
      falseSuccessRate: 0.1,
      toolErrorRate: 0.2,
      loopAbortRate: 0.1,
      verificationFailureRate: 0.2,
      avgTokens: 2000,
      avgLatencyMs: 1200,
      ...over,
    };
  }

  it("registers an envelope from the parent harness at activation time", () => {
    setupActiveExperiment();
    const health = engine.evaluateActivation("exp-mon-1");
    expect(health).not.toBeNull();
    // Baseline mirrors the PARENT H0 metrics: healthy while telemetry matches.
    expect(health!.status).toBe("insufficient_samples");
    monitor.ingest(sample());
    const health2 = engine.evaluateActivation("exp-mon-1");
    expect(health2!.status).toBe("healthy");
  });

  it("auto-rolls back through ACTIVE → REGRESSED → ROLLBACK on a hard regression", () => {
    setupActiveExperiment();
    expect(registry.getActiveVersion()?.id).toBe("H1");
    // Success rate collapses 0.6 → 0.4 (−33%, beyond the 15% regression band).
    monitor.ingest(sample({ taskSuccessRate: 0.4 }));
    const health = engine.evaluateActivation("exp-mon-1");
    expect(health!.status).toBe("regressed");
    expect(registry.getActiveVersion()?.id).toBe("H0"); // rolled back to the parent
    const record = engine.experiments.record("exp-mon-1");
    expect(record.lifecycle.state).toBe("ROLLBACK");
    const switchRecord = engine.metrics.records().find((s) => s.versionId === "H1");
    expect(switchRecord?.rolledBack).toBe(true);
  });

  it("reports degrading without triggering rollback", () => {
    setupActiveExperiment();
    // Success 0.6 → 0.555 = −7.5%: inside the warn band, below regression.
    monitor.ingest(sample({ taskSuccessRate: 0.555 }));
    const health = engine.evaluateActivation("exp-mon-1");
    expect(health!.status).toBe("degrading");
    expect(registry.getActiveVersion()?.id).toBe("H1");
    expect(engine.experiments.record("exp-mon-1").lifecycle.state).toBe("ACTIVE");
  });
});
