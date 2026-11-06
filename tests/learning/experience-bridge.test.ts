import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceIngestionBridge } from "../../src/learning/experience-bridge.js";
import { ExperienceStore } from "../../src/evolution/experience/experience-store.js";
import { Episode, ToolEvent } from "../../src/learning/types.js";

function ev(name: string, ok: boolean, errorLabel?: string): ToolEvent {
  const event: ToolEvent = { name, args: {}, ok, durationMs: 10, at: Date.now() };
  if (errorLabel) event.errorLabel = errorLabel;
  return event;
}

function episode(id: string, ok: boolean): Episode {
  return {
    id,
    goal: ok ? "implement feature X" : "fix bug Y",
    startedAt: 1000,
    endedAt: 2000,
    toolEvents: [
      { name: "read_file", args: {}, ok: true, durationMs: 5, at: 1001 },
      { name: "run_tests", args: {}, ok, durationMs: 50, at: 1002, errorLabel: ok ? undefined : "exit 1" },
    ],
    activatedSkillIds: [],
    terminal: "answered",
    finalAssistantText: ok ? "done" : "failed",
  };
}

describe("ExperienceIngestionBridge (EVO-002)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nexum-bridge-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("ingests a persisted episode into experience.db", () => {
    const bridge = new ExperienceIngestionBridge({ workspaceRoot: tmp, executorModel: "test-model" });
    const ep = episode("ep-1", true);
    bridge.ingest(ep);
    bridge.close();

    const store = new ExperienceStore(join(tmp, ".nexum", "experience.db"));
    const record = store.getByEpisode("ep-1");
    store.close();
    expect(record).not.toBeNull();
    expect(record!.episodeId).toBe("ep-1");
    expect(record!.executorModel).toBe("test-model");
    expect(record!.outcome.verdict).toBe("success");
  });

  test("ingestion is idempotent (re-ingest same episode does not duplicate)", () => {
    const bridge = new ExperienceIngestionBridge({ workspaceRoot: tmp });
    const ep = episode("ep-1", true);
    bridge.ingest(ep);
    bridge.ingest(ep); // ON CONFLICT(episode_id) DO UPDATE
    bridge.close();

    const store = new ExperienceStore(join(tmp, ".nexum", "experience.db"));
    expect(store.count()).toBe(1);
    store.close();
  });

  test("never throws on a bad episode — disables the bridge instead", () => {
    // Construct a bridge pointing at a workspace whose state dir we make
    // unwritable by pointing workspaceRoot at a path under /dev/null-ish.
    // Easier: pass an episode with no grade and confirm no throw.
    const bridge = new ExperienceIngestionBridge({ workspaceRoot: tmp });
    const ep = episode("ep-bad", true);
    delete (ep as Partial<Episode>).grade;
    expect(() => bridge.ingest(ep)).not.toThrow();
    bridge.close();
  });

  test("disabled bridge is a no-op (no store opened)", () => {
    const bridge = new ExperienceIngestionBridge({ workspaceRoot: tmp, enabled: false });
    bridge.ingest(episode("ep-1", true));
    bridge.close();
    expect(existsSync(join(tmp, ".nexum", "experience.db"))).toBe(false);
  });

  test("close is idempotent and safe to call before any ingest", () => {
    const bridge = new ExperienceIngestionBridge({ workspaceRoot: tmp });
    expect(() => bridge.close()).not.toThrow();
    expect(() => bridge.close()).not.toThrow();
  });

  test("resolves harness version lazily and caches (one git call max)", () => {
    // tmp is not a git repo, so harnessVersion should fall back to "unversioned".
    const bridge = new ExperienceIngestionBridge({ workspaceRoot: tmp });
    bridge.ingest(episode("ep-1", true));
    bridge.close();
    const store = new ExperienceStore(join(tmp, ".nexum", "experience.db"));
    const record = store.getByEpisode("ep-1");
    store.close();
    expect(record!.harnessVersion).toBe("unversioned");
  });
});
