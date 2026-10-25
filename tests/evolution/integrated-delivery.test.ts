import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { GitWorktreeMutationExecutor } from "../../src/evolution/mutation/mutation-executor.js";
import {
  GitHubDeliveryAdapter,
  GitHubHttpClient,
  GitCommandRunner,
} from "../../src/evolution/delivery/github-adapter.js";
import { HarnessRegistry } from "../../src/evolution/registry.js";
import { TaskExecutionResult } from "../../src/evolution/evaluator.js";
import { Episode } from "../../src/learning/types.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  return res.stdout;
}

async function makeRepo(): Promise<{ repoRoot: string; wsRoot: string; head: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "delivrepo-"));
  await mkdir(join(repoRoot, "src", "tools"), { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", repoRoot]);
  await writeFile(join(repoRoot, "src", "tools", "index.ts"), "export const tools = 1;\n", "utf8");
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["commit", "-q", "-m", "init"]);
  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const wsRoot = await mkdtemp(join(tmpdir(), "delivws-"));
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
    tokens: 1900,
    latencyMs: 900,
    loopAborted: false,
    isHeldOut,
  }));
}

interface RecordedCall {
  method: string;
  path: string;
}

/**
 * Fake GitHub API + git transport. Git runs REAL for local plumbing
 * (rev-parse) so the handle's head sha is the actual candidate commit; only
 * `push` is simulated. HTTP is a scripted api.github.com.
 */
function makeFakes(options: {
  checkRuns?: Array<{ name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null }>;
  reviews?: Array<{ state: string; user?: { login?: string }; submitted_at?: string }>;
  mergeStatus?: number;
  prStatus?: number;
}): { runGit: GitCommandRunner; http: GitHubHttpClient; calls: RecordedCall[]; pushedRefs: string[] } {
  const calls: RecordedCall[] = [];
  const pushedRefs: string[] = [];
  // The head the adapter resolved last. Reviews are bound to it, as GitHub binds a review to a commit.
  let headSha = "";
  const runGit: GitCommandRunner = async (args, cwd) => {
    if (args.includes("push")) {
      pushedRefs.push(args[args.length - 1]);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    try {
      // The adapter passes bare subcommands ("rev-parse", ...); run real git.
      const argv = args[0] === "git" ? args.slice(1) : args;
      const res = await exec("git", argv, { cwd, maxBuffer: 1024 * 1024 });
      if (argv.includes("rev-parse")) headSha = res.stdout.trim();
      return { stdout: res.stdout, stderr: res.stderr ?? "", exitCode: 0 };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      if (typeof e.code === "number") return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
      throw err;
    }
  };
  const http: GitHubHttpClient = async (path, init) => {
    calls.push({ method: init?.method ?? "GET", path });
    if (path.endsWith("/pulls") && init?.method === "POST") {
      return {
        status: options.prStatus ?? 201,
        json: { number: 42, html_url: "https://github.com/nexum/harness/pull/42" },
      };
    }
    if (path.includes("/check-runs")) {
      return { status: 200, json: { check_runs: options.checkRuns ?? [] } };
    }
    if (path.includes("/reviews")) {
      return { status: 200, json: (options.reviews ?? []).map((review) => ({ ...review, commit_id: headSha })) };
    }
    if (path.endsWith("/merge")) {
      return { status: options.mergeStatus ?? 200, json: { merged: true } };
    }
    return { status: 404, json: { message: "not found" } };
  };
  return { runGit, http, calls, pushedRefs };
}

describe("ClosedLoopEngine integrated GitHub delivery (canonical production path)", () => {
  let repoRoot: string;
  let wsRoot: string;
  let head: string;
  let registry: HarnessRegistry;

  beforeEach(async () => {
    ({ repoRoot, wsRoot, head } = await makeRepo());
    registry = new HarnessRegistry(":memory:");
    registry.saveVersion({
      id: "H0",
      commitSha: head,
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
  });

  afterEach(async () => {
    registry.close();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
  });

  function makeEngine(fakes: ReturnType<typeof makeFakes>): ClosedLoopEngine {
    const adapter = new GitHubDeliveryAdapter(
      { owner: "nexum", repo: "harness", baseBranch: "main", pollIntervalMs: 1, checksTimeoutMs: 5000 },
      { runGit: fakes.runGit, http: fakes.http },
    );
    return new ClosedLoopEngine({
      registry,
      executorModels: ["qwen3-coder"],
      githubDelivery: adapter,
      mutationExecutor: new GitWorktreeMutationExecutor({
        worktreeParentDir: wsRoot,
        verifyCommands: [["node", "--version"]],
      }),
    });
  }

  function observation(engine: ClosedLoopEngine) {
    const obs = engine.observe([failureEpisode("ep-1", "Fix tool selection")]);
    expect(obs.target).not.toBeNull();
    expect(obs.mutationScope).not.toBeNull();
    return obs;
  }

  it("walks the FULL canonical path: mutation → PR → CI green → approved → ACTIVE → merged", async () => {
    const fakes = makeFakes({
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      reviews: [{ state: "APPROVED", user: { login: "maintainer" }, submitted_at: "2026-01-01T00:00:00Z" }],
    });
    const engine = makeEngine(fakes);
    const obs = observation(engine);

    const res = await engine.runEvolutionCycle({
      experimentId: "exp-gh-1",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: obs.target!,
      diagnosis: obs.diagnoses[0],
      scope: obs.mutationScope!,
      baselineResults: results(0.4),
      evaluateCandidate: () => results(0.9),
      github: {},
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The PR was created against the ACTUAL mutation branch, and the push
    // carried the real candidate commit.
    expect(res.github).toBeDefined();
    expect(res.github!.handle.branch).toBe(res.mutation.artifact!.branchName);
    expect(res.github!.handle.branch).toBe("evolution/h1");
    expect(res.github!.handle.headSha).toBe(res.mutation.artifact!.commitSha);
    expect(fakes.pushedRefs).toEqual(["HEAD:refs/heads/evolution/h1"]);
    expect(fakes.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(true);

    // CI green → review approved → accepted → merged, all inside the cycle.
    expect(res.github!.ci.passed).toBe(true);
    expect(res.github!.review?.state).toBe("approved");
    expect(res.github!.review?.reviewer).toBe("maintainer");
    expect(res.github!.accepted).toBe(true);
    expect(res.github!.merged).toBe(true);

    // Lifecycle completed the whole path inside one cycle.
    const record = engine.experiments.record("exp-gh-1");
    expect(record.lifecycle.state).toBe("ACTIVE");
    const states = engine.experiments
      .machine("exp-gh-1")
      .transitions()
      .map((t) => t.to);
    expect(states).toEqual([
      "DIAGNOSED",
      "TARGETED",
      "HYPOTHESIS",
      "CANDIDATE",
      "EVALUATING",
      "VALIDATED",
      "GENERALIZED",
      "ELIGIBLE",
      "DELIVERED",
      "CI_PENDING",
      "CI_PASSED",
      "REVIEW_PENDING",
      "APPROVED",
      "ACCEPTED",
      "ACTIVE",
    ]);
    // Registry promoted the candidate; the worktree was disposed afterwards.
    expect(registry.getActiveVersion()?.id).toBe("H1");
    await expect(statDir(res.mutation.workspace!.worktreePath)).resolves.toBe(false);
  });

  it("stops at CI_FAILED when GitHub CI is red: no review, no acceptance, rework available", async () => {
    const fakes = makeFakes({
      checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
    });
    const engine = makeEngine(fakes);
    const obs = observation(engine);

    const res = await engine.runEvolutionCycle({
      experimentId: "exp-gh-2",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: obs.target!,
      diagnosis: obs.diagnoses[0],
      scope: obs.mutationScope!,
      baselineResults: results(0.4),
      evaluateCandidate: () => results(0.9),
      github: {},
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.github!.ci.passed).toBe(false);
    expect(res.github!.review).toBeNull();
    expect(res.github!.accepted).toBe(false);
    expect(res.github!.merged).toBe(false);
    expect(engine.experiments.record("exp-gh-2").lifecycle.state).toBe("CI_FAILED");
    // The failure path left no review calls behind.
    expect(fakes.calls.some((c) => c.path.includes("/reviews"))).toBe(false);

    // The loop can re-enter from the failure state.
    expect(engine.beginRework("exp-gh-2")).toBe(true);
    expect(engine.experiments.record("exp-gh-2").lifecycle.state).toBe("CANDIDATE");
  });

  it("stops at CHANGES_REQUESTED when review demands rework", async () => {
    const fakes = makeFakes({
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      reviews: [{ state: "CHANGES_REQUESTED", user: { login: "maintainer" }, submitted_at: "2026-01-01T00:00:00Z" }],
    });
    const engine = makeEngine(fakes);
    const obs = observation(engine);

    const res = await engine.runEvolutionCycle({
      experimentId: "exp-gh-3",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: obs.target!,
      diagnosis: obs.diagnoses[0],
      scope: obs.mutationScope!,
      baselineResults: results(0.4),
      evaluateCandidate: () => results(0.9),
      github: {},
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.github!.ci.passed).toBe(true);
    expect(res.github!.review?.state).toBe("changes_requested");
    expect(res.github!.accepted).toBe(false);
    expect(engine.experiments.record("exp-gh-3").lifecycle.state).toBe("CHANGES_REQUESTED");
    expect(engine.beginRework("exp-gh-3")).toBe(true);
  });

  it("stays honestly at CI_PENDING when the CI poll times out (no fake success)", async () => {
    const fakes = makeFakes({
      checkRuns: [{ name: "build", status: "in_progress", conclusion: null }],
    });
    const engine = makeEngine(fakes);
    const obs = observation(engine);

    const res = await engine.runEvolutionCycle({
      experimentId: "exp-gh-4",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: obs.target!,
      diagnosis: obs.diagnoses[0],
      scope: obs.mutationScope!,
      baselineResults: results(0.4),
      evaluateCandidate: () => results(0.9),
      github: { checksTimeoutMs: 10 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.github!.ci.passed).toBeNull();
    expect(res.github!.ci.pending).toBe(true);
    expect(res.github!.review).toBeNull();
    expect(res.github!.accepted).toBe(false);
    expect(engine.experiments.record("exp-gh-4").lifecycle.state).toBe("CI_PENDING");
  });

  it("does not deliver when the candidate is not eligible (rejected by the gates)", async () => {
    const fakes = makeFakes({});
    const engine = makeEngine(fakes);
    const obs = observation(engine);

    const res = await engine.runEvolutionCycle({
      experimentId: "exp-gh-5",
      parentHarnessId: "H0",
      parentCommit: head,
      candidateHarnessId: "H1",
      repoRoot,
      target: obs.target!,
      diagnosis: obs.diagnoses[0],
      scope: obs.mutationScope!,
      // Candidate performs WORSE than baseline → Stage B rejects.
      baselineResults: results(0.9),
      evaluateCandidate: () => results(0.4),
      github: {},
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.outcome.twoStage.decision).toBe("rejected");
    expect(res.outcome.delivery).toBeNull();
    expect(res.github).toBeUndefined();
    expect(fakes.calls).toEqual([]);
    expect(fakes.pushedRefs).toEqual([]);
    expect(engine.experiments.record("exp-gh-5").lifecycle.state).toBe("REJECTED");
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
