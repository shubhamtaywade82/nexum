import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERALIZATION_POLICIES, loadAllEpisodes, resolveGeneralizationPolicy } from "../../src/evolution/cli.js";
import { Episode } from "../../src/learning/types.js";
import { workspaceStateDir } from "../../src/platform/paths.js";

function mkEpisode(id: string, goal: string, startedAt: number): Episode {
  return {
    id,
    goal,
    startedAt,
    endedAt: startedAt + 1,
    toolEvents: [],
    activatedSkillIds: [],
    terminal: "answered",
    finalAssistantText: "done",
  };
}

describe("v2.4 CLI features", () => {
  describe("resolveGeneralizationPolicy", () => {
    it("keeps 'optional' for local runs and defaults to 'required-for-production' for --github delivery", () => {
      expect(resolveGeneralizationPolicy({})).toBe("optional");
      expect(resolveGeneralizationPolicy({ mutate: true })).toBe("optional");
      expect(resolveGeneralizationPolicy({ github: true })).toBe("required-for-production");
      expect(resolveGeneralizationPolicy({ mutate: true, github: true })).toBe("required-for-production");
    });

    it("an explicit --generalization-policy always wins over the defaults", () => {
      expect(resolveGeneralizationPolicy({ "generalization-policy": "required" })).toBe("required");
      expect(resolveGeneralizationPolicy({ "generalization-policy": "optional", github: true })).toBe("optional");
      expect(resolveGeneralizationPolicy({ "generalization-policy": "required-for-production", github: false })).toBe(
        "required-for-production",
      );
    });

    it("throws loudly on unknown policy names so typos cannot weaken the gate", () => {
      expect(() => resolveGeneralizationPolicy({ "generalization-policy": "strict" })).toThrow(
        'Unknown generalization policy "strict"',
      );
      expect(GENERALIZATION_POLICIES).toEqual(["optional", "required", "required-for-production"]);
    });
  });

  describe("loadAllEpisodes", () => {
    let workspace: string;

    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), "nexumall-"));
    });

    afterEach(() => {
      rmSync(workspace, { recursive: true, force: true });
    });

    function seedEpisodes(count: number): void {
      const stateDir = workspaceStateDir(workspace);
      mkdirSync(stateDir, { recursive: true });
      const db = new Database(join(stateDir, "lessons.db"));
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS episodes (
            id TEXT PRIMARY KEY,
            goal TEXT NOT NULL,
            verdict TEXT NOT NULL,
            score REAL NOT NULL,
            terminal TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER NOT NULL,
            tool_event_count INTEGER NOT NULL,
            payload TEXT NOT NULL
          );
        `);
        const insert = db.prepare(
          "INSERT INTO episodes (id, goal, verdict, score, terminal, started_at, ended_at, tool_event_count, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (let i = 0; i < count; i++) {
          const episode = mkEpisode(`ep-${i}`, `goal ${i}`, 1000 - i);
          insert.run(
            episode.id,
            episode.goal,
            "success",
            0.9,
            episode.terminal,
            episode.startedAt,
            episode.endedAt,
            0,
            JSON.stringify(episode),
          );
        }
      } finally {
        db.close();
      }
    }

    it("returns an empty list when no lesson database exists", () => {
      expect(loadAllEpisodes(workspace)).toEqual([]);
    });

    it("reads EVERY episode, not just a recent window (the experience feed)", () => {
      seedEpisodes(50);
      const all = loadAllEpisodes(workspace);
      expect(all).toHaveLength(50);
      // Ordered most-recent-first, like the bounded loader (ep-0 has startedAt=1000).
      expect(all[0].id).toBe("ep-0");
      expect(all[49].id).toBe("ep-49");
    });
  });
});
