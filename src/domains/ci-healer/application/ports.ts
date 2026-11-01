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

/**
 * Repo-controlled shell commands (setup and verify). Repository code is untrusted
 * relative to the daemon, so these run through a sandbox, not directly on the host.
 */
export interface RepoCommandOptions {
  cwd: string;
  timeoutMs: number;
  phase: "setup" | "verify";
  allowFailure?: boolean;
}

export interface RepoCommandPort {
  run(command: string, options: RepoCommandOptions): Promise<CommandResult>;
}

export interface GitHubPort {
  defaultBranch(): Promise<string>;
  /** Recent runs for one branch. The caller filters them to the branch head. */
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
  /** Discards tracked and untracked changes, keeping ignored files (dependency installs). */
  resetWorktree(path: string): Promise<void>;
  stageAllAndList(path: string): Promise<string[]>;
  commit(path: string, message: string): Promise<void>;
  headSha(path: string): Promise<string>;
  push(path: string, refspec: string, options?: { setUpstream?: boolean }): Promise<void>;
}

export interface AgentOutcome {
  status: string;
  output: string;
  error?: string;
  /** Which runtime in the chain produced this outcome. */
  runtime?: string;
}

export interface AgentPort {
  /**
   * Runs one repair in `workspace`. "completed" means the runtime returned, not that
   * the fix works. Verification decides that.
   */
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
