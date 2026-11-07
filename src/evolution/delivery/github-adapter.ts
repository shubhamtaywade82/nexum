/**
 * GitHubDeliveryAdapter — performs the REAL Git/GitHub delivery loop and
 * feeds external results back into the ExperimentController.
 *
 * Completes the autonomous engineering pipeline the v2 architecture review
 * identified as missing between "delivery prepared" and "CI/review feedback":
 *
 *   candidate commit → push branch → create PR → CI → review → feedback
 *   → rework (CHANGES_REQUESTED / CI_FAILED → CANDIDATE) → accept → merge
 *
 * All network and git operations are injectable so the adapter is fully
 * unit-testable; the default implementations use child-process git and the
 * global fetch against api.github.com.
 */

import { execFile } from "node:child_process";
import { DeliveryReport } from "../delivery.js";
import { ExperimentController } from "../experiments/experiment-controller.js";
import { ExperimentCiStatus, ExperimentReviewState } from "../experiments/experiment-schema.js";
import { isCommitSha, MergeOutcome, MergeVerification } from "./activation-gate.js";

export type { MergeOutcome, MergeVerification } from "./activation-gate.js";

export interface GitHubAdapterConfig {
  owner: string;
  repo: string;
  /** Personal access token (optional for public read-only usage). */
  token?: string;
  baseBranch: string;
  remote?: string;
  apiUrl?: string;
  /** Poll interval while waiting for CI check-runs. */
  pollIntervalMs?: number;
  /** Maximum time to wait for CI before giving up (feedback stays pending). */
  checksTimeoutMs?: number;
}

export interface GitRunResult {
  stdout: string;
  exitCode: number;
  stderr: string;
}

export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export interface HttpResult {
  status: number;
  json: unknown;
}

export type GitHubHttpClient = (
  path: string,
  init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "MERGE" | "DELETE"; body?: unknown },
) => Promise<HttpResult>;

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  html_url?: string;
}

export interface DeliveryHandle {
  branch: string;
  headSha: string;
  prNumber: number;
  prUrl: string;
}

export interface ChecksVerdict {
  /** null = timed out with runs still in progress (lifecycle stays CI_PENDING). */
  passed: boolean | null;
  failedRuns: string[];
  pending: boolean;
  runs: CheckRun[];
}

export interface ReviewVerdict {
  state: ExperimentReviewState;
  reviewer?: string;
  reviewUrl?: string;
}

export interface GitHubDeliveryAdapterOptions {
  runGit?: GitCommandRunner;
  http?: GitHubHttpClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULTS: Required<Pick<GitHubAdapterConfig, "remote" | "apiUrl" | "pollIntervalMs" | "checksTimeoutMs">> = {
  remote: "origin",
  apiUrl: "https://api.github.com",
  pollIntervalMs: 15_000,
  checksTimeoutMs: 30 * 60_000,
};

export class GitHubDeliveryAdapter {
  private readonly cfg: GitHubAdapterConfig;
  private readonly resolved: typeof DEFAULTS;
  private readonly runGit: GitCommandRunner;
  private readonly http: GitHubHttpClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(cfg: GitHubAdapterConfig, opts: GitHubDeliveryAdapterOptions = {}) {
    this.cfg = cfg;
    this.resolved = { ...DEFAULTS, ...pick(cfg, "remote", "apiUrl", "pollIntervalMs", "checksTimeoutMs") };
    this.runGit = opts.runGit ?? defaultGitRunner;
    this.http = opts.http ?? defaultHttpClient(cfg);
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  /**
   * Commits any pending mutation inside the worktree (if not already
   * committed by the mutation executor), pushes the evolution branch, and
   * opens the PR whose body carries the experiment provenance.
   */
  async deliverExperiment(input: {
    worktreePath: string;
    report: DeliveryReport;
    commitMessage?: string;
    /** Skip committing (mutation executor already finalized the candidate). */
    alreadyCommitted?: boolean;
  }): Promise<DeliveryHandle> {
    if (!input.alreadyCommitted) {
      await this.git(["add", "-A"], input.worktreePath);
      await this.git(
        [
          "-c",
          "user.name=Nexum Evolution",
          "-c",
          "user.email=evolution@nexum.local",
          "commit",
          "-m",
          input.commitMessage ?? input.report.commitMessage,
        ],
        input.worktreePath,
      );
    }
    const headSha = (await this.git(["rev-parse", "HEAD"], input.worktreePath)).trim();
    await this.git(
      ["push", "-u", this.resolved.remote, `HEAD:refs/heads/${input.report.branchName}`],
      input.worktreePath,
    );
    const pr = await this.createPullRequest(input.report);
    return { branch: input.report.branchName, headSha, prNumber: pr.number, prUrl: pr.url };
  }

  /** Opens the pull request on the base branch. */
  async createPullRequest(
    report: Pick<DeliveryReport, "prTitle" | "prBody" | "branchName">,
  ): Promise<{ number: number; url: string }> {
    const res = await this.http(`/repos/${this.cfg.owner}/${this.cfg.repo}/pulls`, {
      method: "POST",
      body: {
        title: report.prTitle,
        head: report.branchName,
        base: this.cfg.baseBranch,
        body: report.prBody,
        maintainer_can_modify: true,
      },
    });
    const body = res.json as { number?: number; html_url?: string; message?: string };
    if (res.status !== 201 || !body.number) {
      throw new Error(`PR creation failed (HTTP ${res.status}): ${body.message ?? "unknown error"}`);
    }
    return { number: body.number, url: body.html_url ?? "" };
  }

  /**
   * Merges an accepted evolution PR. `headSha` pins the merge to the commit that
   * CI and review were checked against; GitHub refuses a moved head.
   *
   * Returns a typed outcome. Only a 200 that confirms `merged: true` with a full
   * merge commit sha counts as merged. Definitive refusals (405, 409, 422) are
   * "rejected". Everything else (transport failure, other status, a body that
   * does not confirm a merge) is "uncertain". Neither may lead to activation.
   * A merged outcome is still unverified until verifyMergedPull() reads it back.
   */
  async mergePullRequest(
    prNumber: number,
    headSha: string,
    method: "merge" | "squash" | "rebase" = "squash",
  ): Promise<MergeOutcome> {
    let res: HttpResult;
    try {
      res = await this.http(`/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}/merge`, {
        method: "PUT",
        body: { merge_method: method, sha: headSha },
      });
    } catch (err) {
      return { status: "uncertain", reason: `merge request failed: ${(err as Error).message}` };
    }
    const body = (res.json ?? {}) as { merged?: unknown; sha?: unknown; message?: unknown };
    const message = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    if (res.status === 200) {
      if (body.merged === true && isCommitSha(body.sha)) {
        return { status: "merged", mergeCommitSha: body.sha };
      }
      return { status: "uncertain", reason: "200 response does not confirm a merge with a commit sha" };
    }
    if (res.status === 405 || res.status === 409 || res.status === 422) {
      return { status: "rejected", httpStatus: res.status, reason: message };
    }
    return { status: "uncertain", reason: `unexpected HTTP ${res.status} from merge: ${message}` };
  }

  /**
   * Confirms a merge by reading it back from GitHub. The merge call's own response
   * is not trusted. The pull must be merged from the reviewed head, its merge
   * commit must equal the one the merge call returned, and that commit must carry
   * the candidate's file contents (path, status and blob sha).
   *
   * Fails closed: any lookup error, empty or possibly truncated file list
   * (GitHub caps commit file lists at 300) yields a false field and a reason.
   */
  async verifyMergedPull(
    prNumber: number,
    reviewedSha: string,
    mergeCommitSha: string,
    candidateCommit: string,
  ): Promise<MergeVerification> {
    const repo = `/repos/${this.cfg.owner}/${this.cfg.repo}`;
    const identity = { mergeCommitSha, candidateCommit };
    const none = { ...identity, mergedFromReviewedHead: false, mergeCommitMatches: false, contentMatches: false };
    try {
      const pull = await this.http(`${repo}/pulls/${prNumber}`);
      if (pull.status !== 200) {
        return { ...none, reason: `pull lookup returned HTTP ${pull.status}` };
      }
      const p = (pull.json ?? {}) as { merged?: unknown; merge_commit_sha?: unknown; head?: { sha?: unknown } };
      const mergedFromReviewedHead = p.merged === true && p.head?.sha === reviewedSha;
      const mergeCommitMatches = p.merge_commit_sha === mergeCommitSha;
      // Each check reports on its own: a lookup error on one does not hide the others.
      let contentMatches = false;
      let contentError: string | undefined;
      try {
        contentMatches = await this.sameCommitContent(repo, candidateCommit, mergeCommitSha);
      } catch (err) {
        contentError = `content check failed: ${(err as Error).message}`;
      }
      const reason = !mergedFromReviewedHead
        ? "pull is not merged from the reviewed head"
        : !mergeCommitMatches
          ? "merge commit differs from the one GitHub reports"
          : (contentError ?? (contentMatches ? undefined : "merged content does not match the candidate"));
      return {
        ...identity,
        mergedFromReviewedHead,
        mergeCommitMatches,
        contentMatches,
        ...(reason ? { reason } : {}),
      };
    } catch (err) {
      return { ...none, reason: `verification failed: ${(err as Error).message}` };
    }
  }

  /** True when the two commits change exactly the same paths to the same blobs. Throws on any doubt. */
  private async sameCommitContent(repo: string, candidate: string, merged: string): Promise<boolean> {
    if (!isCommitSha(candidate) || !isCommitSha(merged)) throw new Error("commit sha is malformed");
    const candidateFiles = await this.commitFileMap(`${repo}/commits/${candidate}`);
    const mergedFiles = await this.commitFileMap(`${repo}/commits/${merged}`);
    if (candidateFiles.size === 0) throw new Error("candidate commit reports no changed files");
    if (candidateFiles.size !== mergedFiles.size) return false;
    for (const [name, fingerprint] of candidateFiles) {
      if (mergedFiles.get(name) !== fingerprint) return false;
    }
    return true;
  }

  private async commitFileMap(path: string): Promise<Map<string, string>> {
    const res = await this.http(path);
    if (res.status !== 200) throw new Error(`commit lookup returned HTTP ${res.status}`);
    const files = (res.json as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) throw new Error("commit response has no file list");
    if (files.length >= 300) throw new Error("file list may be truncated (300 entries)");
    const map = new Map<string, string>();
    for (const entry of files as Array<{ filename?: unknown; status?: unknown; sha?: unknown }>) {
      if (typeof entry.filename !== "string" || typeof entry.sha !== "string") {
        throw new Error("commit file entry is malformed");
      }
      map.set(entry.filename, `${String(entry.status)}:${entry.sha}`);
    }
    return map;
  }

  // ── External reality: CI ─────────────────────────────────────────────────

  /** Fetches check-runs for a commit sha. */
  async getCheckRuns(sha: string): Promise<CheckRun[]> {
    const res = await this.http(`/repos/${this.cfg.owner}/${this.cfg.repo}/commits/${sha}/check-runs?per_page=100`);
    const body = res.json as { check_runs?: CheckRun[] };
    return body.check_runs ?? [];
  }

  /**
   * Polls CI check-runs until every run is completed (or the timeout hits).
   * `passed` is null when the poll timed out with runs still in flight.
   */
  async waitForChecks(sha: string, timeoutMs = this.resolved.checksTimeoutMs): Promise<ChecksVerdict> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const runs = await this.getCheckRuns(sha);
      const pending = runs.filter((r) => r.status !== "completed");
      if (runs.length > 0 && pending.length === 0) {
        const failedRuns = runs
          .filter((r) => r.conclusion !== "success" && r.conclusion !== "skipped")
          .map((r) => r.name);
        return { passed: failedRuns.length === 0, failedRuns, pending: false, runs };
      }
      if (this.now() >= deadline) {
        return { passed: null, failedRuns: [], pending: pending.length > 0, runs };
      }
      await this.sleep(this.resolved.pollIntervalMs);
    }
  }

  /**
   * Fetches the latest independent human review state for a PR.
   * Only reviews of the exact current head from a non-author GitHub User count.
   * Bot reviews, self-approvals, missing author identity and API failures fail closed.
   */
  async getLatestReview(prNumber: number, headSha: string): Promise<ReviewVerdict> {
    const [pullRes, reviewRes] = await Promise.all([
      this.http(`/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}`),
      this.http(`/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}/reviews?per_page=100`),
    ]);
    if (pullRes.status !== 200 || reviewRes.status !== 200) return { state: "pending" };

    const pull = pullRes.json as { user?: { login?: string } } | null;
    const authorLogin = pull?.user?.login?.trim().toLowerCase();
    if (!authorLogin || !Array.isArray(reviewRes.json)) return { state: "pending" };

    const reviews = reviewRes.json as Array<{
      state: string;
      commit_id?: string;
      user?: { login?: string; type?: string };
      html_url?: string;
      submitted_at?: string;
    }>;
    // A review of an earlier commit does not cover the code that would merge. GitHub
    // Bot accounts and the PR author cannot independently approve their own candidate.
    const submitted = reviews
      .filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
      .filter((r) => r.commit_id === headSha)
      .filter((r) => r.user?.type === "User" && !!r.user.login)
      .filter((r) => r.user!.login!.trim().toLowerCase() !== authorLogin)
      .sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""));
    const latest = submitted[submitted.length - 1];
    if (!latest) return { state: "pending" };
    return {
      state: latest.state === "APPROVED" ? "approved" : "changes_requested",
      reviewer: latest.user?.login,
      reviewUrl: latest.html_url,
    };
  }

  // ── Feedback integration (adapter → ExperimentController) ────────────────

  /**
   * Polls CI for the delivered branch head and reports the verdict to the
   * experiment controller (DELIVERED → CI_PENDING → CI_PASSED | CI_FAILED).
   * A null verdict (timeout) leaves the lifecycle at CI_PENDING honestly.
   */
  async syncCiFeedback(
    controller: ExperimentController,
    experimentId: string,
    headSha: string,
    timeoutMs?: number,
  ): Promise<ChecksVerdict> {
    const verdict = await this.waitForChecks(headSha, timeoutMs);
    const status: ExperimentCiStatus = verdict.passed === null ? "pending" : verdict.passed ? "passed" : "failed";
    const runUrl = verdict.runs[0]?.html_url;
    controller.reportCiResult(experimentId, status, runUrl);
    return verdict;
  }

  /**
   * Fetches the review state and reports it to the controller
   * (REVIEW_PENDING → APPROVED | CHANGES_REQUESTED). "pending" is a no-op.
   */
  async syncReviewFeedback(
    controller: ExperimentController,
    experimentId: string,
    prNumber: number,
    headSha: string,
  ): Promise<ReviewVerdict> {
    const verdict = await this.getLatestReview(prNumber, headSha);
    if (verdict.state !== "pending") {
      controller.reportReviewOutcome(experimentId, verdict.state, verdict.reviewer);
    }
    return verdict;
  }

  /**
   * Full autonomous delivery + external-feedback cycle for one experiment:
   *   push branch → open PR → poll CI → report → poll review → report.
   * Returns handles and verdicts so the engine/caller can decide the next
   * lifecycle move (acceptance vs rework).
   */
  async deliverAndSync(
    controller: ExperimentController,
    experimentId: string,
    input: {
      worktreePath: string;
      report: DeliveryReport;
      commitMessage?: string;
      alreadyCommitted?: boolean;
      checksTimeoutMs?: number;
    },
  ): Promise<{ handle: DeliveryHandle; ci: ChecksVerdict; review: ReviewVerdict }> {
    const handle = await this.deliverExperiment(input);
    const ci = await this.syncCiFeedback(controller, experimentId, handle.headSha, input.checksTimeoutMs);
    const review = await this.syncReviewFeedback(controller, experimentId, handle.prNumber, handle.headSha);
    return { handle, ci, review };
  }

  private git(args: string[], cwd: string): Promise<string> {
    return this.runGit(args, cwd).then((r) => {
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${r.exitCode}): ${r.stderr}`);
      }
      return r.stdout;
    });
  }
}

// ── default injectables ─────────────────────────────────────────────────────

function pick<T, K extends keyof T>(t: T, ...keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) {
    if (t[k] !== undefined) out[k] = t[k];
  }
  return out;
}

function defaultGitRunner(args: string[], cwd: string): Promise<GitRunResult> {
  // Callers may pass either ["git", "-C", dir, ...] or bare subcommands
  // (["rev-parse", "HEAD"]); normalize so the production path actually works.
  const argv = args[0] === "git" ? args : ["git", ...args];
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code !== "number") {
          // Not a process exit (spawn failure, signal, etc.) — surface it.
          reject(err);
          return;
        }
        resolve({ stdout, stderr, exitCode: code });
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

function defaultHttpClient(cfg: GitHubAdapterConfig): GitHubHttpClient {
  return async (path, init) => {
    const url = `${cfg.apiUrl ?? DEFAULTS.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "nexum-evolution",
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}
