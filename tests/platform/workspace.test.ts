import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager, migrateGlobalState } from "../../src/platform/workspace.js";
import { CheckpointStore } from "../../src/runtime/checkpoint.js";
import { SessionStore } from "../../src/runtime/session.js";

/** Build a realistic legacy `.devagent` workspace with every state entry. */
function buildLegacyWorkspace(root: string): void {
  const legacy = join(root, ".devagent");
  mkdirSync(join(legacy, "sessions"), { recursive: true });
  mkdirSync(join(legacy, "skills", "demo-skill"), { recursive: true });
  mkdirSync(join(legacy, "backups"), { recursive: true });
  writeFileSync(join(legacy, "memory.db"), "legacy-memory");
  writeFileSync(join(legacy, "checkpoint.json"), "{}");
  writeFileSync(join(legacy, "docs.db"), "legacy-docs");
  writeFileSync(join(legacy, "config.json"), JSON.stringify({ model: "legacy-model" }));
  writeFileSync(join(legacy, "models.json"), "{}");
  writeFileSync(join(legacy, "lessons.db"), "legacy-lessons");
  writeFileSync(join(legacy, "history.json"), JSON.stringify(["old command"]));
  writeFileSync(join(legacy, "rails-index.db"), "legacy-rails");
  writeFileSync(join(legacy, "sessions", "session-1.json"), JSON.stringify({ messages: [] }));
  writeFileSync(
    join(legacy, "sessions", "index.json"),
    JSON.stringify([{ id: "session-1", updatedAt: 1700000000000, messageCount: 1 }]),
  );
  writeFileSync(join(legacy, "skills", "demo-skill", "SKILL.md"), "---\nname: Demo\ndescription: d\n---\nbody");
  writeFileSync(join(legacy, "backups", "a.txt.123.bak"), "backup");
  writeFileSync(join(root, ".devagent_history"), "line one\nline two");
}

describe("platform/workspace — WorkspaceManager migration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nexum-ws-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("detection", () => {
    it("detects neither directory in a fresh workspace", () => {
      const mgr = new WorkspaceManager(root);
      expect(mgr.detect()).toEqual({ root, hasCurrent: false, hasLegacy: false });
    });

    it("detects a legacy .devagent workspace", () => {
      buildLegacyWorkspace(root);
      const mgr = new WorkspaceManager(root);
      expect(mgr.detect()).toEqual({ root, hasCurrent: false, hasLegacy: true });
    });

    it("detects a canonical .nexum workspace", () => {
      mkdirSync(join(root, ".nexum"));
      const mgr = new WorkspaceManager(root);
      expect(mgr.detect()).toEqual({ root, hasCurrent: true, hasLegacy: false });
    });
  });

  describe("ensure() — fresh workspace", () => {
    it("initializes an empty .nexum with canonical paths and no marker", () => {
      const paths = new WorkspaceManager(root).ensure();
      expect(existsSync(paths.dir)).toBe(true);
      expect(paths.memoryDb).toBe(join(root, ".nexum", "memory.db"));
      expect(paths.sessionsDir).toBe(join(root, ".nexum", "sessions"));
      expect(paths.docsDb).toBe(join(root, ".nexum", "docs.db"));
      expect(paths.configFile).toBe(join(root, ".nexum", "config.json"));
      expect(paths.skillsDir).toBe(join(root, ".nexum", "skills"));
      expect(paths.lessonsDb).toBe(join(root, ".nexum", "lessons.db"));
      expect(new WorkspaceManager(root).hasMigrationMarker()).toBe(false);
    });
  });

  describe("ensure() — legacy .devagent workspace migrates automatically", () => {
    it("copies every state entry from .devagent to .nexum", () => {
      buildLegacyWorkspace(root);
      new WorkspaceManager(root).ensure();

      const nexum = join(root, ".nexum");
      expect(existsSync(join(nexum, "memory.db"))).toBe(true);
      expect(existsSync(join(nexum, "checkpoint.json"))).toBe(true);
      expect(existsSync(join(nexum, "docs.db"))).toBe(true);
      expect(existsSync(join(nexum, "models.json"))).toBe(true);
      expect(existsSync(join(nexum, "lessons.db"))).toBe(true);
      expect(existsSync(join(nexum, "history.json"))).toBe(true);
      expect(existsSync(join(nexum, "rails-index.db"))).toBe(true);
      expect(existsSync(join(nexum, "sessions", "session-1.json"))).toBe(true);
      expect(existsSync(join(nexum, "skills", "demo-skill", "SKILL.md"))).toBe(true);
      expect(existsSync(join(nexum, "backups", "a.txt.123.bak"))).toBe(true);
      expect(readFileSync(join(nexum, "memory.db"), "utf8")).toBe("legacy-memory");
      expect(JSON.parse(readFileSync(join(nexum, "config.json"), "utf8"))).toEqual({ model: "legacy-model" });
    });

    it("copies the root-level .devagent_history to .nexum_history", () => {
      buildLegacyWorkspace(root);
      new WorkspaceManager(root).ensure();
      expect(readFileSync(join(root, ".nexum_history"), "utf8")).toBe("line one\nline two");
    });

    it("NEVER deletes the original .devagent directory", () => {
      buildLegacyWorkspace(root);
      new WorkspaceManager(root).ensure();
      expect(existsSync(join(root, ".devagent", "memory.db"))).toBe(true);
      expect(existsSync(join(root, ".devagent", "sessions", "session-1.json"))).toBe(true);
      expect(existsSync(join(root, ".devagent_history"))).toBe(true);
    });

    it("writes the migration marker (commit point) last", () => {
      buildLegacyWorkspace(root);
      const report = new WorkspaceManager(root).migrate();
      expect(report.marker).toBe(join(root, ".nexum", ".migrated-from-devagent.json"));
      const marker = JSON.parse(readFileSync(report.marker!, "utf8")) as Record<string, unknown> | null;
      expect(marker).not.toBeNull();
      expect(marker?.["source"]).toBe(".devagent");
      expect(Array.isArray(marker?.["entries"])).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("a second migration is a no-op when the marker exists", () => {
      buildLegacyWorkspace(root);
      const mgr = new WorkspaceManager(root);
      mgr.migrate();
      const report = mgr.migrate();
      expect(report.alreadyMigrated).toBe(true);
      expect(report.migrated).toBe(false);
    });

    it("re-running an interrupted migration (no marker) skips entries already copied", () => {
      buildLegacyWorkspace(root);
      const legacy = join(root, ".devagent");
      const nexum = join(root, ".nexum");
      // Simulate a crash mid-migration: some entries copied, NO marker yet.
      mkdirSync(nexum, { recursive: true });
      cpSync(join(legacy, "memory.db"), join(nexum, "memory.db"));
      writeFileSync(join(nexum, "memory.db"), "NEWER-VALUE"); // .nexum state is newer
      const report = new WorkspaceManager(root).migrate();
      // memory.db must NOT be overwritten by the stale legacy copy
      expect(readFileSync(join(nexum, "memory.db"), "utf8")).toBe("NEWER-VALUE");
      expect(report.entries.find((e) => e.name === "memory.db")?.status).toBe("skipped");
      // but the rest still migrates
      expect(existsSync(join(nexum, "checkpoint.json"))).toBe(true);
      expect(existsSync(join(nexum, "sessions", "session-1.json"))).toBe(true);
    });
  });

  describe("recoverability", () => {
    it("collects per-entry failures without aborting the rest", () => {
      buildLegacyWorkspace(root);
      const legacy = join(root, ".devagent");
      // Make one entry unreadable-as-copy: replace memory.db with a directory
      // so cpSync(file -> existing-dir-dest) fails for that entry.
      rmSync(join(legacy, "memory.db"));
      mkdirSync(join(legacy, "memory.db"));
      const report = new WorkspaceManager(root).migrate();
      const failed = report.entries.filter((e) => e.status === "failed");
      expect(failed.map((e) => e.name)).toContain("memory.db");
      expect(report.error).toBeUndefined();
      // Other entries still copied
      expect(report.entries.find((e) => e.name === "checkpoint.json")?.status).toBe("copied");
      expect(existsSync(join(root, ".nexum", "sessions", "session-1.json"))).toBe(true);
      // Source untouched
      expect(existsSync(join(legacy, "memory.db"))).toBe(true);
    });
  });

  describe("migrated state loads through the real stores", () => {
    it("an old session file is readable from .nexum after migration", () => {
      buildLegacyWorkspace(root);
      const paths = new WorkspaceManager(root).ensure();
      const store = new SessionStore(paths.sessionsDir);
      const sessions = store.listSessions();
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]?.id).toBe("session-1");
    });

    it("an old checkpoint file is loadable from .nexum after migration", () => {
      buildLegacyWorkspace(root);
      const paths = new WorkspaceManager(root).ensure();
      const store = new CheckpointStore(paths.checkpoint);
      expect(store.load()).toEqual({});
    });
  });

  describe("global state migration (~/.devagent -> ~/.nexum)", () => {
    it("copies config.json, .env and skills/, preserving the original", () => {
      const home = mkdtempSync(join(tmpdir(), "nexum-home-"));
      try {
        const legacy = join(home, ".devagent");
        mkdirSync(join(legacy, "skills", "g"), { recursive: true });
        writeFileSync(join(legacy, "config.json"), JSON.stringify({ tier: "local" }));
        writeFileSync(join(legacy, ".env"), "NEXUM_MODEL=from-global-env\n");
        writeFileSync(join(legacy, "skills", "g", "SKILL.md"), "---\nname: G\n---\n");

        const report = migrateGlobalState(home);
        expect(report.migrated).toBe(true);
        const target = join(home, ".nexum");
        expect(JSON.parse(readFileSync(join(target, "config.json"), "utf8"))).toEqual({ tier: "local" });
        expect(readFileSync(join(target, ".env"), "utf8")).toContain("NEXUM_MODEL=from-global-env");
        expect(existsSync(join(target, "skills", "g", "SKILL.md"))).toBe(true);
        // original preserved
        expect(existsSync(join(legacy, "config.json"))).toBe(true);

        // idempotent
        const again = migrateGlobalState(home);
        expect(again.alreadyMigrated).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
