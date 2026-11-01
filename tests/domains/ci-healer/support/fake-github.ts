import type { GitHubPort } from "../../../../src/domains/ci-healer/application/ports.js";
import { ProtocolError } from "../../../../src/domains/ci-healer/errors.js";
import type { OpenPullRequest, PullRequestState, WorkflowRun } from "../../../../src/domains/ci-healer/domain/types.js";

/** In-memory GitHub. Tests set fixtures using GitHub's own field names. */
export class FakeGitHub implements GitHubPort {
  defaultName = "main";
  failed: WorkflowRun[] = [];
  openPrs: OpenPullRequest[] = [];
  branchRuns = new Map<string, WorkflowRun[]>();
  pulls = new Map<number, PullRequestState>();
  logs = new Map<number, string>();
  created: { number: number; base: string; head: string; title: string; body: string }[] = [];
  private nextNumber = 0;

  async defaultBranch(): Promise<string> {
    return this.defaultName;
  }

  async failedRuns(): Promise<WorkflowRun[]> {
    return this.failed;
  }

  async runsForBranch(branch: string): Promise<WorkflowRun[]> {
    return this.branchRuns.get(branch) ?? [];
  }

  async openPullRequests(): Promise<OpenPullRequest[]> {
    return this.openPrs;
  }

  async pullRequest(number: number): Promise<PullRequestState> {
    const state = this.pulls.get(number);
    if (!state) throw new ProtocolError(`no fixture for PR #${number}`);
    return state;
  }

  async failedLog(runId: number): Promise<string> {
    return (
      this.logs.get(runId) ??
      "build\tRun tests\t2026-11-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.\n"
    );
  }

  async createDraftPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<number> {
    this.nextNumber += 1;
    this.created.push({ number: this.nextNumber, ...input });
    return this.nextNumber;
  }

  setPull(number: number, headRefOid: string, state: PullRequestState["state"] = "OPEN"): void {
    this.pulls.set(number, { number, state, headRefOid });
  }

  setBranchRun(branch: string, run: WorkflowRun): void {
    this.branchRuns.set(branch, [run]);
  }
}

export function ciRun(
  databaseId: number,
  fields: Partial<WorkflowRun> & Pick<WorkflowRun, "headBranch" | "headSha">,
): WorkflowRun {
  return {
    workflowName: "CI",
    event: "push",
    status: "completed",
    conclusion: "failure",
    attempt: 1,
    createdAt: "2026-11-01T00:00:00Z",
    url: `https://github.com/acme/app/actions/runs/${databaseId}`,
    databaseId,
    ...fields,
  };
}
