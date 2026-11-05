/**
 * ManifestRuntimeActivationController — the PRODUCTION
 * RuntimeActivationController (v2.3.3).
 *
 * The seam in runtime-activation.ts describes the runtime half of activation
 * and rollback ("the process that actually executes the harness"). For Nexum
 * that process would be a harness manifest consumer, which loads
 * `nexum.harness.json` to know which harness version to execute. That consumer
 * is the launcher in bin/cli.js (src/platform/harness-launcher.ts): an agent
 * command started from the checkout runs the pointer's commit, and a `frozen`
 * marker makes it refuse to start. The file is the ACTIVATION CONTRACT:
 *
 *   switchTo(H(n))  →  resolve H(n) to a commit (registry first, then any
 *                      git-resolvable ref) → verify the commit exists in the
 *                      repository → atomically write the `activeHarness`
 *                      pointer into the manifest → re-read and verify the
 *                      pointer actually landed.
 *
 * Design constraints honored:
 *   - FAIL-CLOSED: switching to an unknown harness (no registry row and no
 *     resolvable git ref) throws; nothing is written.
 *   - ATOMIC: the pointer update is tmp-file + rename in the manifest's
 *     directory; a crashed write can never leave a half-file manifest.
 *   - SELF-VERIFYING: after the write the manifest is re-read and the
 *     pointer checked; a mismatch restores the previous content and throws.
 *   - PRESERVING: strategy-written manifest fields (target, scope, policy)
 *     survive activation writes untouched.
 *   - HEALTH IS REAL: harnessHealth() verifies the harness's commit exists
 *     in the repository (git cat-file), so the rollback orchestrator's
 *     post-switch verification is external reality, not self-report.
 *
 * Default OFF: the CLI only wires this controller under the explicit
 * `--activate-runtime` flag, and the engine only calls switchTo() for an
 * experiment that reached ACTIVE (CI passed + review approved).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HarnessRegistry } from "../registry.js";
import { RuntimeActivationController } from "./runtime-activation.js";

const execFileAsync = promisify(execFile);

/** The harness manifest every runtime consumer reads (root of the repo). */
export const NEXUM_HARNESS_MANIFEST_PATH = "nexum.harness.json";

/** The activation pointer this controller maintains inside the manifest. */
export interface ManifestActiveHarness {
  id: string;
  commitSha: string;
  activatedAt: number;
}

export interface ManifestRuntimeActivationOptions {
  /** Repository whose manifest is the activation contract. */
  repoRoot: string;
  /**
   * Harness lineage registry. Harness ids registered here resolve to their
   * recorded commit; ids NOT in the registry may still activate when they
   * resolve as git refs (e.g. "HEAD", a SHA, a branch). Optional only for
   * read APIs — switchTo() needs at least git resolution.
   */
  registry?: HarnessRegistry;
  /** Manifest path override (default: <repoRoot>/nexum.harness.json). */
  manifestPath?: string;
  /** Command runner injection (tests). Default spawns real git. */
  run?: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
  now?: () => number;
}

function defaultRun(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return execFileAsync(args[0], args.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024 })
    .then((r) => ({ stdout: r.stdout, exitCode: 0 }))
    .catch((err: NodeJS.ErrnoException & { stdout?: string; code?: number | string }) => {
      if (typeof err.code === "number") return { stdout: err.stdout ?? "", exitCode: err.code };
      throw err;
    });
}

export class ManifestRuntimeActivationController implements RuntimeActivationController {
  readonly name = "manifest-file-runtime";
  private readonly repoRoot: string;
  private readonly registry?: HarnessRegistry;
  private readonly manifestPath: string;
  private readonly run: (args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
  private readonly now: () => number;

  constructor(opts: ManifestRuntimeActivationOptions) {
    this.repoRoot = opts.repoRoot;
    this.registry = opts.registry;
    this.manifestPath = opts.manifestPath ?? join(opts.repoRoot, NEXUM_HARNESS_MANIFEST_PATH);
    this.run = opts.run ?? defaultRun;
    this.now = opts.now ?? Date.now;
  }

  /** The harness the runtime currently executes (pointer → registry → unversioned). */
  activeHarness(): string {
    const pointer = this.readPointer();
    if (pointer) return pointer.id;
    const registryActive = this.registry?.getActiveVersion();
    return registryActive?.id ?? "unversioned";
  }

  /** The activation pointer recorded in the manifest, when any. */
  readPointer(): ManifestActiveHarness | null {
    if (!existsSync(this.manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Record<string, unknown>;
    const pointer = manifest.activeHarness as ManifestActiveHarness | undefined;
    return pointer && typeof pointer.id === "string" && typeof pointer.commitSha === "string" ? pointer : null;
  }

  /**
   * Atomically switches the runtime onto `harnessId` by updating the
   * manifest pointer. Throws (writing NOTHING) when the harness cannot be
   * resolved to a commit that exists in the repository.
   */
  async switchTo(harnessId: string): Promise<void> {
    const commitSha = await this.resolveCommit(harnessId);
    if (!commitSha) {
      throw new Error(
        `Cannot switch runtime to unknown harness "${harnessId}": not in the harness registry and not a git-resolvable ref.`,
      );
    }
    if (!(await this.commitExists(commitSha))) {
      throw new Error(`Cannot switch runtime to "${harnessId}": commit ${commitSha} is missing from the repository.`);
    }

    const previous = this.readManifestForWrite();
    const manifest: Record<string, unknown> = { ...previous };
    // A successful switch IS the unfreeze: the freeze marker exists to stop
    // new work while a rollback is in flight, and the runtime has now landed
    // on a verified harness.
    delete manifest.frozen;
    manifest.activeHarness = { id: harnessId, commitSha, activatedAt: this.now() } satisfies ManifestActiveHarness;
    this.writeManifestAtomic(manifest);

    // Self-verify: the pointer must actually be readable back.
    const readBack = this.readPointer();
    if (!readBack || readBack.id !== harnessId || readBack.commitSha !== commitSha) {
      // Restore the previous content so a failed switch never half-lands.
      this.writeManifestAtomic(previous);
      throw new Error(`Runtime switch to "${harnessId}" failed verification; manifest restored.`);
    }
  }

  /**
   * Real health probe: the harness must resolve to a commit that exists in
   * the repository. Registry rows with pruned/missing commits are unhealthy.
   */
  async harnessHealth(harnessId: string): Promise<boolean> {
    const commitSha = await this.resolveCommit(harnessId);
    if (!commitSha) return false;
    return this.commitExists(commitSha);
  }

  /**
   * Freeze hook for the rollback orchestrator: marks the manifest so
   * manifest consumers can refuse to start new work while a rollback is in
   * flight. Cleared by the next switchTo() (a successful switch is the
   * unfreeze).
   */
  async freeze(): Promise<void> {
    const manifest = this.readManifestForWrite();
    manifest.frozen = { at: this.now(), reason: "runtime rollback in flight" };
    this.writeManifestAtomic(manifest);
  }

  /** True when the manifest carries a freeze marker. */
  isFrozen(): boolean {
    if (!existsSync(this.manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Record<string, unknown>;
    return manifest.frozen !== undefined;
  }

  /**
   * Resolves a harness id to a commit SHA: registry lineage first, then any
   * git-resolvable ref. Returns null when neither source knows the id.
   */
  private async resolveCommit(harnessId: string): Promise<string | null> {
    const registered = this.registry?.getVersion(harnessId);
    if (registered?.commitSha) return registered.commitSha;
    const probe = await this.run(["git", "rev-parse", "--verify", `${harnessId}^{commit}`], this.repoRoot);
    if (probe.exitCode !== 0) return null;
    const sha = probe.stdout.trim();
    return sha.length >= 40 ? sha : null;
  }

  private async commitExists(commitSha: string): Promise<boolean> {
    const probe = await this.run(["git", "cat-file", "-e", `${commitSha}^{commit}`], this.repoRoot);
    return probe.exitCode === 0;
  }

  /**
   * Reads the manifest for a read-modify-write cycle. A CORRUPT manifest
   * throws instead of being silently replaced: the file may carry
   * strategy-written policy that must not be clobbered by activation.
   */
  private readManifestForWrite(): Record<string, unknown> {
    if (!existsSync(this.manifestPath)) return {};
    return JSON.parse(readFileSync(this.manifestPath, "utf8")) as Record<string, unknown>;
  }

  /** tmp-file + rename inside the manifest's directory (atomic on POSIX). */
  private writeManifestAtomic(manifest: Record<string, unknown>): void {
    const tmp = `${this.manifestPath}.tmp-${process.pid}-${this.now()}`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, this.manifestPath); // tmp lives in the same dir → atomic
  }
}
