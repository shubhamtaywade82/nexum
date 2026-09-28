import { mkdir, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Tool } from "./tool.js";
import { guardPath, toGuard, type WorkspaceBoundary } from "./path-utils.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";
import { workspaceStateDir } from "../platform/paths.js";

// Backups live under the canonical workspace state dir — resolved via the
// platform layer, never a hardcoded brand path (docs/REBRANDING.md §2).

export class SnapshotBackupTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "snapshot_backup";
  }
  get description(): string {
    return "Create a timestamped backup of a file before modifying it.";
  }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = guardPath(this.guard, "copy", path);
    const backupRoot = join(workspaceStateDir(this.guard.root), "backups");
    await mkdir(backupRoot, { recursive: true });
    const timestamp = Date.now();
    const backupPath = join(backupRoot, `${path.replace(/\//g, "_")}.${timestamp}.bak`);
    try {
      await copyFile(target, backupPath);
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, backupPath: relative(this.guard.root, backupPath), timestamp };
  }
}
