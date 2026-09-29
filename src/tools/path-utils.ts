import { WorkspaceGuard, type FsOperation } from "../core/fs/workspace-guard.js";
import { ToolError } from "./tool.js";

/** The path left the workspace (or the run's write scope), or is not a valid path. */
export class PathEscapeError extends ToolError {}

/** The path is a credential/secret the agent may not read or change. */
export class SensitivePathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`access to sensitive path blocked: ${path} (${reason})`);
    this.name = "SensitivePathError";
  }
}

/**
 * A tool's filesystem boundary: a shared WorkspaceGuard, or a root from which
 * an agent-facing guard (sensitive reads protected) is built.
 */
export type WorkspaceBoundary = WorkspaceGuard | string;

export function agentWorkspaceGuard(root: string): WorkspaceGuard {
  return new WorkspaceGuard({ root, protectSensitiveReads: true });
}

export function toGuard(boundary: WorkspaceBoundary): WorkspaceGuard {
  return typeof boundary === "string" ? agentWorkspaceGuard(boundary) : boundary;
}

/**
 * Resolve `path` for `op` through the guard and return the real absolute path.
 * Security verdicts map onto the tool-facing error contract (containment /
 * write scope → PathEscapeError, secrets → SensitivePathError). A permitted
 * path that is missing or the wrong kind still resolves, so the fs call
 * reports its native error (ENOENT, EISDIR, …) as before.
 */
export function guardPath(guard: WorkspaceGuard, op: FsOperation, path: string): string {
  const verdict = guard.check(op, path);
  if (verdict.allowed && verdict.resolvedPath) return verdict.resolvedPath;
  switch (verdict.code) {
    case "sensitive_path":
      throw new SensitivePathError(path, verdict.message);
    case "not_found":
    case "not_a_file":
    case "not_a_directory":
      if (verdict.resolvedPath) return verdict.resolvedPath;
      throw new ToolError(verdict.message);
    case "escape":
    case "symlink_escape":
      throw new PathEscapeError(`${path} escapes workspace root (${verdict.message})`);
    default:
      throw new PathEscapeError(verdict.message);
  }
}
