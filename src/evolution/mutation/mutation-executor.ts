/**
 * HarnessMutationExecutor — the self-development ACTUATOR.
 *
 * Everything upstream of this component (targets, hypotheses, plans) decides
 * WHAT should change; this component performs the actual self-modification of
 * the harness and turns it into a verifiable candidate artifact:
 *
 *   prepareWorkspace  → isolated git worktree at the parent harness commit
 *   inspectTarget     → CodeChangePlan (pluggable mutation strategy)
 *   implement         → writes the planned edits into the worktree
 *   verify            → mutation-scope guard + command verification
 *   finalize          → candidate commit + diff artifact for the experiment
 *
 * The default inspection strategy is deterministic (it plans a
 * self-describing harness-policy edit anchored on the target). Real
 * self-modification plugs in a strategy backed by the agent runtime or an
 * LLM; the executor only demands that every produced edit:
 *   1. stays inside the mutation scope's component paths, and
 *   2. survives the workspace verification commands.
 */

import { execFile } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { HarnessComponent, HarnessDiagnosis } from "../types.js";
import { ImprovementTarget } from "../targets/target-engine.js";
import { pathWithinAllowedPrefix, protectedEvaluationPath } from "./path-scope.js";
import { MutationScope } from "./mutation-scope.js";

const execFileAsync = promisify(execFile);

// ── Workspace types ────────────────────────────────────────────────────────

export interface MutationWorkspaceInput {
  /** Path to the harness repository to mutate. */
  repoRoot: string;
  /** Base commit to mutate from (sha, branch, or "HEAD"). */
  parentCommit: string;
  candidateHarnessId: string;
  /** Override the generated branch name. */
  branchName?: string;
}

export interface MutationWorkspace {
  workspaceId: string;
  repoRoot: string;
  /** Isolated worktree the mutation is applied in. */
  worktreePath: string;
  branchName: string;
  parentCommit: string;
  candidateHarnessId: string;
  createdAt: number;
}

// ── Change plan types ──────────────────────────────────────────────────────

export interface PlannedEdit {
  /** Repo-relative file path (POSIX separators). */
  path: string;
  /** Full new file content. */
  content: string;
  component: HarnessComponent;
  rationale: string;
}

export interface CodeChangePlan {
  planId: string;
  targetId: string;
  summary: string;
  strategy: string;
  edits: PlannedEdit[];
  createdAt: number;
}

export interface InspectTargetContext {
  diagnosis?: HarnessDiagnosis;
  scope: MutationScope;
  /** Evidence-grounded experience digest the mutation agent may consult (v2.2). */
  experienceDigest?: string;
  /** Operational telemetry digest the mutation agent may consult (v2.2). */
  telemetryDigest?: string;
  /** Host repository root, when it differs from the worktree path (v2.2). */
  repoRoot?: string;
  /** Commit the candidate branches from (v2.2). */
  parentCommit?: string;
}

// ── Mutation result types ──────────────────────────────────────────────────

export interface MutationResult {
  appliedEdits: PlannedEdit[];
  /** Edits rejected by the scope guard (never written to the worktree). */
  rejectedEdits: Array<PlannedEdit & { reason: string }>;
  diffStat: string;
}

export interface MutationVerification {
  ok: boolean;
  /** True when every applied edit respects the mutation-scope paths. */
  scopeRespected: boolean;
  /** Planned edits rejected by the scope guard (path + reason). */
  scopeViolations: string[];
  /**
   * Paths that ACTUALLY changed on disk (git diff vs the parent commit plus
   * untracked files) but were never declared in the plan and are not covered
   * by extraAllowedPaths — the signature of a strategy/agent side effect.
   */
  actualDiffViolations: string[];
  /** Full audit list of what actually changed on disk at verification time. */
  actualChangedFiles: string[];
  commands: Array<{ command: string; exitCode: number; output: string }>;
}

export interface CandidateArtifact {
  workspace: MutationWorkspace;
  branchName: string;
  commitSha: string;
  commitMessage: string;
  diffStat: string;
  changedFiles: string[];
  plan: CodeChangePlan;
}

// ── Strategy interface ─────────────────────────────────────────────────────

export interface MutationStrategy {
  readonly name: string;
  inspectTarget(input: {
    worktreePath: string;
    target: ImprovementTarget;
    context: InspectTargetContext;
  }): Promise<CodeChangePlan> | CodeChangePlan;
}

/** Default component → allowed path prefixes (repo-relative, POSIX). */
export const DEFAULT_COMPONENT_PATHS: Record<HarnessComponent, string[]> = {
  execution: ["src/runtime/", "src/orchestration/"],
  tools: ["src/tools/", "src/skills/"],
  context: ["src/context/", "src/intelligence/"],
  state: ["src/memory/", "src/runtime/"],
  lifecycle: ["src/runtime/", "src/hooks/"],
  verification: ["src/validation/", "src/models/"],
  routing: ["src/models/", "src/intelligence/"],
  memory: ["src/memory/", "src/learning/"],
};

export interface MutationExecutorOptions {
  /**
   * Command runner injection (tests). Default spawns real git via execFile.
   * Receives argv-style args; cwd is the directory to run in.
   */
  run?: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
  /** Verification commands run in the worktree after implementing the plan. */
  verifyCommands?: string[][];
  /** Component → allowed repo-relative path prefixes for the scope guard. */
  componentPaths?: Partial<Record<HarnessComponent, string[]>>;
  /** Additional path prefixes always allowed (e.g. ["nexum.harness.json"]). */
  extraAllowedPaths?: string[];
  /**
   * Repository node_modules to link into fresh worktrees (v2.3.1). Real
   * verification profiles (tsc/eslint/jest) cannot run in a bare worktree —
   * `git worktree add` brings history, not dependencies. When set and the
   * worktree lacks node_modules, the host's is symlinked in after creation
   * so the configured verifyCommands execute against the real toolchain.
   * Dependency dirs are gitignored, so the linked tree never pollutes the
   * actual-diff scope audit.
   */
  linkNodeModulesFrom?: string;
  /** Mutation strategy producing the CodeChangePlan (default: heuristic). */
  strategy?: MutationStrategy;
  /** Root directory under which worktrees are created (default: os tmpdir). */
  worktreeParentDir?: string;
}

/** Minimal heuristic strategy: produces a self-describing harness policy edit. */
export class HeuristicMutationStrategy implements MutationStrategy {
  readonly name = "heuristic-policy-v1";

  inspectTarget(input: { target: ImprovementTarget; context: InspectTargetContext }): CodeChangePlan {
    const { target, context } = input;
    const component = context.scope.components[0];
    const policyPath = "nexum.harness.json";
    const policy = {
      version: 1,
      targetId: target.id,
      capability: target.capability,
      desiredOutcome: target.desiredOutcome,
      mustMoveMetrics: target.measurableMetrics,
      components: context.scope.components,
      rationale: context.scope.rationale,
      diagnosis: context.diagnosis
        ? { failureClass: context.diagnosis.failureClass, rootCause: context.diagnosis.rootCause }
        : undefined,
      generatedBy: this.name,
      createdAt: new Date().toISOString(),
    };
    return {
      planId: `plan-${target.id}-${Date.now()}`,
      targetId: target.id,
      summary: `Heuristic policy mutation for capability "${target.capability}" (component: ${component}).`,
      strategy: this.name,
      edits: [
        {
          path: policyPath,
          content: `${JSON.stringify(policy, null, 2)}\n`,
          component,
          rationale: `Encodes the formed target and mutation scope into the harness policy consumed by the runtime.`,
        },
      ],
      createdAt: Date.now(),
    };
  }
}

/**
 * Git-worktree based mutation executor. Each candidate is prepared in an
 * isolated worktree branched from the parent harness commit so parallel
 * experiments never interfere and the resulting diff is exactly the mutation.
 */
export class GitWorktreeMutationExecutor implements HarnessMutationExecutor {
  private readonly run: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
  private readonly verifyCommands: string[][];
  private readonly linkNodeModulesFrom?: string;
  private readonly componentPaths: Partial<Record<HarnessComponent, string[]>>;
  private readonly extraAllowedPaths: string[];
  private readonly strategy: MutationStrategy;
  private readonly worktreeParentDir?: string;
  private counter = 0;

  constructor(opts: MutationExecutorOptions = {}) {
    this.run = opts.run ?? defaultRun;
    this.verifyCommands = opts.verifyCommands ?? [["node", "--version"]];
    this.linkNodeModulesFrom = opts.linkNodeModulesFrom;
    this.componentPaths = opts.componentPaths ?? {};
    // The harness policy manifest is a root-level harness file that every
    // component mutation may legitimately encode its target into.
    this.extraAllowedPaths = opts.extraAllowedPaths ?? ["nexum.harness.json"];
    this.strategy = opts.strategy ?? new HeuristicMutationStrategy();
    this.worktreeParentDir = opts.worktreeParentDir;
  }

  /** Creates an isolated worktree at `parentCommit` on a fresh branch. */
  async prepareWorkspace(input: MutationWorkspaceInput): Promise<MutationWorkspace> {
    const branchName = input.branchName ?? `evolution/${input.candidateHarnessId.toLowerCase()}`;
    const workspaceId = `ws-${input.candidateHarnessId}-${Date.now()}-${this.counter++}`;
    const worktreePath = await this.makeWorktreePath(workspaceId);
    // v2.3.2: resolve the parent to its SHA ONCE, here. Symbolic refs like
    // "HEAD" are only valid until the candidate commit exists — finalize's
    // diff-vs-parent (and diffStat) would otherwise silently diff the
    // candidate against ITSELF and report empty changedFiles.
    const resolvedParentCommit = (
      await this.git(input.repoRoot, ["rev-parse", "--verify", `${input.parentCommit}^{commit}`])
    ).trim();
    await this.git(input.repoRoot, ["worktree", "prune"]);
    await this.git(input.repoRoot, ["worktree", "add", "-b", branchName, worktreePath, resolvedParentCommit]);
    // v2.3.1: link the host toolchain into the worktree so real verification
    // profiles (tsc/eslint/jest) can execute. Skipped when the host has no
    // node_modules or the worktree somehow already has one.
    if (this.linkNodeModulesFrom) {
      const hostModules = join(this.linkNodeModulesFrom, "node_modules");
      const worktreeModules = join(worktreePath, "node_modules");
      if (existsSync(hostModules) && !existsSync(worktreeModules)) {
        try {
          symlinkSync(hostModules, worktreeModules, "junction");
        } catch {
          // Non-fatal: verification will report the missing toolchain honestly.
        }
      }
    }
    return {
      workspaceId,
      repoRoot: input.repoRoot,
      worktreePath,
      branchName,
      parentCommit: resolvedParentCommit,
      candidateHarnessId: input.candidateHarnessId,
      createdAt: Date.now(),
    };
  }

  /** Produces the CodeChangePlan via the configured mutation strategy. */
  async inspectTarget(
    workspace: MutationWorkspace,
    target: ImprovementTarget,
    context: InspectTargetContext,
  ): Promise<CodeChangePlan> {
    return this.strategy.inspectTarget({ worktreePath: workspace.worktreePath, target, context });
  }

  /** Applies the plan to the worktree, enforcing the mutation-scope guard. */
  async implement(workspace: MutationWorkspace, plan: CodeChangePlan): Promise<MutationResult> {
    const applied: PlannedEdit[] = [];
    const rejected: Array<PlannedEdit & { reason: string }> = [];
    for (const edit of plan.edits) {
      const violation = this.scopeViolation(edit.path, edit.component);
      if (violation) {
        rejected.push({ ...edit, reason: violation });
        continue;
      }
      const abs = join(workspace.worktreePath, ...edit.path.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, edit.content, "utf8");
      applied.push(edit);
    }
    const diffStat = await this.diffStat(workspace);
    return { appliedEdits: applied, rejectedEdits: rejected, diffStat };
  }

  /**
   * Verifies the mutation. Two independent guards must pass:
   *
   *   1. PLANNED ⊆ ALLOWED  — every edit declared in the plan respects the
   *      mutation-scope component paths (plan-level intent check).
   *   2. ACTUAL ⊆ DECLARED ∪ EXTRAS — the paths that actually changed on
   *      disk (git diff vs the parent commit + untracked files, snapshotted
   *      BEFORE verification commands run so tool artifacts cannot pollute
   *      the audit) must all have been declared in the plan. A mutation
   *      strategy that secretly writes files outside its declared plan —
   *      the side-effect attack — fails here even when its plan looks clean.
   *
   * The invariant is: actual changed files ⊆ allowed mutation paths, with
   * "allowed" meaning declared-in-plan (and per-edit scope-checked) or
   * covered by the configured extraAllowedPaths carve-out.
   */
  async verify(workspace: MutationWorkspace, plan: CodeChangePlan): Promise<MutationVerification> {
    const scopeViolations: string[] = [];
    const declaredPaths = new Set<string>();
    for (const edit of plan.edits) {
      const violation = this.scopeViolation(edit.path, edit.component);
      if (violation) {
        scopeViolations.push(`${edit.path}: ${violation}`);
      } else {
        declaredPaths.add(this.normalizePath(edit.path));
      }
    }
    // Snapshot what actually landed on disk BEFORE verify commands execute:
    // strategy/agent side effects are already present, tool artifacts are not.
    const actualChangedFiles = await this.actualChangedPaths(workspace);
    const actualDiffViolations: string[] = [];
    for (const path of actualChangedFiles) {
      // Evaluation code is a violation even when declared or covered by an extra path.
      if (protectedEvaluationPath(path)) {
        actualDiffViolations.push(path);
        continue;
      }
      if (declaredPaths.has(path)) continue;
      if (this.extraAllowedPaths.some((extra) => pathWithinAllowedPrefix(path, extra))) continue;
      actualDiffViolations.push(path);
    }
    const commands: Array<{ command: string; exitCode: number; output: string }> = [];
    let commandsOk = true;
    for (const argv of this.verifyCommands) {
      const res = await this.run(argv, workspace.worktreePath);
      const output = (res.stdout ?? "").slice(-4000);
      commands.push({ command: argv.join(" "), exitCode: res.exitCode, output });
      if (res.exitCode !== 0) commandsOk = false;
    }
    const scopeRespected = scopeViolations.length === 0 && actualDiffViolations.length === 0;
    return {
      ok: scopeRespected && commandsOk,
      scopeRespected,
      scopeViolations,
      actualDiffViolations,
      actualChangedFiles,
      commands,
    };
  }

  /** Commits the mutation and returns the candidate artifact. */
  async finalize(
    workspace: MutationWorkspace,
    plan: CodeChangePlan,
    opts: { commitMessage?: string } = {},
  ): Promise<CandidateArtifact> {
    const commitMessage =
      opts.commitMessage ??
      `feat(evolution): harness mutation for ${plan.targetId}\n\nPlan: ${plan.summary}\nStrategy: ${plan.strategy}`;
    await this.git(workspace.worktreePath, ["add", "-A"]);
    const status = await this.run(
      ["git", "-C", workspace.worktreePath, "status", "--porcelain"],
      workspace.worktreePath,
    );
    if (status.stdout.trim() === "") {
      throw new Error(`Mutation produced no changes in ${workspace.worktreePath}`);
    }
    await this.git(workspace.worktreePath, [
      "-c",
      "user.name=Nexum Evolution",
      "-c",
      "user.email=evolution@nexum.local",
      "commit",
      "-m",
      commitMessage,
    ]);
    const sha = (await this.git(workspace.worktreePath, ["rev-parse", "HEAD"])).trim();
    const diffStat = await this.diffStat(workspace);
    const changedFilesRaw = await this.git(workspace.worktreePath, ["diff", "--name-only", workspace.parentCommit]);
    const changedFiles = changedFilesRaw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      workspace,
      branchName: workspace.branchName,
      commitSha: sha,
      commitMessage,
      diffStat,
      changedFiles,
      plan,
    };
  }

  /** Removes the worktree (experiments that were rejected or already merged). */
  async dispose(workspace: MutationWorkspace): Promise<void> {
    try {
      await this.git(workspace.repoRoot, ["worktree", "remove", "--force", workspace.worktreePath]);
    } catch {
      await this.git(workspace.repoRoot, ["worktree", "prune"]);
    }
  }

  /** True when the executor's git plumbing is available in this environment. */
  static async isSupported(): Promise<boolean> {
    try {
      await defaultRun(["git", "--version"], process.cwd());
      return true;
    } catch {
      return false;
    }
  }

  // ── internals ──

  private scopeViolation(path: string, component: HarnessComponent): string | null {
    if (isAbsolute(path) || path.includes("..")) {
      return "edit path must be repo-relative and must not escape the repository";
    }
    const normalized = this.normalizePath(path);
    const protectedPath = protectedEvaluationPath(normalized);
    if (protectedPath) return protectedPath;
    for (const extra of this.extraAllowedPaths) {
      if (pathWithinAllowedPrefix(normalized, extra)) return null;
    }
    const allowed = this.componentPaths[component] ?? DEFAULT_COMPONENT_PATHS[component] ?? ["src/"];
    if (allowed.some((prefix) => pathWithinAllowedPrefix(normalized, prefix))) return null;
    return `path "${normalized}" is outside the allowed paths for component "${component}" [${allowed.join(", ")}]`;
  }

  private normalizePath(path: string): string {
    return normalize(path).split(sep).join("/");
  }

  /**
   * Every path that actually differs from the parent commit right now:
   * tracked modifications (staged + unstaged) via git diff, plus untracked
   * files via git status. Renames contribute both endpoints.
   */
  private async actualChangedPaths(workspace: MutationWorkspace): Promise<string[]> {
    const paths = new Set<string>();
    try {
      const diff = await this.git(workspace.worktreePath, ["diff", "--name-only", workspace.parentCommit]);
      for (const line of diff.split("\n")) {
        const t = line.trim();
        if (t) paths.add(t);
      }
    } catch {
      // Diff unavailable (e.g. fake runners); status still catches untracked files.
    }
    try {
      const status = await this.git(workspace.worktreePath, ["status", "--porcelain", "-uall"]);
      for (const line of status.split("\n")) {
        if (line.trim() === "") continue;
        let entry = line.slice(3).trim();
        if (entry.startsWith('"') && entry.endsWith('"')) {
          entry = entry.slice(1, -1);
        }
        if (entry.includes(" -> ")) {
          const [from, to] = entry.split(" -> ");
          if (from.trim()) paths.add(from.trim());
          if (to.trim()) paths.add(to.trim());
        } else if (entry) {
          paths.add(entry);
        }
      }
    } catch {
      // Status unavailable — the diff above is the best-effort audit.
    }
    return [...paths].sort();
  }

  private async diffStat(workspace: MutationWorkspace): Promise<string> {
    try {
      return await this.git(workspace.worktreePath, ["diff", "--stat", workspace.parentCommit]);
    } catch {
      return "";
    }
  }

  private async makeWorktreePath(workspaceId: string): Promise<string> {
    const base = this.worktreeParentDir ?? "/tmp";
    return join(base, workspaceId);
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return this.run(["git", "-C", cwd, ...args], cwd).then((r) => {
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd} (exit ${r.exitCode})`);
      }
      return r.stdout;
    });
  }
}

/** Structural interface — implement this to swap in LLM-driven mutation. */
export interface HarnessMutationExecutor {
  prepareWorkspace(input: MutationWorkspaceInput): Promise<MutationWorkspace>;
  inspectTarget(
    workspace: MutationWorkspace,
    target: ImprovementTarget,
    context: InspectTargetContext,
  ): Promise<CodeChangePlan>;
  implement(workspace: MutationWorkspace, plan: CodeChangePlan): Promise<MutationResult>;
  verify(workspace: MutationWorkspace, plan: CodeChangePlan): Promise<MutationVerification>;
  finalize(
    workspace: MutationWorkspace,
    plan: CodeChangePlan,
    opts?: { commitMessage?: string },
  ): Promise<CandidateArtifact>;
  dispose(workspace: MutationWorkspace): Promise<void>;
}

function defaultRun(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return execFileAsync(args[0], args.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024 })
    .then((r) => ({ stdout: r.stdout, exitCode: 0 }))
    .catch((err: NodeJS.ErrnoException & { stdout?: string; code?: number | string }) => {
      if (typeof err.code === "number") {
        return { stdout: err.stdout ?? "", exitCode: err.code };
      }
      throw err;
    });
}
