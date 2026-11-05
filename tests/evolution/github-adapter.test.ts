import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubDeliveryAdapter,
  GitCommandRunner,
  GitHubHttpClient,
} from "../../src/evolution/delivery/github-adapter.js";
import { ExperimentController } from "../../src/evolution/experiments/experiment-controller.js";
import { DeliveryReport } from "../../src/evolution/delivery.js";
import { StartExperimentInput } from "../../src/evolution/experiments/experiment-controller.js";

function startInput(over: Partial<StartExperimentInput> = {}): StartExperimentInput {
  return {
    id: "exp-gh-1",
    parentHarness: "H0",
    parentCommit: "abc123",
    candidateHarness: "H1",
    candidateCommit: "def456",
    targetId: "target-tools-1",
    targetCapability: "tool_utilization",
    desiredOutcome: "Tool error rate drops",
    hypothesisId: "hyp-1",
    hypothesisStatement: "Pruning schemas reduces tool errors",
    predictedEffect: "reliability +10%",
    executorPrimary: "qwen3-coder",
    executorTransfer: ["gemini-2.5"],
    ...over,
  };
}

function report(): DeliveryReport {
  return {
    branchName: "evolution/h1-tools",
    commitMessage: "feat(evolution): candidate H1",
    prTitle: "feat(evolution): tool utilization improvement [H1]",
    prBody: "## experiment\n\n```yaml\nid: exp-gh-1\n```",
  };
}

/** In-memory git runner: records commands, fakes rev-parse/push output. */
function fakeGit(pushFails = false): { runner: GitCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitCommandRunner = async (args) => {
    calls.push(args);
    if (args.includes("rev-parse")) return { stdout: "cafe1234\n", exitCode: 0, stderr: "" };
    if (args.includes("push")) {
      return pushFails
        ? { stdout: "", exitCode: 128, stderr: "failed to push" }
        : { stdout: "", exitCode: 0, stderr: "" };
    }
    return { stdout: "", exitCode: 0, stderr: "" };
  };
  return { runner, calls };
}

type HttpHandler = (path: string, init?: { method?: string; body?: unknown }) => { status: number; json: unknown };

function fakeHttp(handler: HttpHandler): {
  client: GitHubHttpClient;
  requests: Array<{ path: string; method?: string; body?: unknown }>;
} {
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const client: GitHubHttpClient = async (path, init) => {
    requests.push({ path, method: init?.method, body: init?.body });
    return handler(path, init);
  };
  return { client, requests };
}

const NO_SLEEP = async () => undefined;

describe("GitHubDeliveryAdapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gh-adapter-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("commits, pushes, and opens a PR carrying the provenance body", async () => {
    const { runner, calls } = fakeGit();
    const { client, requests } = fakeHttp((path) => {
      if (path.endsWith("/pulls")) {
        return { status: 201, json: { number: 42, html_url: "https://github.com/o/r/pull/42" } };
      }
      return { status: 404, json: { message: "not found" } };
    });
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", token: "t", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    const handle = await adapter.deliverExperiment({ worktreePath: tmpDir, report: report(), alreadyCommitted: true });

    expect(handle).toEqual({
      branch: "evolution/h1-tools",
      headSha: "cafe1234",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
    });
    // alreadyCommitted → no add/commit; push targets the evolution branch.
    expect(calls.some((a) => a.includes("commit"))).toBe(false);
    const push = calls.find((a) => a.includes("push"));
    expect(push).toBeDefined();
    expect(push!.some((arg) => arg.includes("refs/heads/evolution/h1-tools"))).toBe(true);
    const prReq = requests.find((r) => r.path.endsWith("/pulls") && r.method === "POST");
    expect(prReq).toBeDefined();
    expect((prReq!.body as Record<string, unknown>).base).toBe("main");
    expect((prReq!.body as Record<string, unknown>).body).toContain("id: exp-gh-1");
  });

  it("commits pending changes when the mutation has not been finalized", async () => {
    const { runner, calls } = fakeGit();
    const { client } = fakeHttp(() => ({ status: 201, json: { number: 7, html_url: "u" } }));
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    await adapter.deliverExperiment({ worktreePath: tmpDir, report: report() });
    expect(calls.some((a) => a.includes("add") && a.includes("-A"))).toBe(true);
    expect(calls.some((a) => a.includes("commit") && a.includes("feat(evolution): candidate H1"))).toBe(true);
  });

  it("syncs a failed CI verdict into the experiment lifecycle", async () => {
    const { runner } = fakeGit();
    const { client } = fakeHttp((path) => {
      if (path.includes("/check-runs")) {
        return {
          status: 200,
          json: {
            check_runs: [
              { name: "Build & Test", status: "completed", conclusion: "failure", html_url: "https://ci/run/1" },
            ],
          },
        };
      }
      return { status: 200, json: {} };
    });
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    const controller = new ExperimentController();
    controller.startExperiment(startInput());
    walkToDelivered(controller, "exp-gh-1");

    const verdict = await adapter.syncCiFeedback(controller, "exp-gh-1", "sha");
    expect(verdict.passed).toBe(false);
    expect(verdict.failedRuns).toEqual(["Build & Test"]);
    expect(controller.record("exp-gh-1").lifecycle.state).toBe("CI_FAILED");
    expect(controller.record("exp-gh-1").ci.status).toBe("failed");
  });

  it("syncs a passing CI verdict (→ CI_PASSED → REVIEW_PENDING) and review approval (→ APPROVED)", async () => {
    const { runner } = fakeGit();
    const { client } = fakeHttp((path) => {
      if (path.includes("/check-runs")) {
        return {
          status: 200,
          json: {
            check_runs: [
              { name: "CI", status: "completed", conclusion: "success", html_url: "https://ci/run/2" },
              { name: "GitGuardian", status: "completed", conclusion: "skipped" },
            ],
          },
        };
      }
      if (path.includes("/reviews")) {
        return {
          status: 200,
          json: [
            {
              state: "CHANGES_REQUESTED",
              commit_id: "sha",
              user: { login: "r1" },
              submitted_at: "2026-01-01T00:00:00Z",
            },
            { state: "APPROVED", commit_id: "sha", user: { login: "r2" }, submitted_at: "2026-01-02T00:00:00Z" },
          ],
        };
      }
      return { status: 200, json: {} };
    });
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    const controller = new ExperimentController();
    controller.startExperiment(startInput());
    walkToDelivered(controller, "exp-gh-1");

    const ci = await adapter.syncCiFeedback(controller, "exp-gh-1", "sha");
    expect(ci.passed).toBe(true);
    expect(controller.record("exp-gh-1").lifecycle.state).toBe("REVIEW_PENDING");

    const review = await adapter.syncReviewFeedback(controller, "exp-gh-1", 42, "sha");
    expect(review.state).toBe("approved");
    expect(review.reviewer).toBe("r2"); // LATEST review wins
    expect(controller.record("exp-gh-1").lifecycle.state).toBe("APPROVED");
  });

  it("does not accept an approval of an earlier commit, since it does not cover the code that would merge", async () => {
    const { runner } = fakeGit();
    const { client } = fakeHttp((path) => {
      if (path.includes("/reviews")) {
        return {
          status: 200,
          json: [
            { state: "APPROVED", commit_id: "older-sha", user: { login: "r2" }, submitted_at: "2026-01-02T00:00:00Z" },
          ],
        };
      }
      return { status: 200, json: {} };
    });
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    const controller = new ExperimentController();
    controller.startExperiment(startInput());
    walkToDelivered(controller, "exp-gh-1");
    const stateBefore = controller.record("exp-gh-1").lifecycle.state;

    const review = await adapter.syncReviewFeedback(controller, "exp-gh-1", 42, "sha");
    expect(review.state).toBe("pending");
    expect(controller.record("exp-gh-1").lifecycle.state).toBe(stateBefore);
  });

  it("pins the merge to the reviewed head sha, so a commit pushed after approval is not merged unreviewed", async () => {
    const { runner } = fakeGit();
    const { client, requests } = fakeHttp(() => ({ status: 200, json: { merged: true } }));
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );

    expect(await adapter.mergePullRequest(42, "reviewed-sha")).toBe(true);
    expect(requests).toEqual([
      expect.objectContaining({
        path: "/repos/o/r/pulls/42/merge",
        method: "PUT",
        body: { merge_method: "squash", sha: "reviewed-sha" },
      }),
    ]);
  });

  it("waits for pending checks instead of reporting a premature verdict", async () => {
    let polls = 0;
    const { runner } = fakeGit();
    const { client } = fakeHttp(() => {
      polls++;
      if (polls < 3) {
        return {
          status: 200,
          json: { check_runs: [{ name: "CI", status: "in_progress", conclusion: null }] },
        };
      }
      return {
        status: 200,
        json: { check_runs: [{ name: "CI", status: "completed", conclusion: "success" }] },
      };
    });
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    const verdict = await adapter.waitForChecks("sha");
    expect(polls).toBe(3);
    expect(verdict.passed).toBe(true);
  });

  it("returns a null verdict when CI polling times out (lifecycle stays honest)", async () => {
    const { runner } = fakeGit();
    const { client } = fakeHttp(() => ({
      status: 200,
      json: { check_runs: [{ name: "CI", status: "in_progress", conclusion: null }] },
    }));
    let now = 0;
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main", pollIntervalMs: 10, checksTimeoutMs: 100 },
      { runGit: runner, http: client, sleep: NO_SLEEP, now: () => (now += 60) },
    );
    const controller = new ExperimentController();
    controller.startExperiment(startInput());
    walkToDelivered(controller, "exp-gh-1");

    const verdict = await adapter.syncCiFeedback(controller, "exp-gh-1", "sha");
    expect(verdict.passed).toBeNull();
    expect(verdict.pending).toBe(true);
    // Timeout reports "pending", NOT a fake pass/fail.
    expect(controller.record("exp-gh-1").lifecycle.state).toBe("CI_PENDING");
    expect(controller.record("exp-gh-1").ci.status).toBe("pending");
  });

  it("deliverAndSync drives push → PR → CI → review end-to-end", async () => {
    const { runner, calls } = fakeGit();
    const { client, requests } = fakeHttp((path) => {
      if (path.endsWith("/pulls")) return { status: 201, json: { number: 9, html_url: "pr-url" } };
      if (path.includes("/check-runs")) {
        return { status: 200, json: { check_runs: [{ name: "CI", status: "completed", conclusion: "success" }] } };
      }
      if (path.includes("/reviews"))
        return { status: 200, json: [{ state: "APPROVED", commit_id: "cafe1234", user: { login: "rev" } }] };
      return { status: 200, json: {} };
    });
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    const controller = new ExperimentController();
    controller.startExperiment(startInput());
    walkToDelivered(controller, "exp-gh-1");

    const { handle, ci, review } = await adapter.deliverAndSync(controller, "exp-gh-1", {
      worktreePath: tmpDir,
      report: report(),
    });
    expect(handle.prNumber).toBe(9);
    expect(ci.passed).toBe(true);
    expect(review.state).toBe("approved");
    expect(controller.record("exp-gh-1").lifecycle.state).toBe("APPROVED");
    // Push + PR + checks + reviews were all exercised.
    expect(calls.some((a) => a.includes("push"))).toBe(true);
    expect(requests.some((r) => r.path.includes("/check-runs"))).toBe(true);
    expect(requests.some((r) => r.path.includes("/reviews"))).toBe(true);
  });

  it("surfaces push failures instead of silently proceeding to the PR", async () => {
    const { runner } = fakeGit(true);
    const { client, requests } = fakeHttp(() => ({ status: 201, json: { number: 1, html_url: "u" } }));
    const adapter = new GitHubDeliveryAdapter(
      { owner: "o", repo: "r", baseBranch: "main" },
      { runGit: runner, http: client, sleep: NO_SLEEP },
    );
    await expect(
      adapter.deliverExperiment({ worktreePath: tmpDir, report: report(), alreadyCommitted: true }),
    ).rejects.toThrow(/push.*failed|failed/i);
    expect(requests).toHaveLength(0); // no PR attempted after a failed push
  });
});

/** Advances an experiment to DELIVERED with explicit lifecycle transitions. */
function walkToDelivered(controller: ExperimentController, id: string): void {
  controller.advance(id, "EVALUATING");
  controller.advance(id, "VALIDATED");
  controller.advance(id, "GENERALIZED");
  controller.advance(id, "ELIGIBLE");
  controller.advance(id, "DELIVERED");
}
