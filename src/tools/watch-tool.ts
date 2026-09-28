import { watch as fsWatch } from "node:fs/promises";
import { Tool } from "./tool.js";
import { guardPath, toGuard, type WorkspaceBoundary } from "./path-utils.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";

export class WatchTool extends Tool {
  private watchers = new Map<string, AbortController>();
  private readonly guard: WorkspaceGuard;

  constructor(boundary: WorkspaceBoundary) {
    super();
    this.guard = toGuard(boundary);
  }
  get name(): string {
    return "watch";
  }
  get description(): string {
    return "Watch a file for changes and return on next modification.";
  }
  get parameters(): Record<string, unknown> {
    return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = args.path as string;
    if (!path) return { error: "ArgumentError", message: "missing path" };
    const target = guardPath(this.guard, "watch", path);
    const ac = new AbortController();
    this.watchers.set(path, ac);
    try {
      for await (const _event of fsWatch(target, { signal: ac.signal })) {
        this.watchers.delete(path);
        return { path, changed: true };
      }
    } catch (e: unknown) {
      this.watchers.delete(path);
      if ((e as { name?: string }).name === "AbortError") {
        return { path, changed: false, stopped: true };
      }
      return { error: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) };
    }
    return { path, changed: false };
  }
}
