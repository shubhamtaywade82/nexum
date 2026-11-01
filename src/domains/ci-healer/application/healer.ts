import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deriveChecks, type CheckVerdict } from "../domain/checks.js";
import { healBranchName, forbiddenPaths, targetFor } from "../domain/policy.js";
import { buildPrompt } from "../domain/prompt.js";
import { attemptsExhausted } from "../domain/lineage.js";
import type { OpenPullRequest, WorkflowRun } from "../domain/types.js";
import { CommandError, isRecoverable } from "../errors.js";
import { repoCommandEnv } from "../adapters/agent-env.js";
import type { Lineage, LedgerStore } from "../persistence/ledger-store.js";
import type { AgentOutcome, AgentPort, CommandPort, GitHubPort, GitPort, LogPort, Logger } from "./ports.js";
import type { HealerConfig } from "../config.js";

export interface HealerDeps {
  config: HealerConfig;
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  logs: LogPort;
  command: CommandPort;
  store: LedgerStore;
  log: Logger;
  now?: () => Date;
}

export interface Candidate {
  run: WorkflowRun;
  kind: "default" | "feature";
  base: string;
  head: string;
}

export interface Verdict {
  run: WorkflowRun;
  candidate: Candidate | null;
  reason: string | null;
}

type AttemptResult = "committed" | "no_patch";

/**
 * One scheduler tick. Order:
 *   1. reconcile existing agent lineages against GitHub: closed or merged, green, or
 *      failing on the current head (in-place iteration within the attempt budget)
 *   2. evaluate newly failing runs on the default branch and open same-repo PRs
 *   3. heal at most max_heals_per_tick new failures
 *
 * Every side effect goes through an injected port. The ledger is the only source of
 * truth for whether a head has already been acted on.
 */
export class Healer {
  private readonly config: HealerConfig;
  private readonly repo: string;
  private readonly leaseName: string;

  constructor(private readonly deps: HealerDeps) {
    this.config = deps.config;
    this.repo = deps.config.repo.slug;
    this.leaseName = `ci-healer:${deps.config.repo.slug}`;
  }

  /** One tick. Returns without work when another worker holds the repository's lease. */
  async tick(): Promise<void> {
    const { store, log, git, github, config } = this.deps;
    const owner = `${process.pid}:${randomUUID()}`;
    if (!store.acquireLease(this.leaseName, owner, config.lease_ttl_sec * 1000, this.now().getTime())) {
      log.info("skipping tick", { reason: "another worker holds the lease", repo: this.repo });
      return;
    }
    try {
      mkdirSync(config.worktree_base, { recursive: true });
      await git.pruneWorktrees();
      await git.fetch();
      await this.reconcile();

      let budget = config.max_heals_per_tick;
      for (const verdict of await this.evaluate(await github.defaultBranch())) {
        if (!verdict.candidate) {
          log.debug("skipped run", {
            run: verdict.run.databaseId,
            branch: verdict.run.headBranch,
            reason: verdict.reason,
          });
          continue;
        }
        if (budget <= 0) break;
        const candidate = verdict.candidate;
        if (store.activeForBase(this.repo, candidate.base).length >= config.max_open_prs_per_base) {
          log.info("deferred: base already has an open agent PR", {
            base: candidate.base,
            run: candidate.run.databaseId,
          });
          continue;
        }
        await this.healNew(candidate);
        budget -= 1;
      }
    } finally {
      store.releaseLease(this.leaseName, owner);
    }
  }

  /** Read-only report. Fetches refs but writes nothing to the ledger, worktrees, or GitHub. */
  async plan(): Promise<string[]> {
    await this.deps.git.fetch();
    const lines = this.deps.store
      .activeLineages(this.repo)
      .map(
        (lineage) =>
          `lineage ${lineage.healBranch} state=${lineage.state} attempts=${lineage.attempts} pr=#${lineage.prNumber}`,
      );
    for (const verdict of await this.evaluate(await this.deps.github.defaultBranch())) {
      lines.push(
        verdict.candidate
          ? `would heal run=${verdict.run.databaseId} branch=${verdict.run.headBranch} base=${verdict.candidate.base} head=${short(verdict.candidate.head)}`
          : `skip run=${verdict.run.databaseId} branch=${verdict.run.headBranch}: ${verdict.reason}`,
      );
    }
    return lines;
  }

  // ── reconciliation of existing lineages ───────────────────────────────────

  private async reconcile(): Promise<void> {
    const { store, log } = this.deps;
    for (const name of store.recoverInterrupted(this.repo)) {
      log.warn("recovered interrupted heal", { heal_branch: name });
    }
    for (const lineage of store.activeLineages(this.repo)) {
      try {
        await this.reconcileLineage(lineage);
      } catch (error) {
        if (!isRecoverable(error)) throw error;
        log.warn("lineage check failed; retrying next tick", {
          heal_branch: lineage.healBranch,
          error: (error as Error).message,
        });
      }
    }
  }

  private async reconcileLineage(lineage: Lineage): Promise<void> {
    const { store, github, log } = this.deps;
    const name = lineage.healBranch;
    const pr = await github.pullRequest(lineage.prNumber);
    if (pr.state !== "OPEN") {
      store.transition(this.repo, name, "CLOSED", { pr_state: pr.state });
      log.info("lineage closed", { heal_branch: name, pr_state: pr.state });
      return;
    }

    const checks = await this.checksFor(name, pr.headRefOid);
    if (checks.verdict === "green") {
      const previous = lineage.state;
      store.transition(this.repo, name, "GREEN");
      if (previous !== "GREEN") log.info("checks green on agent PR", { heal_branch: name, pr: lineage.prNumber });
    } else if (checks.verdict === "failing") {
      await this.handleFailure(lineage, pr.headRefOid, checks.run);
    }
  }

  private async checksFor(branch: string, head: string): Promise<CheckVerdict> {
    const runs = (await this.deps.github.runsForBranch(branch)).filter((run) => run.headSha === head);
    return deriveChecks(runs);
  }

  private async handleFailure(lineage: Lineage, head: string, run: WorkflowRun): Promise<void> {
    const { store, log } = this.deps;
    if (attemptsExhausted(lineage.attempts, this.config.max_heal_attempts_per_lineage)) {
      if (lineage.state !== "EXHAUSTED") {
        store.transition(this.repo, lineage.healBranch, "EXHAUSTED");
        log.warn("heal attempts exhausted; human review needed", {
          heal_branch: lineage.healBranch,
          attempts: lineage.attempts,
        });
      }
      return;
    }
    if (lineage.lastAttemptedSha === head) {
      log.info("already spent an attempt on this head; waiting for a new commit", {
        heal_branch: lineage.healBranch,
        head: short(head),
      });
      return;
    }
    await this.healInPlace(lineage, head, run);
  }

  private async healInPlace(lineage: Lineage, head: string, run: WorkflowRun): Promise<void> {
    const { store, git, logs, log, config } = this.deps;
    const name = lineage.healBranch;
    const attempt = lineage.attempts + 1;
    const worktree = this.worktreePath(run.databaseId, head);

    // The log fetch happens before any state change, so a transient failure here retries
    // next tick without consuming an attempt.
    const digest = await logs.digestFor(run.databaseId);
    store.update(this.repo, name, { attempts: attempt, lastAttemptedSha: head });
    store.transition(this.repo, name, "HEALING");

    try {
      await git.removeWorktree(worktree);
      await git.addDetachedWorktree(worktree, `origin/${name}`);
      if ((await git.remoteHead(name)) !== head) {
        log.warn("heal branch moved after the failure was observed; not touching it", { heal_branch: name });
      } else if (
        (await this.attemptFix(worktree, { run, digest, attempt, base: lineage.baseBranch })) === "committed"
      ) {
        await git.push(worktree, `HEAD:refs/heads/${name}`);
        store.update(this.repo, name, { lastPushedSha: await git.headSha(worktree) });
        log.info("pushed in-place fix", { heal_branch: name, attempt, max: config.max_heal_attempts_per_lineage });
      }
      store.transition(this.repo, name, "PR_OPEN");
    } catch (error) {
      if (!isRecoverable(error)) throw error;
      // The attempt stays consumed. The lineage returns to PR_OPEN, which bounds retries.
      if (store.getLineage(this.repo, name)?.state === "HEALING") store.transition(this.repo, name, "PR_OPEN");
      log.error("in-place heal failed; attempt consumed", { heal_branch: name, error: (error as Error).message });
    } finally {
      await git.removeWorktree(worktree);
    }
  }

  // ── new failures ──────────────────────────────────────────────────────────

  private async evaluate(defaultBranch: string): Promise<Verdict[]> {
    const openPrs = await this.deps.github.openPullRequests();
    const runs = await this.deps.github.failedRuns(this.config.run_scan_limit);
    const verdicts: Verdict[] = [];
    for (const run of runs) verdicts.push(await this.verdictFor(run, defaultBranch, openPrs));
    return verdicts;
  }

  private async verdictFor(run: WorkflowRun, defaultBranch: string, openPrs: OpenPullRequest[]): Promise<Verdict> {
    const { git, store } = this.deps;
    const skip = (reason: string): Verdict => ({ run, candidate: null, reason });

    const target = targetFor(run.headBranch, defaultBranch, openPrs);
    if (!target.ok) return skip(target.reason);

    const head = await git.remoteHead(run.headBranch);
    if (!head) return skip("branch not present on origin");
    if (head !== run.headSha) return skip(`stale: run ${short(run.headSha)} is not the branch head ${short(head)}`);
    if (store.handledOutcome(this.repo, target.base, head))
      return skip(`already handled ${target.base}@${short(head)}`);

    const active = store.activeForBase(this.repo, target.base).length;
    if (active >= this.config.max_open_prs_per_base)
      return skip(`${active} open agent lineage(s) against ${target.base}`);

    return { run, candidate: { run, kind: target.kind, base: target.base, head }, reason: null };
  }

  private async healNew(candidate: Candidate): Promise<void> {
    const { store, git, logs, github, log } = this.deps;
    const { run, base, head } = candidate;
    const runId = run.databaseId;
    const branch = healBranchName(base, runId);
    const worktree = this.worktreePath(runId, head);

    let digest: string;
    try {
      digest = await logs.digestFor(runId);
    } catch (error) {
      if (!isRecoverable(error)) throw error;
      log.warn("could not fetch failed logs; retrying next tick", { run: runId, error: (error as Error).message });
      return;
    }

    store.markHead(this.repo, base, head, "HEALING");
    try {
      await git.removeWorktree(worktree);
      await git.addBranchWorktree(worktree, branch, `origin/${base}`);
      await this.setup(worktree);

      if ((await this.attemptFix(worktree, { run, digest, attempt: 1, base })) === "committed") {
        await git.push(worktree, branch, { setUpstream: true });
        const pr = await github.createDraftPullRequest({
          base,
          head: branch,
          title: prTitle(run, base),
          body: prBody(run, base, head, this.config.verify_commands),
        });
        store.addLineage(this.repo, {
          healBranch: branch,
          baseBranch: base,
          originRunId: runId,
          originSha: head,
          prNumber: pr,
          attempts: 1,
        });
        store.markHead(this.repo, base, head, "PR_OPEN");
        log.info("opened draft fix PR", { pr, heal_branch: branch, base });
      } else {
        store.markHead(this.repo, base, head, "NO_PATCH");
        log.info("no patch landed; head not retried", { run: runId, base, head: short(head) });
      }
    } catch (error) {
      if (!isRecoverable(error)) throw error;
      store.markHead(this.repo, base, head, "ERRORED");
      log.error("heal failed; head marked ERRORED and needs a human reset", {
        run: runId,
        base,
        error: (error as Error).message,
      });
    } finally {
      await git.removeWorktree(worktree);
      await git.deleteLocalBranch(branch);
    }
  }

  // ── shared attempt pipeline ───────────────────────────────────────────────

  /**
   * Runs the agent, verifies, and commits in the worktree. Nothing is pushed here.
   * Returns "committed" only for a verified, policy-clean change.
   */
  private async attemptFix(
    worktree: string,
    input: { run: WorkflowRun; digest: string; attempt: number; base: string },
  ): Promise<AttemptResult> {
    const { agent, git, log, config } = this.deps;
    const goal = buildPrompt({
      repo: this.repo,
      sourceBranch: input.base,
      workflow: input.run.workflowName,
      runId: input.run.databaseId,
      attempt: input.attempt,
      maxAttempts: config.max_heal_attempts_per_lineage,
      digest: input.digest,
    });

    let outcome: AgentOutcome;
    try {
      outcome = await agent.execute({ workspace: worktree, goal });
    } catch (error) {
      if (!isRecoverable(error)) throw error;
      log.warn("nexum failed; no patch", { error: (error as Error).message });
      return "no_patch";
    }
    if (outcome.status !== "completed") {
      return giveUp(log, "nexum did not complete", { status: outcome.status, error: outcome.error });
    }
    if (!(await this.verify(worktree))) return giveUp(log, "verification failed");

    const changed = await git.stageAllAndList(worktree);
    if (changed.length === 0) return giveUp(log, "no file changes");
    if (changed.length > config.max_changed_files) {
      return giveUp(log, "patch too large", { files: changed.length, cap: config.max_changed_files });
    }
    const forbidden = forbiddenPaths(changed, config.forbidden_paths);
    if (forbidden.length > 0) return giveUp(log, "patch touches forbidden paths", { paths: forbidden });

    try {
      await git.commit(worktree, commitMessage(input.run));
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      return giveUp(log, "commit rejected by repository hooks", { error: error.stderr.split("\n")[0]?.trim() });
    }
    return "committed";
  }

  /** Repo-controlled commands run with the repoCommandEnv allowlist: no credentials visible. */
  private async setup(worktree: string): Promise<void> {
    for (const command of this.config.setup_commands) {
      await this.deps.command.run(["sh", "-c", command], {
        cwd: worktree,
        timeoutMs: this.config.setup_timeout_sec * 1000,
        env: repoCommandEnv(),
      });
    }
  }

  private async verify(worktree: string): Promise<boolean> {
    const { command, log, config } = this.deps;
    for (const cmd of config.verify_commands) {
      try {
        const result = await command.run(["sh", "-c", cmd], {
          cwd: worktree,
          timeoutMs: config.verify_timeout_sec * 1000,
          env: repoCommandEnv(),
          allowFailure: true,
        });
        log.info("verify", { command: cmd, status: result.status });
        if (result.status !== 0) return false;
      } catch (error) {
        if (!isRecoverable(error)) throw error;
        log.warn("verify timed out", { command: cmd, error: (error as Error).message });
        return false;
      }
    }
    return true;
  }

  private worktreePath(runId: number, head: string): string {
    return join(this.config.worktree_base, `${this.config.repo_name}-${runId}-${short(head)}`);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

function giveUp(log: Logger, reason: string, fields?: Record<string, unknown>): "no_patch" {
  log.warn(`no patch: ${reason}`, fields);
  return "no_patch";
}

function commitMessage(run: WorkflowRun): string {
  return `fix(ci): auto-heal ${run.workflowName} failure from run ${run.databaseId}`;
}

function prTitle(run: WorkflowRun, base: string): string {
  return `fix(ci): heal ${run.workflowName} on ${base}`;
}

function prBody(run: WorkflowRun, base: string, head: string, verifyCommands: readonly string[]): string {
  const verify = verifyCommands.map((command) => `\`${command}\``).join(", ");
  return [
    "Automated CI remediation by `ci-healer`.",
    "",
    `- Failed run: ${run.url} (${run.workflowName}, run ${run.databaseId})`,
    `- Target branch: \`${base}\` at \`${short(head)}\``,
    `- Verified locally before push: ${verify}`,
    "- Opened as a draft. Not auto-merged; review the diff before marking it ready.",
    "",
    "_Generated by ci-healer_",
    "",
  ].join("\n");
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
