import type { CommandOptions, CommandPort, CommandResult } from "../../../src/domains/ci-healer/application/ports.js";
import { GitHubCli } from "../../../src/domains/ci-healer/adapters/github-cli.js";
import { ProtocolError } from "../../../src/domains/ci-healer/errors.js";

/** Answers each REST path (matched by prefix) with a fixture. Records every call. */
class RouteCommands implements CommandPort {
  readonly calls: { argv: string[]; stdin?: string }[] = [];

  constructor(private readonly routes: Record<string, string>) {}

  async run(argv: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], stdin: options.stdin });
    const path = argv.find((arg) => arg.startsWith("repos/")) ?? "";
    const route = Object.keys(this.routes).find((key) => path.startsWith(key));
    if (route === undefined) throw new Error(`no fixture for ${path}`);
    return { status: 0, stdout: this.routes[route], stderr: "" };
  }
}

const REPO = "acme/app";
const SHA = "a".repeat(40);

function client(routes: Record<string, string>): { gh: GitHubCli; commands: RouteCommands } {
  const commands = new RouteCommands(routes);
  return { gh: new GitHubCli({ command: commands, repo: REPO, cwd: "/repo" }), commands };
}

describe("GitHubCli over the REST API", () => {
  it("reads the default branch", async () => {
    const { gh } = client({ [`repos/${REPO}`]: JSON.stringify({ default_branch: "trunk" }) });
    await expect(gh.defaultBranch()).resolves.toBe("trunk");
  });

  it("maps workflow runs to the healer's shape, treating a null conclusion as empty", async () => {
    const { gh } = client({
      [`repos/${REPO}/actions/runs`]: JSON.stringify({
        workflow_runs: [
          {
            id: 9,
            head_branch: "main",
            head_sha: SHA,
            name: "CI",
            event: "push",
            status: "in_progress",
            conclusion: null,
            run_attempt: 2,
            created_at: "2026-11-01T00:00:00Z",
            html_url: "https://x/9",
          },
        ],
      }),
    });
    const [run] = await gh.runsForBranch("main", 5);
    expect(run).toEqual({
      databaseId: 9,
      headBranch: "main",
      headSha: SHA,
      workflowName: "CI",
      event: "push",
      status: "in_progress",
      conclusion: "",
      attempt: 2,
      createdAt: "2026-11-01T00:00:00Z",
      url: "https://x/9",
    });
  });

  it("encodes branch names that contain slashes", async () => {
    const { gh, commands } = client({ [`repos/${REPO}/actions/runs`]: JSON.stringify({ workflow_runs: [] }) });
    await gh.runsForBranch("feature/x", 5);
    expect(commands.calls[0].argv.join(" ")).toContain("branch=feature%2Fx");
  });

  it("marks a PR from a fork, or whose head repository is gone, as cross-repository", async () => {
    const pull = (number: number, headRepo: unknown) => ({
      number,
      state: "open",
      draft: false,
      head: { ref: `b${number}`, sha: SHA, repo: headRepo },
      base: { ref: "main", repo: { full_name: REPO } },
    });
    const { gh } = client({
      [`repos/${REPO}/pulls?`]: JSON.stringify([
        pull(1, { full_name: REPO }),
        pull(2, { full_name: "someone/fork" }),
        pull(3, null),
      ]),
    });
    const prs = await gh.openPullRequests();
    expect(prs.map((pr) => pr.isCrossRepository)).toEqual([false, true, true]);
  });

  it("reports a merged PR as MERGED and a closed unmerged PR as CLOSED", async () => {
    const base = {
      number: 5,
      draft: false,
      head: { ref: "b", sha: SHA, repo: null },
      base: { ref: "main", repo: null },
    };
    const merged = client({ [`repos/${REPO}/pulls/5`]: JSON.stringify({ ...base, state: "closed", merged: true }) });
    const closed = client({ [`repos/${REPO}/pulls/5`]: JSON.stringify({ ...base, state: "closed", merged: false }) });
    await expect(merged.gh.pullRequest(5)).resolves.toMatchObject({ state: "MERGED", headRefOid: SHA });
    await expect(closed.gh.pullRequest(5)).resolves.toMatchObject({ state: "CLOSED" });
  });

  it("fetches logs only for the failed jobs, one section each", async () => {
    const { gh, commands } = client({
      [`repos/${REPO}/actions/runs/9/jobs`]: JSON.stringify({
        jobs: [
          { id: 1, name: "lint", conclusion: "success" },
          { id: 2, name: "test", conclusion: "failure" },
        ],
      }),
      [`repos/${REPO}/actions/jobs/2/logs`]: "﻿2026-11-01T00:00:00Z ERROR boom in lib/x.rb:3\n",
    });
    const log = await gh.failedLog(9);
    expect(log).toContain("=== job: test ===");
    expect(log).toContain("ERROR boom");
    expect(log).not.toContain("=== job: lint ===");
    expect(commands.calls.some((call) => call.argv.join(" ").includes("jobs/1/logs"))).toBe(false);
  });

  it("creates a draft PR by POSTing JSON on stdin and returns its number", async () => {
    const { gh, commands } = client({ [`repos/${REPO}/pulls`]: JSON.stringify({ number: 77 }) });
    const number = await gh.createDraftPullRequest({ base: "main", head: "fix/ci-main-1", title: "t", body: "b" });
    expect(number).toBe(77);
    const post = commands.calls[0];
    expect(post.argv).toEqual(expect.arrayContaining(["--method", "POST", "--input", "-"]));
    expect(JSON.parse(post.stdin ?? "{}")).toMatchObject({ head: "fix/ci-main-1", base: "main", draft: true });
  });

  it("fails as a ProtocolError when a response does not have the expected shape", async () => {
    const { gh } = client({
      [`repos/${REPO}/actions/runs`]: JSON.stringify({ workflow_runs: [{ id: 1, head_branch: "main" }] }),
    });
    await expect(gh.runsForBranch("main")).rejects.toThrow(ProtocolError);
  });
});
