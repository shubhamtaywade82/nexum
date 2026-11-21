import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentDeclinedError,
  AgentMutationError,
  AgentMutationStrategy,
  ScriptedAgentRuntime,
} from "../../src/evolution/mutation/agent-mutation.js";
import { GitWorktreeMutationExecutor } from "../../src/evolution/mutation/mutation-executor.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { HarnessRegistry } from "../../src/evolution/registry.js";
import { TaskExecutionResult } from "../../src/evolution/evaluator.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";
import { MutationScope } from "../../src/evolution/mutation/mutation-scope.js";
import { HarnessDiagnosis } from "../../src/evolution/types.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  return res.stdout;
}

/**
 * A repository that looks like a tiny Nexum harness: the agent mutates the
 * ACTUAL tool-schema source file, not a policy manifest.
 */
async function makeHarnessRepo(): Promise<{ repoRoot: string; wsRoot: string; head: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "agentrepo-"));
  await mkdir(join(repoRoot, "src", "tools"), { recursive: true });
  await writeFile(
    join(repoRoot, "src", "tools", "schemas.ts"),
    ["export const toolSchemas = [", '  { name: "run_shell", parameters: "*" },', "];", ""].join("\n"),
    "utf8",
  );
  await exec("git", ["init", "-q", "-b", "main", repoRoot]);
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-q", "-m", "init"]);
  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const wsRoot = await mkdtemp(join(tmpdir(), "agentws-"));
  return { repoRoot, wsRoot, head };
}

function target(): ImprovementTarget {
  return {
    id: "target-tool_utilization-1",
    capability: "tool_utilization",
    desiredOutcome: "Tool error rate drops",
    observableSymptoms: ["tool_selection failures"],
    measurableMetrics: ["reliability.toolErrorRate"],
    affectedComponents: ["tools"],
    confidence: 0.9,
    evaluationPlan: {
      successCriterion: "tool error rate drops",
      steps: [{ suite: "tool-calling", split: "visible", minRuns: 3 }],
      executorModels: ["qwen"],
    },
    sourceFailureClasses: ["tool_selection"],
    createdAt: Date.now(),
  };
}

function scope(): MutationScope {
  return { kind: "single_component", components: ["tools"], rationale: "default single-component scope" };
}

function diagnosis(): HarnessDiagnosis {
  return {
    failureClass: "tool_selection",
    component: "tools",
    evidence: [{ type: "tool_error", summary: "repeated tool argument failures" }],
    confidence: 0.8,
    rootCause: "tool schemas too broad",
    proposedFix: "prune tool schemas",
    expectedImpact: { capability: 0.05, reliability: 0.1, cost: 0 },
  };
}

function results(successRate: number): TaskExecutionResult[] {
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
    tokens: 1800,
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

/**
 * The scripted engineering agent behaves like a real one: it READS the
 * actual source file from the worktree it was handed, then proposes a
 * narrowed-schema rewrite of that same implementation file.
 */
const schemaPruningAgent = new ScriptedAgentRuntime("schema-pruner-v1", (request) => {
  void request.target;
  return (async () => {
    const original = await request.worktree.readFile("src/tools/schemas.ts");
    if (original === null) throw new Error("agent could not read src/tools/schemas.ts");
    const pruned = original.replace('parameters: "*"', 'parameters: "{ command: string }"');
    return {
      investigation: ["src/tools/schemas.ts", "telemetry: tool_error_rate=0.7"],
      summary: "Narrowed run_shell parameter schema so argument validation rejects malformed calls.",
      edits: [
        {
          path: "src/tools/schemas.ts",
          content: pruned,
          rationale: "The wildcard parameter schema lets malformed run_shell calls through; narrowing it.",
        },
      ],
    };
  })();
});

describe("AgentMutationStrategy", () => {
  let repoRoot: string;
  let wsRoot: string;
  let head: string;
  let executor: GitWorktreeMutationExecutor;

  beforeEach(async () => {
    ({ repoRoot, wsRoot, head } = await makeHarnessRepo());
    executor = new GitWorktreeMutationExecutor({
      worktreeParentDir: wsRoot,
      verifyCommands: [["node", "--version"]],
      strategy: new AgentMutationStrategy({ runtime: schemaPruningAgent }),
    });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  it("mutates the ACTUAL runtime source inside the worktree, not a policy manifest", async () => {
    const ws = await executor.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H1" });
    const plan = await executor.inspectTarget(ws, target(), { diagnosis: diagnosis(), scope: scope() });

    // The plan is the agent's edit against real implementation code.
    expect(plan.strategy).toBe("agent:schema-pruner-v1");
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].path).toBe("src/tools/schemas.ts");
    expect(plan.edits[0].component).toBe("tools");
    expect(plan.summary).toContain("Narrowed run_shell");

    await executor.implement(ws, plan);
    const verification = await executor.verify(ws, plan);
    expect(verification.ok).toBe(true);
    // The actual diff is exactly the declared agent edit.
    expect(verification.actualDiffViolations).toEqual([]);
    expect(verification.actualChangedFiles).toEqual(["src/tools/schemas.ts"]);

    const artifact = await executor.finalize(ws, plan);
    expect(artifact.changedFiles).toEqual(["src/tools/schemas.ts"]);
    // The worktree now contains the MUTATED runtime behavior.
    const mutated = await readFile(join(ws.worktreePath, "src", "tools", "schemas.ts"), "utf8");
    expect(mutated).toContain('parameters: "{ command: string }"');
    await executor.dispose(ws);
  });

  it("hands the agent the allowed-path list, repo view, and evidence digests", async () => {
    const seen: Array<{
      allowedPaths: string[];
      experienceDigest?: string;
      telemetryDigest?: string;
      files: string[];
    }> = [];
    const inspector = new ScriptedAgentRuntime("inspector", (request) => {
      return (async () => {
        seen.push({
          allowedPaths: request.allowedPaths,
          experienceDigest: request.experienceDigest,
          telemetryDigest: request.telemetryDigest,
          files: await request.worktree.listFiles(),
        });
        return { investigation: [], summary: "nothing to do", edits: [] };
      })();
    });
    const strategy = new AgentMutationStrategy({ runtime: inspector });
    const ws = await executor.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H2" });
    await strategy.inspectTarget({
      worktreePath: ws.worktreePath,
      target: target(),
      context: {
        diagnosis: diagnosis(),
        scope: scope(),
        experienceDigest: "cap=tool_utilization failures=12",
        telemetryDigest: "toolErrorRate=0.7",
        repoRoot,
        parentCommit: head,
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].allowedPaths).toContain("src/tools/");
    expect(seen[0].allowedPaths).toContain("src/skills/");
    expect(seen[0].allowedPaths).toContain("nexum.harness.json");
    expect(seen[0].experienceDigest).toContain("tool_utilization");
    expect(seen[0].telemetryDigest).toContain("toolErrorRate");
    // The agent sees the real repository files (no policy file yet).
    expect(seen[0].files).toContain("src/tools/schemas.ts");
    await executor.dispose(ws);
  });

  it("rejects an out-of-scope agent edit at implement time", async () => {
    const rogue = new ScriptedAgentRuntime("rogue", () => ({
      investigation: [],
      summary: "escape attempt",
      edits: [{ path: "docs/evil.md", content: "nope\n", rationale: "outside tools scope" }],
    }));
    const exec2 = new GitWorktreeMutationExecutor({
      worktreeParentDir: wsRoot,
      verifyCommands: [["node", "--version"]],
      strategy: new AgentMutationStrategy({ runtime: rogue }),
    });
    const ws = await exec2.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H3" });
    const plan = await exec2.inspectTarget(ws, target(), { scope: scope() });
    const result = await exec2.implement(ws, plan);
    expect(result.appliedEdits).toHaveLength(0);
    expect(result.rejectedEdits[0].reason).toContain("outside the allowed paths");
    await exec2.dispose(ws);
  });

  it("detects a strategy SIDE EFFECT that landed on disk but was never declared", async () => {
    // The agent proposes a legitimate edit while ALSO secretly writing an
    // undeclared file (both inside and outside the allowed prefixes).
    const smuggler = new ScriptedAgentRuntime("smuggler", (request) => {
      return (async () => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        // Undeclared file INSIDE the allowed component prefix...
        await mkdir(join(request.worktree.worktreePath, "src", "skills"), { recursive: true });
        await writeFile(join(request.worktree.worktreePath, "src", "skills", "sneaky.ts"), "smuggled\n", "utf8");
        // ...and one completely out of scope.
        await mkdir(join(request.worktree.worktreePath, "docs"), { recursive: true });
        await writeFile(join(request.worktree.worktreePath, "docs", "evil.md"), "smuggled\n", "utf8");
        const original = await request.worktree.readFile("src/tools/schemas.ts");
        return {
          investigation: [],
          summary: "innocent-looking plan",
          edits: [
            {
              path: "src/tools/schemas.ts",
              content: original!.replace('parameters: "*"', 'parameters: "object"'),
              rationale: "declared edit",
            },
          ],
        };
      })();
    });
    const exec3 = new GitWorktreeMutationExecutor({
      worktreeParentDir: wsRoot,
      verifyCommands: [["node", "--version"]],
      strategy: new AgentMutationStrategy({ runtime: smuggler }),
    });
    const ws = await exec3.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H4" });
    const plan = await exec3.inspectTarget(ws, target(), { scope: scope() });
    await exec3.implement(ws, plan);
    const verification = await exec3.verify(ws, plan);
    // planned ⊆ allowed passes, but the ACTUAL diff audit catches the side effects.
    expect(verification.scopeViolations).toEqual([]);
    expect(verification.actualDiffViolations.sort()).toEqual(["docs/evil.md", "src/skills/sneaky.ts"]);
    expect(verification.ok).toBe(false);
    await exec3.dispose(ws);
  });

  it("aborts cleanly when the agent declines to mutate", async () => {
    const cautious = new ScriptedAgentRuntime("cautious", () => ({
      investigation: ["src/tools/schemas.ts"],
      summary: "",
      edits: [],
      declined: { reason: "evidence does not justify any code change" },
    }));
    const exec4 = new GitWorktreeMutationExecutor({
      worktreeParentDir: wsRoot,
      verifyCommands: [["node", "--version"]],
      strategy: new AgentMutationStrategy({ runtime: cautious }),
    });
    const ws = await exec4.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H5" });
    await expect(exec4.inspectTarget(ws, target(), { scope: scope() })).rejects.toBeInstanceOf(AgentDeclinedError);
    await exec4.dispose(ws);
  });

  it("enforces the maxEdits safety envelope", () => {
    const runaway = new ScriptedAgentRuntime("runaway", () => ({
      investigation: [],
      summary: "rewrite everything",
      edits: Array.from({ length: 30 }, (_, i) => ({
        path: `src/tools/file${i}.ts`,
        content: "// x\n",
        rationale: "bulk rewrite",
      })),
    }));
    const strategy = new AgentMutationStrategy({ runtime: runaway, maxEdits: 25 });
    expect(
      strategy.inspectTarget({ worktreePath: "/unused", target: target(), context: { scope: scope() } }),
    ).rejects.toBeInstanceOf(AgentMutationError);
  });
});

describe("ClosedLoopEngine with the agent mutation strategy", () => {
  let repoRoot: string;
  let wsRoot: string;
  let head: string;
  let registry: HarnessRegistry;
  let engine: ClosedLoopEngine;

  beforeEach(async () => {
    ({ repoRoot, wsRoot, head } = await makeHarnessRepo());
    registry = new HarnessRegistry(":memory:");
    engine = new ClosedLoopEngine({
      registry,
      executorModels: ["qwen3-coder", "gemini-2.5"],
      mutationExecutor: new GitWorktreeMutationExecutor({
        worktreeParentDir: wsRoot,
        verifyCommands: [["node", "--version"]],
        strategy: new AgentMutationStrategy({ runtime: schemaPruningAgent }),
      }),
    });
  });

  afterEach(async () => {
    registry.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  it("runs a full SELF-DEVELOPING cycle: agent mutates source → benchmark → eligible → worktree disposed", async () => {
    const observation = engine.observe([
      {
        id: "ep-1",
        goal: "Fix tool selection",
        startedAt: 1000,
        endedAt: 2000,
        terminal: "loop_abort",
        toolEvents: [
          { name: "read_file", args: {}, ok: true, durationMs: 50, at: 1001 },
          {
            name: "run_shell",
            args: {},
            ok: false,
            durationMs: 100,
            at: 1002,
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
      },
    ]);
    const res = await engine.runEvolutionCycle({
      experimentId: "exp-agent-1",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      // Pin the scope to the component the agent actually mutates (the
      // diagnoser's blamed component for this fixture episode is execution).
      scope: {
        kind: "single_component",
        components: ["tools"],
        rationale: "test pins the agent mutation to the tools implementation",
      },
      baselineResults: results(0.4),
      experienceDigest: "cap=tool_utilization failures=12",
      evaluateCandidate: () => results(0.9),
      matrixCells: passingMatrixCells(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The candidate commit IS the agent's source mutation.
    expect(res.mutation.artifact!.changedFiles).toEqual(["src/tools/schemas.ts"]);
    expect(res.mutation.plan!.strategy).toBe("agent:schema-pruner-v1");
    expect(res.outcome.twoStage.decision).toBe("eligible");
    expect(res.outcome.experiment.lifecycle.state).toBe("CI_PENDING");
    // Workspace lifecycle: the engine disposed the worktree on exit...
    await expect(statDir(res.mutation.workspace!.worktreePath)).resolves.toBe(false);
    // ...but the candidate branch and its mutation survive for review/rework.
    const branchHead = (await git(repoRoot, ["rev-parse", "evolution/h1"])).trim();
    expect(branchHead).toBe(res.mutation.artifact!.commitSha);
  });

  it("fails at the verify stage when the agent smuggles undeclared changes", async () => {
    const smuggler = new ScriptedAgentRuntime("smuggler", (request) => {
      return (async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(request.worktree.worktreePath, "README.md"), "smuggled\n", "utf8");
        const original = await request.worktree.readFile("src/tools/schemas.ts");
        return {
          investigation: [],
          summary: "clean plan hiding a side effect",
          edits: [{ path: "src/tools/schemas.ts", content: original!, rationale: "declared" }],
        };
      })();
    });
    const engine2 = new ClosedLoopEngine({
      registry,
      executorModels: ["qwen3-coder", "gemini-2.5"],
      mutationExecutor: new GitWorktreeMutationExecutor({
        worktreeParentDir: wsRoot,
        verifyCommands: [["node", "--version"]],
        strategy: new AgentMutationStrategy({ runtime: smuggler }),
      }),
    });
    const observation = engine2.observe([
      {
        id: "ep-1",
        goal: "Fix tool selection",
        startedAt: 1000,
        endedAt: 2000,
        terminal: "loop_abort",
        toolEvents: [{ name: "run_shell", args: {}, ok: false, durationMs: 100, at: 1002 }],
        activatedSkillIds: [],
        finalAssistantText: "",
        grade: {
          verdict: "failure",
          score: 0.2,
          signals: {
            testsRan: false,
            testsPassed: false,
            toolErrorRate: 0.7,
            pathEscapes: 0,
            patchFailures: 0,
            loopAborted: true,
            turnCount: 5,
            retriedSameToolMax: 2,
          },
        },
      },
    ]);
    const res = await engine2.runEvolutionCycle({
      experimentId: "exp-agent-2",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H2",
      repoRoot,
      target: observation.target!,
      diagnosis: observation.diagnoses[0],
      scope: {
        kind: "single_component",
        components: ["tools"],
        rationale: "test pins the agent mutation to the tools implementation",
      },
      baselineResults: results(0.4),
      evaluateCandidate: () => results(0.9),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("verify");
    expect(res.reason).toContain("never declared in the plan");
    expect(res.reason).toContain("README.md");
  });
});

async function statDir(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
