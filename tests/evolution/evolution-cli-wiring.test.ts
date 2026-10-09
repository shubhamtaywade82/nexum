import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentDeclinedError,
  AgentMutationStrategy,
  ScriptedAgentRuntime,
} from "../../src/evolution/mutation/agent-mutation.js";
import { pathWithinAllowedPrefix } from "../../src/evolution/mutation/path-scope.js";
import { GitWorktreeMutationExecutor } from "../../src/evolution/mutation/mutation-executor.js";
import {
  NEXUM_FAST_PROFILE,
  NEXUM_FULL_PROFILE,
  NEXUM_SMOKE_PROFILE,
  verificationProfileByName,
} from "../../src/evolution/mutation/verification-profile.js";
import {
  buildMutationStrategy,
  ingestParentExperience,
  parseBenchmarkJson,
  resolveGithubDeliveryConfig,
  resolveRepoCommit,
  runBenchmarkInDir,
} from "../../src/evolution/cli.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { ExperienceStore } from "../../src/evolution/experience/experience-store.js";
import { Episode } from "../../src/learning/types.js";
import { CliConfig } from "../../src/cli/config.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";
import { MutationScope } from "../../src/evolution/mutation/mutation-scope.js";

const execFileAsync = promisify(execFile);

function cfg(): CliConfig {
  return {
    model: "test-model",
    workspaceRoot: "/tmp/nexum-cli-test",
    tier: "local",
  } as CliConfig;
}

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

describe("evolution CLI production wiring (v2.3.1)", () => {
  describe("buildMutationStrategy", () => {
    it("returns null for the default heuristic strategy", () => {
      expect(buildMutationStrategy(undefined, cfg())).toBeNull();
      expect(buildMutationStrategy("heuristic", cfg())).toBeNull();
    });

    it("wires AgentMutationStrategy backed by the kernel runtime for 'agent'", () => {
      const strategy = buildMutationStrategy("agent", cfg());
      expect(strategy).toBeInstanceOf(AgentMutationStrategy);
      expect(strategy!.name).toBe("agent:nexum-engineering-kernel");
    });

    it("keeps the pre-kernel loop available as 'agent-legacy'", () => {
      const strategy = buildMutationStrategy("agent-legacy", cfg());
      expect(strategy).toBeInstanceOf(AgentMutationStrategy);
      expect(strategy!.name).toBe("agent:nexum-engineering");
    });

    it("throws loudly on unknown strategy names", () => {
      expect(() => buildMutationStrategy("bogus", cfg())).toThrow('Unknown mutation strategy "bogus"');
    });
  });

  describe("resolveGithubDeliveryConfig", () => {
    const BASE = { NEXUM_GITHUB_OWNER: "acme", NEXUM_GITHUB_REPO: "nexum" };

    it("resolves owner/repo with defaults and optional token/base branch", () => {
      expect(resolveGithubDeliveryConfig(BASE)).toEqual({ owner: "acme", repo: "nexum", baseBranch: "main" });
      expect(
        resolveGithubDeliveryConfig({
          ...BASE,
          NEXUM_GITHUB_TOKEN: " t0 ",
          NEXUM_GITHUB_BASE_BRANCH: "develop",
        }),
      ).toEqual({ owner: "acme", repo: "nexum", token: "t0", baseBranch: "develop" });
    });

    it("returns null when owner or repo are missing/blank so --github can report precisely", () => {
      expect(resolveGithubDeliveryConfig({})).toBeNull();
      expect(resolveGithubDeliveryConfig({ NEXUM_GITHUB_OWNER: "acme" })).toBeNull();
      expect(resolveGithubDeliveryConfig({ NEXUM_GITHUB_OWNER: "  ", NEXUM_GITHUB_REPO: "nexum" })).toBeNull();
    });
  });

  describe("parseBenchmarkJson", () => {
    it("maps the benchmark CLI's --json array through toTaskExecutionResult", () => {
      const stdout = [
        JSON.stringify([
          {
            model: "m",
            tier: "local",
            caseId: "case-1",
            category: "tool-calling",
            pass: true,
            latencyMs: 120,
            tokensPerSec: 9.5,
          },
          {
            model: "m",
            tier: "local",
            caseId: "case-2",
            category: "reasoning", // held-out split
            pass: false,
            reason: "wrong answer",
            latencyMs: 80,
            tokensPerSec: null,
          },
          {
            model: "m",
            tier: "local",
            caseId: "case-3",
            pass: false,
            error: "aborted: maxTurns exceeded",
            latencyMs: 10,
            tokensPerSec: null,
          },
        ]),
      ].join("\n");

      const results = parseBenchmarkJson(stdout);
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ taskId: "case-1", success: true, verificationPassed: true, toolErrors: 0 });
      expect(results[1]).toMatchObject({ taskId: "case-2", success: false, isHeldOut: true });
      expect(results[2]).toMatchObject({ taskId: "case-3", loopAborted: true });
    });

    it("throws when the subprocess produced no results array", () => {
      expect(() => parseBenchmarkJson("no json here")).toThrow("no results array");
    });
  });

  describe("runBenchmarkInDir", () => {
    it("fails with a precise error when the harness repository has no toolchain installed", async () => {
      const empty = mkdtempSync(join(tmpdir(), "nexumbench-"));
      try {
        await expect(runBenchmarkInDir(empty, empty, ["tool-calling"])).rejects.toThrow("tsx entry not found");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("verificationProfileByName", () => {
    it("resolves the three tiers; absent name defaults to fast", () => {
      expect(verificationProfileByName()).toBe(NEXUM_FAST_PROFILE);
      expect(verificationProfileByName("smoke")).toBe(NEXUM_SMOKE_PROFILE);
      expect(verificationProfileByName("fast")).toBe(NEXUM_FAST_PROFILE);
      expect(verificationProfileByName("full")).toBe(NEXUM_FULL_PROFILE);
    });

    it("orders the gates: full ⊇ fast ⊇ smoke", () => {
      expect(NEXUM_FAST_PROFILE.commands.length).toBeGreaterThan(NEXUM_SMOKE_PROFILE.commands.length);
      expect(NEXUM_FULL_PROFILE.commands.slice(0, NEXUM_FAST_PROFILE.commands.length)).toEqual(
        NEXUM_FAST_PROFILE.commands,
      );
      expect(NEXUM_FULL_PROFILE.commands.at(-1)).toEqual(["npm", "test"]);
    });

    it("throws loudly on unknown profile names so typos cannot weaken the gate", () => {
      expect(() => verificationProfileByName("quick")).toThrow('Unknown verification profile "quick"');
    });
  });

  describe("pathWithinAllowedPrefix (segment-aware scope)", () => {
    it("accepts exact matches and true descendants", () => {
      expect(pathWithinAllowedPrefix("src/evolution", "src/evolution")).toBe(true);
      expect(pathWithinAllowedPrefix("src/evolution/foo.ts", "src/evolution")).toBe(true);
      expect(pathWithinAllowedPrefix("src/a.ts", "src/")).toBe(true);
      expect(pathWithinAllowedPrefix("src/b/c.ts", "src")).toBe(true);
    });

    it("rejects siblings and file-name overlaps that startsWith admitted", () => {
      expect(pathWithinAllowedPrefix("src/evolution2/foo.ts", "src/evolution")).toBe(false);
      expect(pathWithinAllowedPrefix("src/evolutionfoo.ts", "src/evolution")).toBe(false);
      expect(pathWithinAllowedPrefix("srcx/a.ts", "src")).toBe(false);
    });
  });

  describe("bounded worktree view (semantic inspection budget)", () => {
    function makeWorktree(): string {
      const root = mkdtempSync(join(tmpdir(), "nexumws-"));
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "src-a.ts"), "export const a = 1;\n");
      mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 0;\n");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "bundle.js"), "// build artifact\n");
      mkdirSync(join(root, "srcdir"), { recursive: true });
      writeFileSync(join(root, "srcdir", "deep.ts"), "export const deep = 2;\n");
      return root;
    }

    it("excludes dependency and build directories from list_files", async () => {
      const root = makeWorktree();
      const captured: string[][] = [];
      const recording = new AgentMutationStrategy({
        runtime: new ScriptedAgentRuntime("scripted-recorder", async (request) => {
          captured.push(await request.worktree.listFiles());
          return { edits: [], investigation: [], summary: "listed" };
        }),
      });
      try {
        await recording.inspectTarget({
          worktreePath: root,
          target: mkTarget(),
          context: {
            scope: { kind: "single_component", components: ["tools"], rationale: "t" } as MutationScope,
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      const listed = captured[0];
      expect(listed).toContain("src-a.ts");
      expect(listed).toContain("srcdir/deep.ts");
      expect(listed).not.toContain("node_modules/left-pad/index.js");
      expect(listed.some((f) => f.startsWith("node_modules/"))).toBe(false);
      expect(listed.some((f) => f.startsWith("dist/"))).toBe(false);
    });

    it("caps listing at maxListEntries and truncates reads at maxReadBytes", async () => {
      const root = mkdtempSync(join(tmpdir(), "nexumcap-"));
      // 10 files under one directory; cap listing at 4.
      for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.ts`), `export const v${i} = ${i};\n`);
      writeFileSync(join(root, "big.ts"), "x".repeat(100_000));
      let listed: string[] = [];
      let big: string | null = null;
      const strategy = new AgentMutationStrategy({
        runtime: new ScriptedAgentRuntime("scripted-caps", async (request) => {
          listed = await request.worktree.listFiles();
          big = await request.worktree.readFile("big.ts");
          return { edits: [], investigation: [], summary: "capped" };
        }),
        worktreeViewBounds: { maxListEntries: 4, maxReadBytes: 1024 },
      });
      try {
        await strategy.inspectTarget({
          worktreePath: root,
          target: mkTarget(),
          context: {
            scope: { kind: "single_component", components: ["tools"], rationale: "t" } as MutationScope,
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      expect(listed.length).toBe(4);
      expect(big).toContain("...[truncated at 1024 bytes]");
      expect(big!.length).toBeLessThan(2000);
    });
  });

  describe("GitWorktreeMutationExecutor linkNodeModulesFrom", () => {
    async function makeRepo(withModules: boolean): Promise<string> {
      const root = mkdtempSync(join(tmpdir(), "nexumlnk-"));
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
      writeFileSync(join(root, "README.md"), "repo\n");
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      if (withModules) {
        mkdirSync(join(root, "node_modules"), { recursive: true });
        writeFileSync(join(root, "node_modules", ".marker"), "host toolchain\n");
      }
      return root;
    }

    it("links the host node_modules into the freshly prepared worktree", async () => {
      const repoRoot = await makeRepo(true);
      const executor = new GitWorktreeMutationExecutor({ linkNodeModulesFrom: repoRoot });
      try {
        const ws = await executor.prepareWorkspace({
          repoRoot,
          candidateHarnessId: "H-link",
          parentCommit: "HEAD",
        });
        const link = join(ws.worktreePath, "node_modules");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(existsSync(join(link, ".marker"))).toBe(true);
      } finally {
        await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("leaves the worktree untouched when the option is absent", async () => {
      const repoRoot = await makeRepo(true);
      const executor = new GitWorktreeMutationExecutor({});
      try {
        const ws = await executor.prepareWorkspace({
          repoRoot,
          candidateHarnessId: "H-nolink",
          parentCommit: "HEAD",
        });
        expect(existsSync(join(ws.worktreePath, "node_modules"))).toBe(false);
      } finally {
        await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe("decline path still honors the honest outcome", () => {
    it("AgentDeclinedError carries the decline reason through the strategy", async () => {
      const strategy = new AgentMutationStrategy({
        runtime: new ScriptedAgentRuntime("scripted-decline", () => ({
          edits: [],
          investigation: [],
          summary: "Declined.",
          declined: { reason: "no safe in-scope mutation" },
        })),
      });
      await expect(
        strategy.inspectTarget({
          worktreePath: mkdtempSync(join(tmpdir(), "nexumdec-")),
          target: mkTarget(),
          context: {
            scope: { kind: "single_component", components: ["tools"], rationale: "t" } as MutationScope,
          },
        }),
      ).rejects.toThrow(AgentDeclinedError);
    });
  });

  describe("v2.3.3 production feed + activation helpers", () => {
    async function makeGitRepo(): Promise<{ root: string; head: string }> {
      const root = mkdtempSync(join(tmpdir(), "nexumfeed-"));
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
      writeFileSync(join(root, "README.md"), "repo\n");
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      return { root, head };
    }

    function mkEpisode(id: string, goal: string, verdict: "success" | "failure"): Episode {
      return {
        id,
        goal,
        startedAt: 1,
        endedAt: 2,
        toolEvents: [],
        activatedSkillIds: [],
        terminal: verdict === "success" ? "answered" : "error",
        finalAssistantText: "done",
        grade: {
          score: verdict === "success" ? 0.9 : 0.2,
          signals: {
            testsRan: true,
            testsPassed: verdict === "success",
            toolErrorRate: verdict === "success" ? 0 : 0.5,
            pathEscapes: 0,
            patchFailures: 0,
            loopAborted: false,
            turnCount: 3,
            retriedSameToolMax: 0,
          },
          verdict,
        },
      };
    }

    it("resolveRepoCommit resolves HEAD to the full SHA and null for bogus refs", async () => {
      const { root, head } = await makeGitRepo();
      try {
        await expect(resolveRepoCommit(root, "HEAD")).resolves.toBe(head);
        await expect(resolveRepoCommit(root, "does-not-exist")).resolves.toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("ingestParentExperience writes records keyed by the resolved parent commit, idempotently", async () => {
      const { root, head } = await makeGitRepo();
      const stateDir = mkdtempSync(join(tmpdir(), "nexumexp-"));
      const store = new ExperienceStore(join(stateDir, "experience.db"));
      try {
        const engine = new ClosedLoopEngine({ experienceStore: store });
        const episodes = [
          mkEpisode("ep-1", "fix the broken tool argument validation", "success"),
          mkEpisode("ep-2", "add feature support for streaming output", "failure"),
        ];
        await expect(ingestParentExperience(engine, episodes, root, "HEAD")).resolves.toBe(2);
        expect(store.count()).toBe(2);
        const record = store.getByEpisode("ep-1");
        expect(record).not.toBeNull();
        expect(record!.harnessVersion).toBe(head);
        expect(record!.executorModel).toBe("primary");
        // Idempotent: re-ingesting the same episodes must not duplicate rows.
        await expect(ingestParentExperience(engine, episodes, root, "HEAD")).resolves.toBe(2);
        expect(store.count()).toBe(2);
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("ingestParentExperience is a no-op for empty episode lists", async () => {
      const { root } = await makeGitRepo();
      const stateDir = mkdtempSync(join(tmpdir(), "nexumexp2-"));
      const store = new ExperienceStore(join(stateDir, "experience.db"));
      try {
        const engine = new ClosedLoopEngine({ experienceStore: store });
        await expect(ingestParentExperience(engine, [], root, "HEAD")).resolves.toBe(0);
        expect(store.count()).toBe(0);
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
});
