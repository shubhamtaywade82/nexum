import { rm } from "node:fs/promises";
import type { CommandPort, GitPort, Logger } from "../application/ports.js";
import { CommandError } from "../errors.js";
import { inheritedEnv } from "./agent-env.js";

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
/** Failures that retrying cannot fix: rejected pushes, auth and permission errors. */
const NON_RETRYABLE =
  /non-fast-forward|fetch first|rejected|authentication failed|permission denied|could not read username|protected branch|does not appear to be a git repository/i;

export interface GitCliOptions {
  command: CommandPort;
  repoDir: string;
  author: { name: string; email: string };
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Git against the operator's main checkout. Heal work happens only in short-lived
 * worktrees, so the main checkout's working tree is never touched. Pushes are never
 * forced.
 */
export class GitCli implements GitPort {
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GitCliOptions) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async fetch(): Promise<void> {
    await this.retrying(["git", "fetch", "--prune", "origin"], this.options.repoDir);
  }

  async remoteHead(branch: string): Promise<string | null> {
    const result = await this.run(
      ["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`],
      { cwd: this.options.repoDir, allowFailure: true },
    );
    return result.status === 0 ? result.stdout.trim() : null;
  }

  async pruneWorktrees(): Promise<void> {
    await this.run(["git", "worktree", "prune"], { cwd: this.options.repoDir, allowFailure: true });
  }

  async addBranchWorktree(path: string, branch: string, startPoint: string): Promise<void> {
    await this.run(["git", "worktree", "add", "-b", branch, path, startPoint], { cwd: this.options.repoDir });
  }

  async addDetachedWorktree(path: string, ref: string): Promise<void> {
    await this.run(["git", "worktree", "add", "--detach", path, ref], { cwd: this.options.repoDir });
  }

  async removeWorktree(path: string): Promise<void> {
    await this.run(["git", "worktree", "remove", "--force", path], { cwd: this.options.repoDir, allowFailure: true });
    await rm(path, { recursive: true, force: true });
    await this.pruneWorktrees();
  }

  async deleteLocalBranch(branch: string): Promise<void> {
    await this.run(["git", "branch", "-D", branch], { cwd: this.options.repoDir, allowFailure: true });
  }

  /**
   * Discards the failed runtime's edits. `clean -fd` removes untracked files but not
   * ignored ones, so installed dependencies from setup survive.
   */
  async resetWorktree(path: string): Promise<void> {
    await this.run(["git", "reset", "--hard", "-q"], { cwd: path });
    await this.run(["git", "clean", "-fd", "-q"], { cwd: path });
  }

  async stageAllAndList(path: string): Promise<string[]> {
    await this.run(["git", "add", "-A"], { cwd: path });
    const result = await this.run(["git", "diff", "--cached", "--name-only", "-z"], { cwd: path });
    return result.stdout.split("\u0000").filter((entry) => entry.length > 0);
  }

  async commit(path: string, message: string): Promise<void> {
    const { name, email } = this.options.author;
    await this.run(["git", "commit", "-m", message], {
      cwd: path,
      env: {
        ...inheritedEnv(),
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    });
  }

  async headSha(path: string): Promise<string> {
    return (await this.run(["git", "rev-parse", "HEAD"], { cwd: path })).stdout.trim();
  }

  async push(path: string, refspec: string, options: { setUpstream?: boolean } = {}): Promise<void> {
    const argv = ["git", "push", ...(options.setUpstream ? ["-u"] : []), "origin", refspec];
    await this.retrying(argv, path);
  }

  private async retrying(argv: string[], cwd: string): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.run(argv, { cwd });
        return;
      } catch (error) {
        const retryable = error instanceof CommandError && !NON_RETRYABLE.test(error.stderr);
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
        const delay = RETRY_DELAYS_MS[attempt];
        attempt += 1;
        this.options.log.warn("git network failure; retrying", {
          command: argv.slice(0, 3).join(" "),
          delay_ms: delay,
          attempt,
        });
        await this.sleep(delay);
      }
    }
  }

  private async run(argv: string[], options: { cwd: string; env?: Record<string, string>; allowFailure?: boolean }) {
    return this.options.command.run(argv, {
      cwd: options.cwd,
      env: options.env ?? inheritedEnv(),
      timeoutMs: this.timeoutMs,
      allowFailure: options.allowFailure,
    });
  }
}
