/** Shapes of the GitHub data the healer consumes, using gh's own camelCase names. */

export interface WorkflowRun {
  databaseId: number;
  headBranch: string;
  headSha: string;
  workflowName: string;
  event: string;
  /** queued | in_progress | completed | … */
  status: string;
  /** success | failure | timed_out | cancelled | "" while running | … */
  conclusion: string;
  attempt: number;
  createdAt: string;
  url: string;
}

export interface OpenPullRequest {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  isDraft: boolean;
}

export interface PullRequestState {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
}
