import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildExperimentArtifact,
  EXPERIMENT_ARTIFACT_SCHEMA_VERSION,
  ExperimentArtifactInput,
  summarizeExperimentRuns,
  writeExperimentArtifact,
} from "../../src/evolution/experiments/experiment-artifact.js";
import { ExperimentController } from "../../src/evolution/experiments/experiment-controller.js";
import { ExperimentStore } from "../../src/evolution/experiments/experiment-store.js";
import { AgentMutationStrategy, ScriptedAgentRuntime } from "../../src/evolution/mutation/agent-mutation.js";
import { GitWorktreeMutationExecutor } from "../../src/evolution/mutation/mutation-executor.js";
import { MutationScope } from "../../src/evolution/mutation/mutation-scope.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";
import { HarnessDiagnosis } from "../../src/evolution/types.js";
import { TaskExecutionResult } from "../../src/evolution/evaluator.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { ExperienceStore } from "../../src/evolution/experience/experience-store.js";

const execFileAsync = promisify(execFile);

function mkTarget(): ImprovementTarget {
  return {
    id: "t-1",
    capability: "tool_utilization",
    desiredOutcome: "reduce tool argument validation failures",
    observableSymptoms: ["run_shell argument validation failed"],
    measurableMetrics: ["toolErrorRate"],
    affectedComponents: ["tools"],
    confidence: 0.8,
    evaluationPlan: { successCriterion: "toolErrorRate decreases", steps: [], executorModels: ["primary"] },
  };
}

function mkDiagnosis(): HarnessDiagnosis {
  return {
    component: "tools",
    failureClass: "argument_validation",
    rootCause: "Tool arguments were accepted without schema validation.",
    proposedFix: "Tighten the helper validation path.",
    confidence: 0.75,
    expectedImpact: { capability: 0.2, reliability: 0.15 },
  };
}

function mkScope(): MutationScope {
  return { kind: "single_component", components: ["tools"], rationale: "single failing subsystem" };
}

function mkRun(taskId: string, success: boolean, isHeldOut = false): TaskExecutionResult {
  return {
    taskId,
    success,
    verificationPassed: success,
    toolCalls: 4,
    toolErrors: success ? 0 : 1,
    tokens: 100,
    latencyMs: 10,
    loopAborted: false,
    isHeldOut,
  };
}

function baseInput(overrides: Partial<ExperimentArtifactInput> = {}): ExperimentArtifactInput {
  return {
    experimentId: "exp-test-1",
    strategyName: "agent",
    model: "test-model",
    tier: "local",
    verifyProfileName: "fast",
    benchmarkCategories: ["tool-calling"],
    baselineAbsent: false,
    target: mkTarget(),
    diagnosis: mkDiagnosis(),
    scope: mkScope(),
    record: null,
    mutation: {},
    baselineResults: [],
    candidateResults: [],
    github: null,
    localDelivery: null,
    failure: null,
    ...overrides,
  };
}

describe("experiment artifacts (v2.3.2)", () => {
  describe("summarizeExperimentRuns", () => {
    it("computes the aggregate metrics over raw runs", () => {
      const summary = summarizeExperimentRuns([
        mkRun("r1", true),
        { ...mkRun("r2", true), verificationPassed: false },
        { ...mkRun("r3", false, true), loopAborted: true },
      ]);
      expect(summary.runs).toBe(3);
      expect(summary.taskSuccessRate).toBeCloseTo(2 / 3);
      expect(summary.verificationPassRate).toBeCloseTo(1 / 3);
      expect(summary.falseSuccessRate).toBeCloseTo(1 / 3);
      expect(summary.loopAbortRate).toBeCloseTo(1 / 3);
      expect(summary.toolErrorRate).toBeCloseTo(1 / 12);
      expect(summary.avgTokens).toBe(100);
      expect(summary.avgLatencyMs).toBe(10);
      expect(summary.runsDetail).toHaveLength(3);
      expect(summary.runsDetail[2].isHeldOut).toBe(true);
    });
  });

  describe("writeExperimentArtifact", () => {
    it("writes a self-hashed envelope (detects accidental edits; not tamper-proof)", () => {
      const dir = mkdtempSync(join(tmpdir(), "nexumart-"));
      try {
        const envelope = buildExperimentArtifact(
          baseInput({ failure: { stage: "evaluate", reason: "benchmark failed" } }),
        );
        const path = writeExperimentArtifact(dir, envelope);
        expect(existsSync(path)).toBe(true);
        expect(path.endsWith(`${envelope.experimentId}.json`)).toBe(true);

        const parsed = JSON.parse(readFileSync(path, "utf8"));
        expect(parsed.kind).toBe("nexum-experiment-artifact");
        expect(parsed.schemaVersion).toBe(EXPERIMENT_ARTIFACT_SCHEMA_VERSION);
        const expectedHash = createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
        expect(parsed.integrity).toEqual({ algorithm: "sha256", hash: expectedHash });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses to overwrite an existing artifact (wx)", () => {
      const dir = mkdtempSync(join(tmpdir(), "nexumart2-"));
      try {
        const envelope = buildExperimentArtifact(baseInput());
        writeExperimentArtifact(dir, envelope);
        expect(() => writeExperimentArtifact(dir, envelope)).toThrow(/EEXIST/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("buildExperimentArtifact", () => {
    it("composes the full scientific tree for a successful cycle", () => {
      const controller = new ExperimentController();
      controller.startExperiment({
        id: "exp-full-1",
        parentHarness: "HEAD",
        parentCommit: "abc123",
        candidateHarness: "H1",
        candidateCommit: "def456",
        targetId: "t-1",
        targetCapability: "tool_utilization",
        desiredOutcome: "reduce tool argument validation failures",
        hypothesisId: "h-1",
        hypothesisStatement: "Tightening helper validation reduces tool errors.",
        predictedEffect: "toolErrorRate -20%",
        executorPrimary: "primary",
        executorTransfer: [],
        scopeComponents: ["tools"],
      });
      controller.reportEvaluation(
        "exp-full-1",
        { visible: { taskSuccessRate: 1 }, held_out: { heldOutScore: 1 }, transfer: {} },
        { capability: 1, reliability: 0, efficiency: 0, generalization: 1 },
      );
      controller.reportDecision("exp-full-1", {
        result: "eligible",
        stageA: "valid",
        stageB: "improved",
        rationale: "Capability improved beyond threshold.",
      });
      const record = controller.record("exp-full-1");

      const plan = {
        planId: "p-1",
        targetId: "t-1",
        summary: "Tighten helper validation.",
        strategy: "agent:nexum-engineering",
        edits: [
          {
            path: "src/tools/helper.ts",
            content: "export const helper = (): number => 1;\n",
            component: "tools" as const,
            rationale: "validate arguments",
          },
        ],
        createdAt: Date.now(),
      };
      const envelope = buildExperimentArtifact(
        baseInput({
          experimentId: "exp-full-1",
          record,
          mutation: {
            plan,
            result: { appliedEdits: [plan.edits[0]], rejectedEdits: [], diffStat: " 1 file changed" },
            verification: {
              ok: true,
              scopeRespected: true,
              scopeViolations: [],
              actualDiffViolations: [],
              actualChangedFiles: ["src/tools/helper.ts"],
              commands: [{ command: "npx tsc --noEmit", exitCode: 0, output: "x".repeat(3000) }],
            },
            artifact: {
              workspace: {
                workspaceId: "ws-1",
                repoRoot: "/repo",
                worktreePath: "/repo/.worktrees/H1",
                branchName: "evolution/h1",
                parentCommit: "abc123",
                candidateHarnessId: "H1",
                createdAt: Date.now(),
              },
              branchName: "evolution/h1",
              commitSha: "def456",
              commitMessage: "mutate",
              diffStat: " 1 file changed",
              changedFiles: ["src/tools/helper.ts"],
              plan,
            },
          },
          baselineResults: [mkRun("b1", false), mkRun("b2", false, true), mkRun("b3", false), mkRun("b4", false)],
          candidateResults: [mkRun("c1", true), mkRun("c2", true, true), mkRun("c3", true), mkRun("c4", true)],
          github: {
            branch: "evolution/h1",
            prNumber: 7,
            prUrl: "https://github.com/acme/nexum/pull/7",
            ciPassed: true,
            accepted: true,
            merged: true,
          },
        }),
      );

      const p = envelope.payload;
      // The user-facing tree, top to bottom.
      expect(p.target!.capability).toBe("tool_utilization");
      expect(p.diagnosis!.rootCause).toContain("schema validation");
      expect(p.hypothesis!.statement).toContain("Tightening helper validation");
      expect(p.model).toMatchObject({
        strategy: "agent",
        model: "test-model",
        tier: "local",
        executorPrimary: "primary",
      });
      expect(p.executor).toMatchObject({ kind: "git-worktree", verifyProfile: "fast" });
      expect(p.scope!.components).toEqual(["tools"]);
      expect(p.proposals!.edits[0].bytes).toBe(Buffer.byteLength(plan.edits[0].content, "utf8"));
      expect(p.changedFiles).toMatchObject({ commitSha: "def456", branchName: "evolution/h1" });
      expect(p.changedFiles!.files).toEqual(["src/tools/helper.ts"]);
      expect(p.verification!.ok).toBe(true);
      expect(p.verification!.commands[0].outputTail).toContain("...[truncated]");
      expect(p.baselineMetrics!.runs).toBe(4);
      expect(p.baselineMetrics!.taskSuccessRate).toBe(0);
      expect(p.candidateMetrics!.taskSuccessRate).toBe(1);
      expect(p.heldOutMetrics).toEqual({ heldOutScore: 1 });
      expect(p.delivery).toMatchObject({ mode: "github", prNumber: 7, merged: true });
      expect(p.ci!.status).toBe("pending");
      expect(p.review!.state).toBe("pending");
      expect(p.decision.verdict).toBe("eligible");
      expect(p.decision.stageA).toBe("valid");
      expect(p.decision.stageB).toBe("improved");
      expect(p.benchmark.evaluator).toContain("subprocess");
    });

    it("records stage failures as first-class scientific results", () => {
      const plan = {
        planId: "p-2",
        targetId: "t-1",
        summary: "s",
        strategy: "heuristic",
        edits: [],
        createdAt: Date.now(),
      };
      const envelope = buildExperimentArtifact(
        baseInput({
          experimentId: "exp-fail-1",
          baselineAbsent: true,
          mutation: { plan },
          failure: { stage: "verify", reason: "Mutation verification failed: npx tsc --noEmit (exit 2)" },
        }),
      );
      const p = envelope.payload;
      expect(p.decision.verdict).toBe("failed");
      expect(p.decision.failedStage).toBe("verify");
      expect(p.decision.rationale).toContain("exit 2");
      expect(p.proposals!.planId).toBe("p-2");
      expect(p.verification).toBeNull();
      expect(p.baselineMetrics).toBeNull();
      expect(p.candidateMetrics!.runs).toBe(0);
      expect(p.delivery.mode).toBe("none");
      expect(p.ci).toBeNull();
      expect(p.hypothesis).toBeNull();
    });
  });

  describe("end-to-end: mutate cycle persists record + artifact", () => {
    async function makeRepo(): Promise<string> {
      const root = mkdtempSync(join(tmpdir(), "nexumexp-"));
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
      writeFileSync(join(root, "README.md"), "repo\n");
      mkdirSync(join(root, "src", "tools"), { recursive: true });
      writeFileSync(join(root, "src", "tools", "helper.ts"), "export const helper = (): number => 0;\n");
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      return root;
    }

    it("a full cycle lands in the SQLite store AND the immutable JSON artifact", async () => {
      const repoRoot = await makeRepo();
      const stateDir = mkdtempSync(join(tmpdir(), "nexumexpstate-"));
      const experimentDir = join(stateDir, "experiments");
      const experimentStore = new ExperimentStore(join(stateDir, "experiments.db"));
      const experienceStore = new ExperienceStore(join(stateDir, "experience.db"));
      const controller = new ExperimentController({ store: experimentStore });
      const engine = new ClosedLoopEngine({
        experienceStore,
        experimentController: controller,
        mutationExecutor: new GitWorktreeMutationExecutor({
          verifyCommands: [["node", "--version"]],
          strategy: new AgentMutationStrategy({
            runtime: new ScriptedAgentRuntime("scripted-e2e", async () => ({
              edits: [
                {
                  path: "src/tools/helper.ts",
                  content: "export const helper = (): number => 1;\n",
                  rationale: "tighten helper behavior for tool validation",
                },
              ],
              investigation: ["src/tools/helper.ts"],
              summary: "Improve helper validation.",
            })),
          }),
        }),
      });

      try {
        const outcome = await engine.runEvolutionCycle({
          experimentId: "exp-e2e-1",
          parentHarnessId: "HEAD",
          parentCommit: "HEAD",
          candidateHarnessId: "H-e2e",
          repoRoot,
          target: mkTarget(),
          diagnosis: mkDiagnosis(),
          scope: mkScope(),
          baselineResults: [mkRun("b1", false), mkRun("b2", false, true), mkRun("b3", false), mkRun("b4", false)],
          evaluateCandidate: async () => [
            mkRun("c1", true),
            mkRun("c2", true, true),
            mkRun("c3", true),
            mkRun("c4", true),
          ],
        });
        expect(outcome.ok).toBe(true);

        // 1. The record is persisted (previously lost at process exit).
        const stored = experimentStore.get("exp-e2e-1");
        expect(stored).not.toBeNull();
        expect(stored!.candidate.harness).toBe("H-e2e");
        expect(stored!.candidate.commit).not.toBe("");
        expect(["eligible", "rejected", "inconclusive"]).toContain(stored!.decision.result);

        // 2. The immutable artifact agrees with the stored record.
        const envelope = buildExperimentArtifact(
          baseInput({
            experimentId: "exp-e2e-1",
            record: stored!,
            mutation: {
              plan: outcome.ok ? outcome.mutation.plan : undefined,
              result: outcome.ok ? outcome.mutation.result : undefined,
              verification: outcome.ok ? outcome.mutation.verification : undefined,
              artifact: outcome.ok ? outcome.mutation.artifact : undefined,
            },
            baselineResults: [mkRun("b1", false), mkRun("b2", false, true), mkRun("b3", false), mkRun("b4", false)],
            candidateResults: [mkRun("c1", true), mkRun("c2", true, true), mkRun("c3", true), mkRun("c4", true)],
            strategyName: "agent",
          }),
        );
        const path = writeExperimentArtifact(experimentDir, envelope);
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        expect(parsed.payload.decision.verdict).toBe(stored!.decision.result);
        expect(parsed.payload.changedFiles.files).toContain("src/tools/helper.ts");
        expect(parsed.payload.lifecycle.state).toBe(stored!.lifecycle.state);
        const expectedHash = createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
        expect(parsed.integrity.hash).toBe(expectedHash);
      } finally {
        experimentStore.close();
        experienceStore.close();
        await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe("activation record (v2.3.3)", () => {
    const baseInput = (): ExperimentArtifactInput => ({
      experimentId: "exp-act",
      strategyName: "agent",
      model: "test-model",
      tier: "local",
      verifyProfileName: "fast",
      benchmarkCategories: ["execution"],
      baselineAbsent: true,
      target: null,
      diagnosis: null,
      scope: null,
      record: null,
      mutation: {},
      baselineResults: [],
      candidateResults: [],
    });

    it("carries the runtime activation outcome when provided", () => {
      const envelope = buildExperimentArtifact({
        ...baseInput(),
        failure: { stage: "implement", reason: "declined" },
        activation: {
          controller: "manifest-file-runtime",
          harnessId: "H1",
          commitSha: "a".repeat(40),
          activatedAt: 1234,
          ok: true,
        },
      });
      expect(envelope.payload.activation).toEqual({
        controller: "manifest-file-runtime",
        harnessId: "H1",
        commitSha: "a".repeat(40),
        activatedAt: 1234,
        ok: true,
      });
    });

    it("records honest activation skips and stays null without the flag", () => {
      const skipped = buildExperimentArtifact({
        ...baseInput(),
        failure: { stage: "evaluate", reason: "no benchmark" },
        activation: {
          controller: "manifest-file-runtime",
          harnessId: "H1",
          commitSha: "",
          activatedAt: 5,
          ok: false,
          error: "experiment not ACTIVE (activation requires --github delivery with CI passed + review approved)",
        },
      });
      expect(skipped.payload.activation!.ok).toBe(false);
      expect(skipped.payload.activation!.error).toContain("not ACTIVE");

      const absent = buildExperimentArtifact(baseInput());
      expect(absent.payload.activation).toBeNull();
    });
  });
});
