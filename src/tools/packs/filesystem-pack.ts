/**
 * FilesystemPack (review item 21) — workspace file operations.
 *
 * read/write/list/copy/move/delete/watch + the CAS editing primitives
 * (apply_patch primary, edit_file_lines convenience, find/replace legacy)
 * + workspace code search.
 */

import { ReadFileTool, WriteFileTool } from "../filesystem.js";
import {
  ListDirectoryTool,
  DeleteFileTool,
  MakeDirectoryTool,
  CopyFileTool,
  MoveFileTool,
} from "../directory-tools.js";
import { PatchTool, AppendTool, ApplyPatchTool, EditFileLinesTool } from "../edit-tools.js";
import { CasEditor } from "../mutations/cas-editor.js";
import { toGuard, type WorkspaceBoundary } from "../path-utils.js";
import { SnapshotBackupTool } from "../backup-tools.js";
import { WatchTool } from "../watch-tool.js";
import { SearchCodeTool } from "../search-tools.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";

/**
 * Filesystem CRUD + CAS patch + watch — the DevAgent's core mutation surface.
 * Every tool resolves paths through ONE WorkspaceGuard (pass a shared guard to
 * apply a write scope / deny patterns; a bare root gets the agent default).
 */
export function filesystemPack(boundary: WorkspaceBoundary): ToolPack {
  const guard = toGuard(boundary);
  const editor = new CasEditor({ guard });
  return packOf(
    "filesystem",
    "Workspace file operations: read, write, list, copy, move, delete, patch (CAS), watch.",
    "filesystem",
    [
      [new ReadFileTool(guard), { policy: { uiInvocable: true } }],
      new WriteFileTool(guard),
      [new ListDirectoryTool(guard), { policy: { uiInvocable: true } }],
      new DeleteFileTool(guard),
      new MakeDirectoryTool(guard),
      new CopyFileTool(guard),
      new MoveFileTool(guard),
      [new ApplyPatchTool(editor), { risk: "medium", execution: { reversible: true } }],
      [new EditFileLinesTool(editor), { risk: "medium", execution: { reversible: true } }],
      new PatchTool(guard),
      new AppendTool(guard),
      new SnapshotBackupTool(guard),
      new WatchTool(guard),
    ],
    "Filesystem",
  );
}

/** Workspace code search (kept inside the FilesystemPack family). */
export function searchPack(boundary: WorkspaceBoundary): ToolPack {
  return packOf(
    "search",
    "Workspace code search.",
    "search",
    [[new SearchCodeTool(toGuard(boundary)), { policy: { uiInvocable: true } }]],
    "Search",
  );
}
