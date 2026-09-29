import { readdir, stat, rm, mkdir, rename } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Tool } from "./tool.js";
import { guardPath, toGuard, PathEscapeError, SensitivePathError, type WorkspaceBoundary } from "./path-utils.js";
import { readVerified, revalidate, writeVerified } from "./verified-fs.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";

export class ListDirectoryTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "list_directory";
  }
  get description(): string {
    return "List files and directories at a path relative to the workspace root. Defaults to workspace root if no path given.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace root (defaults to root)" },
      },
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = (args.path as string) || ".";
    const target = guardPath(this.guard, "list", path);
    const entries: { name: string; path: string; type: "file" | "directory" }[] = [];
    try {
      for (const name of await readdir(target)) {
        const item = resolve(target, name);
        const rel = relative(this.guard.root, item);
        let type: "file" | "directory" = "file";
        try {
          const s = await stat(item);
          type = s.isDirectory() ? "directory" : "file";
        } catch {
          /* stat failed */
        }
        entries.push({ name, path: rel, type });
      }
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, entries };
  }
}

export class DeleteFileTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "delete_file";
  }
  get description(): string {
    return "Remove a file or directory recursively.";
  }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = guardPath(this.guard, "delete", path);
    await revalidate(this.guard, "delete", path, target);
    try {
      await rm(target, { recursive: true, force: true });
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, removed: true };
  }
}

export class MakeDirectoryTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "make_directory";
  }
  get description(): string {
    return "Create a directory within the workspace, including parents.";
  }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = guardPath(this.guard, "mkdir", path);
    await revalidate(this.guard, "mkdir", path, target);
    try {
      await mkdir(target, { recursive: true });
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, created: true };
  }
}

export class CopyFileTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "copy_file";
  }
  get description(): string {
    return "Copy a file or directory within the workspace.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { source: { type: "string" }, destination: { type: "string" } },
      required: ["source", "destination"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = args.source as string;
    const destination = args.destination as string;
    if (!source || !destination) return { error: "ArgumentError", message: "source and destination are required" };
    guardPath(this.guard, "copy", source);
    guardPath(this.guard, "write", destination);
    try {
      await writeVerified(this.guard, destination, await readVerified(this.guard, "copy", source));
    } catch (e) {
      if (e instanceof PathEscapeError || e instanceof SensitivePathError) throw e;
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { source, destination, copied: true };
  }
}

export class MoveFileTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "move_file";
  }
  get description(): string {
    return "Move or rename a file within the workspace.";
  }
  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { source: { type: "string" }, destination: { type: "string" } },
      required: ["source", "destination"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = args.source as string;
    const destination = args.destination as string;
    if (!source || !destination) return { error: "ArgumentError", message: "source and destination are required" };
    const src = guardPath(this.guard, "move", source);
    const dest = guardPath(this.guard, "write", destination);
    await revalidate(this.guard, "move", source, src);
    await revalidate(this.guard, "write", destination, dest);
    try {
      await rename(src, dest);
    } catch (e) {
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { source, destination, moved: true };
  }
}
