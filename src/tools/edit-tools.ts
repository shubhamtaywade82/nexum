import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Tool, ToolError } from "./tool.js";
import { guardPath, toGuard, type WorkspaceBoundary } from "./path-utils.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";
import { readVerified, writeVerified } from "./verified-fs.js";
import { enforceEditSyntax } from "../validation/edit-check.js";

export class PatchTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name() {
    return "patch_file";
  }
  get description() {
    return "Apply a find/replace patch to a UTF-8 file in the workspace.";
  }
  get parameters() {
    return {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
    };
  }
  async call(args: Record<string, unknown>) {
    const path = args.path as string;
    const find = args.find as string;
    const replace = args.replace as string;
    guardPath(this.guard, "patch", path);
    const content = (await readVerified(this.guard, "patch", path)).toString("utf-8");
    if (!content.includes(find)) throw new ToolError(`search block not found in ${path}`);
    const next = content.replace(find, replace);
    const syntaxWarning = enforceEditSyntax(path, content, next);
    await writeVerified(this.guard, path, next);
    return { path, bytesWritten: Buffer.byteLength(next, "utf-8"), ...(syntaxWarning ? { syntaxWarning } : {}) };
  }
}

export class AppendTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name() {
    return "append_file";
  }
  get description() {
    return "Append text to a UTF-8 file in the workspace.";
  }
  get parameters() {
    return {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    };
  }
  async call(args: Record<string, unknown>) {
    const path = args.path as string;
    const content = args.content as string;
    const target = guardPath(this.guard, "write", path);
    await mkdir(dirname(target), { recursive: true });
    // read-modify-replace through the race-checked helpers (not O_APPEND through a path)
    const existing = await readVerified(this.guard, "read", path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return Buffer.alloc(0);
      throw e;
    });
    const next = Buffer.concat([existing, Buffer.from(content, "utf-8")]);
    const syntaxWarning = enforceEditSyntax(path, existing.toString("utf-8"), next.toString("utf-8"));
    await writeVerified(this.guard, path, next);
    return { path, size: next.byteLength, ...(syntaxWarning ? { syntaxWarning } : {}) };
  }
}

// ── CAS-based editing primitives (review items 10 + 11) ─────────────────────

import { CasEditor, ExpectedHashMismatchError } from "./mutations/cas-editor.js";

/**
 * apply_patch — the PRIMARY editing primitive (review item 11): applies a
 * unified diff to a file, validated against the content hash the agent
 * observed when it read the file. Line editing (edit_file_lines) and
 * find/replace (patch_file) remain convenience tools on the same CAS
 * engine.
 */
export class ApplyPatchTool extends Tool {
  constructor(private readonly editor: CasEditor) {
    super();
  }
  get name() {
    return "apply_patch";
  }
  get description() {
    return "Apply a unified diff patch to a workspace file (primary editing primitive). Requires the content hash returned by read_file to guard against concurrent modification; dry_run=true returns the result diff without writing.";
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        patch: { type: "string", description: "Unified diff to apply" },
        expected_hash: {
          type: "string",
          description: "sha256 of the file content when it was read (from read_file). Required.",
        },
        dry_run: { type: "boolean", description: "Validate and diff without writing" },
      },
      required: ["path", "patch", "expected_hash"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    const patch = args.patch as string;
    const expectedHash = args.expected_hash as string;
    const dryRun = args.dry_run === true;
    try {
      const result = await this.editor.applyUnifiedDiff(path, expectedHash, patch, { dryRun });
      if (dryRun) {
        return {
          path,
          dry_run: true,
          diff: result.diff,
          new_hash_preview: result.newHash,
          bytes: result.bytesWritten,
          ...(result.syntaxWarning ? { syntax_warning: result.syntaxWarning } : {}),
        };
      }
      return {
        path,
        applied: true,
        previous_hash: result.previousHash,
        new_hash: result.newHash,
        diff: result.diff,
        bytes_written: result.bytesWritten,
        ...(result.syntaxWarning ? { syntax_warning: result.syntaxWarning } : {}),
      };
    } catch (e) {
      if (e instanceof ExpectedHashMismatchError) {
        return {
          error: "ExpectedHashMismatch",
          message: e.message,
          path,
          expected_hash: e.expectedHash,
          current_hash: e.currentHash,
          hint: "re-read the file, regenerate the patch against the new content hash, and retry",
        };
      }
      const err = e as Error;
      return { error: err.name ?? "PatchApplicationError", message: err.message };
    }
  }
}

/**
 * edit_file_lines — line-based editing with CAS (review item 10):
 * edits a line range, validated against the observed content hash:
 * read → hash → generate patch → verify expected hash → dry-run →
 * apply atomically → return diff.
 */
export class EditFileLinesTool extends Tool {
  constructor(private readonly editor: CasEditor) {
    super();
  }
  get name() {
    return "edit_file_lines";
  }
  get description() {
    return "Edit a contiguous line range of a workspace file (1-based, inclusive). Requires the content hash returned by read_file; the current file must still match that hash when the edit applies. dry_run=true validates without writing.";
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        from_line: { type: "integer", description: "First line to replace (1-based)" },
        to_line: { type: "integer", description: "Last line to replace (1-based, inclusive)" },
        new_lines: { type: "array", items: { type: "string" }, description: "Replacement lines" },
        expected_hash: { type: "string", description: "sha256 of the file content when it was read" },
        dry_run: { type: "boolean", description: "Validate and diff without writing" },
      },
      required: ["path", "from_line", "to_line", "new_lines", "expected_hash"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    const from = args.from_line as number;
    const to = args.to_line as number;
    const newLines = (args.new_lines as string[]) ?? [];
    const expectedHash = args.expected_hash as string;
    const dryRun = args.dry_run === true;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      return {
        error: "ValidationError",
        message: "from_line/to_line must be 1-based integers with to_line >= from_line",
      };
    }
    try {
      const result = await this.editor.editLines(
        path,
        expectedHash,
        (lines) => {
          if (to > lines.length) {
            throw Object.assign(new Error(`to_line ${to} exceeds file length ${lines.length}`), {
              name: "ValidationError",
            });
          }
          const next = [...lines.slice(0, from - 1), ...newLines, ...lines.slice(to)];
          return next;
        },
        { dryRun },
      );
      if (dryRun) {
        return {
          path,
          dry_run: true,
          diff: result.diff,
          new_hash_preview: result.newHash,
          ...(result.syntaxWarning ? { syntax_warning: result.syntaxWarning } : {}),
        };
      }
      return {
        path,
        applied: true,
        previous_hash: result.previousHash,
        new_hash: result.newHash,
        diff: result.diff,
        bytes_written: result.bytesWritten,
        ...(result.syntaxWarning ? { syntax_warning: result.syntaxWarning } : {}),
      };
    } catch (e) {
      if (e instanceof ExpectedHashMismatchError) {
        return {
          error: "ExpectedHashMismatch",
          message: e.message,
          path,
          expected_hash: e.expectedHash,
          current_hash: e.currentHash,
          hint: "re-read the file and retry with the new hash",
        };
      }
      const err = e as Error;
      return { error: err.name ?? "EditError", message: err.message };
    }
  }
}
