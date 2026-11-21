import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../src/platform/workspace.js";
import { CheckpointStore } from "../../src/runtime/checkpoint.js";
import { SessionStore } from "../../src/runtime/session.js";

describe("platform/workspace — WorkspaceManager", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nexum-ws-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ensure() creates an empty .nexum and returns canonical paths", () => {
    expect(existsSync(join(root, ".nexum"))).toBe(false);
    const paths = new WorkspaceManager(root).ensure();
    expect(existsSync(paths.dir)).toBe(true);
    expect(paths.dir).toBe(join(root, ".nexum"));
    expect(paths.memoryDb).toBe(join(root, ".nexum", "memory.db"));
    expect(paths.sessionsDir).toBe(join(root, ".nexum", "sessions"));
    expect(paths.docsDb).toBe(join(root, ".nexum", "docs.db"));
    expect(paths.configFile).toBe(join(root, ".nexum", "config.json"));
    expect(paths.skillsDir).toBe(join(root, ".nexum", "skills"));
    expect(paths.lessonsDb).toBe(join(root, ".nexum", "lessons.db"));
  });

  it("ensure() is idempotent on an existing .nexum", () => {
    const first = new WorkspaceManager(root).ensure();
    expect(new WorkspaceManager(root).ensure()).toEqual(first);
  });

  it("a fresh session store opens from .nexum/sessions", () => {
    const paths = new WorkspaceManager(root).ensure();
    expect(new SessionStore(paths.sessionsDir).listSessions()).toEqual([]);
  });

  it("a fresh checkpoint loads as empty from .nexum", () => {
    const paths = new WorkspaceManager(root).ensure();
    expect(new CheckpointStore(paths.checkpoint).load()).toBeNull();
  });
});
