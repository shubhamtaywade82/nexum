/**
 * WorkspaceGuard — centralized filesystem isolation (review item 9).
 *
 * Every filesystem operation from every tool (read, write, delete, move,
 * copy, patch, watch) resolves its target through ONE guard, which
 * enforces:
 *
 *   1. workspace containment — the real path (symlinks resolved) must stay
 *      inside the workspace root (or the run's write scope when narrower);
 *   2. symlink escape — a path whose nearest EXISTING ancestor resolves
 *      outside the workspace is rejected, and a not-yet-existing target is
 *      validated through that nearest existing ancestor (handles
 *      symlinked directories pointing out of the tree);
 *   3. non-existent target paths — read/delete/move/copy/patch/watch of a
 *      missing file produce a structured NotFound verdict instead of an
 *      exception; write/create create parent directories inside the scope
 *      only;
 *   4. sensitive-path protection (.env, credentials, keys) on every
 *      mutating op — and, with `protectSensitiveReads`, on every
 *      content-revealing op (read, copy source, search). Sensitivity is
 *      judged on both the requested and the resolved path, so a symlink
 *      alias of a secret is still the secret.
 *
 * The guard returns VERDICTS (data), never throws for expected cases, so
 * tools map verdicts to structured ToolResults and policies can inspect
 * them. Programmers who want exceptions can use `requireAllowed`.
 */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isSensitivePath } from "../../safety/path-policy.js";
import { BRAND } from "../../platform/brand.js";
import {
  defaultCredentialLocations,
  findSensitivePaths,
  inodeKey,
  secretInodes,
  SensitiveScanLimitError,
  type SensitiveEntry,
} from "./sensitive-scan.js";

/** How long a computed secret-inode set is reused (hardlink checks are rare but bursty). */
const SECRET_INODE_TTL_MS = 10_000;

export type FsOperation =
  | "read"
  | "write"
  | "delete"
  | "move"
  | "copy"
  | "patch"
  | "watch"
  | "mkdir"
  /** Enumerate an existing directory (names only). */
  | "list"
  /** Search the contents of an existing file or directory tree. */
  | "search";

export interface FsVerdict {
  allowed: boolean;
  /**
   * Absolute real path (symlinks resolved). Set when allowed, and on
   * not_found / not_a_file / not_a_directory (all security rules passed).
   */
  resolvedPath?: string;
  code:
    | "ok"
    | "not_found"
    | "escape"
    | "symlink_escape"
    | "outside_write_scope"
    | "sensitive_path"
    | "not_a_file"
    | "not_a_directory"
    | "invalid_path";
  message: string;
}

const MUTATING: readonly FsOperation[] = ["write", "delete", "move", "patch", "mkdir"];
/** Ops that expose file contents to the caller (gated by protectSensitiveReads). */
const CONTENT_REVEALING: readonly FsOperation[] = ["read", "copy", "search"];
const EXPECTS_EXISTING: readonly FsOperation[] = ["read", "delete", "move", "copy", "patch", "watch", "list", "search"];

export interface WorkspaceGuardOptions {
  /** Workspace root (absolute). */
  root: string;
  /** Narrower write scope (absolute, inside root) — e.g. a task subtree. */
  writeScope?: string;
  /** Extra deny patterns for mutation (regex over the relative path). */
  denyPatterns?: RegExp[];
  /**
   * Also refuse content-revealing ops (read, copy source, search) on
   * sensitive paths. Off by default (generic infrastructure may need to read
   * them); agent-facing tool packs turn it on so secrets never reach model context.
   */
  protectSensitiveReads?: boolean;
  /**
   * Credential stores outside the workspace whose files a hardlink in the
   * workspace could alias (default: ~/.ssh, ~/.aws, ~/.gnupg, … ).
   */
  credentialLocations?: string[];
}

export class WorkspaceGuard {
  private readonly rootReal: string;
  private readonly writeScopeReal?: string;

  constructor(private readonly opts: WorkspaceGuardOptions) {
    this.rootReal = realOrPlain(opts.root);
    if (opts.writeScope) this.writeScopeReal = realOrPlain(opts.writeScope);
  }

  get root(): string {
    return this.rootReal;
  }

  get writeScope(): string | undefined {
    return this.writeScopeReal;
  }

  private secretInodeCache?: { at: number; inodes: Set<string> | "unknown" };

  /**
   * Inodes of all known secret files (workspace + credential locations),
   * briefly cached; "unknown" when the workspace was too large to scan.
   */
  secretInodes(): Set<string> | "unknown" {
    const now = Date.now();
    if (!this.secretInodeCache || now - this.secretInodeCache.at > SECRET_INODE_TTL_MS) {
      let inodes: Set<string> | "unknown";
      try {
        inodes = secretInodes(this.rootReal, this.opts.credentialLocations ?? defaultCredentialLocations());
      } catch (e) {
        if (!(e instanceof SensitiveScanLimitError)) throw e;
        inodes = "unknown";
      }
      this.secretInodeCache = { at: now, inodes };
    }
    return this.secretInodeCache.inodes;
  }

  /** True when `absolutePath` is a regular file hardlinked to a secret (same device + inode). */
  isHardlinkedSecret(absolutePath: string): boolean {
    let st;
    try {
      st = lstatSync(absolutePath);
    } catch {
      return false;
    }
    if (!st.isFile() || st.nlink <= 1) return false;
    const inodes = this.secretInodes();
    return inodes === "unknown" || inodes.has(inodeKey(st)); // fail closed when the scan could not finish
  }

  /** Central verdict for one operation on one path. */
  check(op: FsOperation, relativePath: string): FsVerdict {
    if (typeof relativePath !== "string" || relativePath === "") {
      return { allowed: false, code: "invalid_path", message: "path must be a non-empty string" };
    }

    // absolute paths are re-anchored relative to the root
    const rel =
      relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)
        ? relative(this.rootReal, resolve(relativePath))
        : relativePath;
    const nominal = resolve(join(this.rootReal, rel));

    // Lexical containment first: a path written with ../ that is already
    // outside the root is a plain escape (no symlink analysis needed).
    const relNominal = relative(this.rootReal, nominal);
    if (relNominal === ".." || relNominal.startsWith(`..${sep}`) || relNominal.startsWith(sep)) {
      return {
        allowed: false,
        code: "escape",
        message: `${relativePath} resolves outside the workspace root`,
      };
    }

    // Symlink-aware resolution: walk to the nearest existing ancestor and
    // resolve the remainder from there (review item 9 — a symlinked
    // directory whose real location is outside the root is rejected even
    // when the lexical path looks inside).
    const { nearest, remainder } = nearestExistingAncestor(nominal);
    const nearestReal = realOrPlain(nearest);
    if (nearest !== nominal) {
      const relNearest = relative(this.rootReal, nearestReal);
      if (relNearest === ".." || relNearest.startsWith(`..${sep}`) || relNearest.startsWith(sep)) {
        return {
          allowed: false,
          code: "symlink_escape",
          message: `${relativePath} traverses a symlink (${nearest}) that resolves outside the workspace`,
        };
      }
    }
    const resolvedPath = remainder ? resolve(join(nearestReal, remainder)) : nearestReal;

    // containment of the final resolved target
    const relFinal = relative(this.rootReal, resolvedPath);
    if (relFinal === ".." || relFinal.startsWith(`..${sep}`) || relFinal.startsWith(sep)) {
      return {
        allowed: false,
        code: "escape",
        message: `${relativePath} resolves outside the workspace root`,
      };
    }

    if ((op === "delete" || op === "move") && relFinal === "") {
      return { allowed: false, code: "invalid_path", message: "the workspace root itself cannot be deleted or moved" };
    }

    // write scope (mutations must land in the narrower scope when set)
    const mutating = MUTATING.includes(op);
    if (mutating && this.writeScopeReal) {
      const relScope = relative(this.writeScopeReal, resolvedPath);
      if (relScope === ".." || relScope.startsWith(`..${sep}`) || relScope.startsWith(sep)) {
        return {
          allowed: false,
          code: "outside_write_scope",
          message: `${relativePath} is outside the run's write scope`,
        };
      }
    }

    // sensitive paths: mutation always blocked; content-revealing ops when protected.
    // Both the requested and the resolved path count (a symlink alias of a secret is the secret).
    const sensitiveGated = mutating || (this.opts.protectSensitiveReads === true && CONTENT_REVEALING.includes(op));
    if (sensitiveGated && (sensitive(relFinal) || sensitive(relNominal))) {
      return {
        allowed: false,
        code: "sensitive_path",
        message: `${relativePath} matches a protected credential/secret pattern`,
      };
    }

    // a hardlink is the secret under another name: content-revealing ops on one are sensitive too
    if (
      this.opts.protectSensitiveReads === true &&
      CONTENT_REVEALING.includes(op) &&
      this.isHardlinkedSecret(resolvedPath)
    ) {
      return {
        allowed: false,
        code: "sensitive_path",
        message: `${relativePath} is a hardlink to a protected credential/secret file`,
      };
    }

    // git internals: a planted hook or core.fsmonitor/hooksPath in .git/config
    // would execute on the HOST at the next git command — file tools never write there.
    if (mutating && (isGitInternal(relFinal) || isGitInternal(relNominal))) {
      return {
        allowed: false,
        code: "sensitive_path",
        message: `${relativePath} is inside .git/ — git internals are changed through git, not file tools`,
      };
    }

    // Nexum's own state (.nexum/, legacy .devagent/): config, plugin installs,
    // publisher trust store, MCP approvals. An agent that could write there
    // could turn its own sandbox off or trust its own plugins.
    if (mutating && (isStateDir(relFinal) || isStateDir(relNominal))) {
      return {
        allowed: false,
        code: "sensitive_path",
        message: `${relativePath} is inside Nexum's state directory — configuration and trust are changed by the user, not file tools`,
      };
    }

    // deleting a directory must not take protected files with it
    if (op === "delete" && existsSync(resolvedPath) && lstatSync(resolvedPath).isDirectory()) {
      let inside: SensitiveEntry[];
      try {
        inside = findSensitivePaths(this.rootReal, resolvedPath);
      } catch (e) {
        if (!(e instanceof SensitiveScanLimitError)) throw e;
        return {
          allowed: false,
          code: "sensitive_path",
          message: `${relativePath} is too large to check for protected files (>${e.limit} entries); delete it outside the agent`,
        };
      }
      if (inside.length > 0) {
        const sample = inside
          .slice(0, 3)
          .map((f) => relative(this.rootReal, f.path))
          .join(", ");
        return {
          allowed: false,
          code: "sensitive_path",
          message: `${relativePath} contains protected credential/secret files (${sample}${inside.length > 3 ? ", …" : ""})`,
        };
      }
    }

    // extra deny patterns
    if (mutating) {
      for (const pattern of this.opts.denyPatterns ?? []) {
        if (pattern.test(relFinal)) {
          return {
            allowed: false,
            code: "sensitive_path",
            message: `${relativePath} matches a workspace deny pattern`,
          };
        }
      }
    }

    // existence semantics per operation — checked LAST, after every security
    // rule, so these verdicts may carry resolvedPath (the path is permitted;
    // it just is not the expected kind of thing).
    const existsTarget = existsSync(resolvedPath);
    if (EXPECTS_EXISTING.includes(op) && !existsTarget) {
      return {
        allowed: false,
        resolvedPath,
        code: "not_found",
        message: `${relativePath} does not exist (checked ${resolvedPath})`,
      };
    }
    if ((op === "read" || op === "copy" || op === "patch") && existsTarget && !statSync(resolvedPath).isFile()) {
      return { allowed: false, resolvedPath, code: "not_a_file", message: `${relativePath} is not a regular file` };
    }
    if (op === "list" && existsTarget && !statSync(resolvedPath).isDirectory()) {
      return { allowed: false, resolvedPath, code: "not_a_directory", message: `${relativePath} is not a directory` };
    }

    return { allowed: true, resolvedPath, code: "ok", message: "ok" };
  }

  /** Throwing variant for tools that prefer exceptions. */
  requireAllowed(op: FsOperation, relativePath: string): string {
    const verdict = this.check(op, relativePath);
    if (!verdict.allowed || !verdict.resolvedPath) {
      throw new WorkspacePathError(verdict);
    }
    return verdict.resolvedPath;
  }

  /** Validate a source/destination pair for move/copy. */
  checkPair(op: "move" | "copy", from: string, to: string): { from: FsVerdict; to: FsVerdict } {
    const fromVerdict = this.check(op, from);
    const toVerdict = this.check("write", to);
    return { from: fromVerdict, to: toVerdict };
  }
}

export class WorkspacePathError extends Error {
  constructor(public readonly verdict: FsVerdict) {
    super(verdict.message);
    this.name = "WorkspacePathError";
  }
}

// ── internals ───────────────────────────────────────────────────────────────

function realOrPlain(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Nearest existing ancestor of a path + the non-existent remainder. */
function nearestExistingAncestor(p: string): { nearest: string; remainder: string } {
  let probe = p;
  const parts: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    parts.unshift(probe.slice(parent.length + sep.length) || probe);
    probe = parent;
    if (parts.length > 64) break; // pathological depth guard
  }
  if (parts.length === 0) return { nearest: p, remainder: "" };
  return { nearest: probe, remainder: parts.join(sep) };
}

function isGitInternal(relPath: string): boolean {
  return relPath === ".git" || relPath.startsWith(`.git${sep}`);
}

/** Workspace state directories Nexum reads configuration and trust from. */
export const STATE_DIRS: readonly string[] = [BRAND.configDir, BRAND.legacyConfigDir];

function isStateDir(relPath: string): boolean {
  return STATE_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}${sep}`));
}

/** Sensitive as a file, or as a directory (so `secrets` / `.ssh` themselves are covered). */
function sensitive(relPath: string): boolean {
  return relPath !== "" && (isSensitivePath(relPath) || isSensitivePath(`${relPath}${sep}`));
}

/** Is the path a dangling symlink? (watch/patch tools want to know) */
export function isDanglingSymlink(p: string): boolean {
  try {
    lstatSync(p);
    return !existsSync(p);
  } catch {
    return false;
  }
}
