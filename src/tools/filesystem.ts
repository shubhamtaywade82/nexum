import { readFile, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Tool } from "./tool.js";
import { guardPath, toGuard, PathEscapeError, SensitivePathError, type WorkspaceBoundary } from "./path-utils.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";

export { PathEscapeError, SensitivePathError };

/** sha256 of the (truncated) content — the CAS token for apply_patch/edit_file_lines (review items 10/11). */
function stampHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class ReadFileTool extends Tool {
  // The result is fed straight back into the model as a tool message, so this
  // is a context-window ceiling, not a storage limit — matched to
  // ShellTool.MAX_OUTPUT_BYTES for the same reason. Without it a single
  // read_file on a lockfile or a log could blow the whole context, even though
  // the system prompt already promises callers a `truncated` flag.
  static readonly MAX_CONTENT_BYTES = 32 * 1024;
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }

  get name(): string {
    return "read_file";
  }

  get description(): string {
    return "Read a UTF-8 text file relative to the workspace root. Long files are truncated; the result reports `truncated`, `bytesRead` and `totalBytes`.";
  }

  override get capabilities(): string[] {
    return ["File System"];
  }

  override get tags(): string[] {
    return ["read", "file", "view", "cat", "open", "show", "inspect"];
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = args.path as string;
    const path = guardPath(this.guard, "read", relPath);

    // Read as bytes and cut on a byte boundary, then decode — slicing the
    // decoded string would count UTF-16 code units against a byte budget and
    // could split a multi-byte character.
    const raw = await readFile(path);
    const totalBytes = raw.byteLength;
    const truncated = totalBytes > ReadFileTool.MAX_CONTENT_BYTES;
    const slice = truncated ? raw.subarray(0, ReadFileTool.MAX_CONTENT_BYTES) : raw;
    // `fatal: false` (the default) replaces a trailing partial character with
    // U+FFFD rather than throwing.
    const content = new TextDecoder("utf-8").decode(slice);

    return {
      path: relPath,
      content,
      truncated,
      bytesRead: slice.byteLength,
      totalBytes,
      // CAS token (review item 10): pass as expected_hash to apply_patch /
      // edit_file_lines so mutations verify the version the agent observed.
      hash: stampHash(content),
    };
  }
}

export class WriteFileTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }

  get name(): string {
    return "write_file";
  }

  get description(): string {
    return "Write a UTF-8 text file relative to the workspace root. Overwrites atomically.";
  }

  override get capabilities(): string[] {
    return ["File System"];
  }

  override get tags(): string[] {
    return ["write", "file", "create", "save", "update", "new"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const relPath = args.path as string;
    const content = args.content as string;
    const path = guardPath(this.guard, "write", relPath);
    await mkdir(dirname(path), { recursive: true });

    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    try {
      await writeFile(tmp, content, "utf-8");
      await rename(tmp, path);
      return { path: relPath, bytesWritten: Buffer.byteLength(content, "utf-8") };
    } finally {
      try {
        await stat(tmp);
        await unlink(tmp);
      } catch {
        // tmp already gone (rename succeeded) — nothing to clean up
      }
    }
  }
}
