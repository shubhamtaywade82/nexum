import type { OpenPullRequest, PullRequestState, WorkflowRun } from "../domain/types.js";

/** Side effects the healer needs. Each has a real adapter and an in-memory test double. */

export interface CommandOptions {
  cwd?: string;
  timeoutMs: number;
  /** Full environment for the child. Omitted means inherit the daemon's environment. */
  env?: Record<string, string>;
  allowFailure?: boolean;
  stdin?: string;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandPort {
  run(argv: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

export interface GitHubPort {
  defaultBranch(): Promise<string>;
  failedRuns(limit: number): Promise<WorkflowRun[]>;
  runsForBranch(branch: string, limit?: number): Promise<WorkflowRun[]>;
  openPullRequests(): Promise<OpenPullRequest[]>;
  pullRequest(number: number): Promise<PullRequestState>;
  failedLog(runId: number): Promise<string>;
  createDraftPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<number>;
}

export interface GitPort {
  fetch(): Promise<void>;
  /** Commit SHA of origin/<branch>, or null when the branch is absent on origin. */
  remoteHead(branch: string): Promise<string | null>;
  pruneWorktrees(): Promise<void>;
  addBranchWorktree(path: string, branch: string, startPoint: string): Promise<void>;
  addDetachedWorktree(path: string, ref: string): Promise<void>;
  /** Never throws: cleanup is best effort. */
  removeWorktree(path: string): Promise<void>;
  deleteLocalBranch(branch: string): Promise<void>;
  stageAllAndList(path: string): Promise<string[]>;
  commit(path: string, message: string): Promise<void>;
  headSha(path: string): Promise<string>;
  push(path: string, refspec: string, options?: { setUpstream?: boolean }): Promise<void>;
}

export interface AgentOutcome {
  status: string;
  output: string;
  error?: string;
}

export interface AgentPort {
  /** Runs one repair in `workspace`. Completed means the agent returned, not that the fix works. */
  execute(input: { workspace: string; goal: string }): Promise<AgentOutcome>;
}

export interface LogPort {
  digestFor(runId: number): Promise<string>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
