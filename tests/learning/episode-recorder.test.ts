import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeRecorder } from "../../src/learning/episode-recorder.js";
import { LessonStore } from "../../src/learning/lesson-store.js";

describe("EpisodeRecorder (EVO-001)", () => {
  let recorder: EpisodeRecorder;

  beforeEach(() => {
    recorder = new EpisodeRecorder();
  });

  test("initializes episode on begin() and finalizes on end()", () => {
    recorder.begin("Fix calculation bug", ["skill-rspec"]);
    const episode = recorder.end("answered", "Fixed the bug in calculation.ts");

    expect(episode).not.toBeNull();
    expect(episode!.id).toBeDefined();
    expect(typeof episode!.id).toBe("string");
    expect(episode!.goal).toBe("Fix calculation bug");
    expect(episode!.activatedSkillIds).toEqual(["skill-rspec"]);
    expect(episode!.terminal).toBe("answered");
    expect(episode!.finalAssistantText).toBe("Fixed the bug in calculation.ts");
    expect(episode!.endedAt).toBeGreaterThanOrEqual(episode!.startedAt);
  });

  test("records tool call and result with duration and compacted args", () => {
    recorder.begin("Run test suite", []);
    recorder.onToolCall("run_tests", { command: "bundle exec rspec", env: "test" });
    recorder.onToolResult("run_tests", { exitCode: 0, output: "5 examples, 0 failures" });
    const ep = recorder.end("answered", "Tests passed");

    expect(ep!.toolEvents).toHaveLength(1);
    const event = ep!.toolEvents[0];
    expect(event.name).toBe("run_tests");
    expect(event.args).toEqual({ command: "bundle exec rspec", env: "test" });
    expect(event.ok).toBe(true);
    expect(event.errorLabel).toBeUndefined();
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("captures tool error labels from exitCode and error string", () => {
    recorder.begin("Run failing tests", []);
    recorder.onToolCall("run_tests", { file: "spec/order_spec.rb" });
    recorder.onToolResult("run_tests", { exitCode: 1, error: "1 failure" });
    const ep = recorder.end("answered", "Test failed");

    expect(ep!.toolEvents).toHaveLength(1);
    expect(ep!.toolEvents[0].ok).toBe(false);
    expect(ep!.toolEvents[0].errorLabel).toBe("1 failure");
  });

  test("handles multiple concurrent or overlapping tool calls correctly", () => {
    recorder.begin("Read multiple files", []);
    recorder.onToolCall("read_file", { path: "a.ts" });
    recorder.onToolCall("read_file_secondary", { path: "b.ts" });

    recorder.onToolResult("read_file", { content: "const a = 1;" });
    recorder.onToolResult("read_file_secondary", { content: "const b = 2;" });

    const ep = recorder.end("answered", "Read both files");
    expect(ep!.toolEvents).toHaveLength(2);
    expect(ep!.toolEvents[0].name).toBe("read_file");
    expect(ep!.toolEvents[0].args).toEqual({ path: "a.ts" });
    expect(ep!.toolEvents[1].name).toBe("read_file_secondary");
    expect(ep!.toolEvents[1].args).toEqual({ path: "b.ts" });
  });

  test("records onError as a tool failure event", () => {
    recorder.begin("Attempt tool", []);
    recorder.onToolCall("shell_tool", { cmd: "bad-command" });
    recorder.onError(new Error("Command failed with EACCES"));
    const ep = recorder.end("error", "Failed");

    expect(ep!.toolEvents).toHaveLength(1);
    expect(ep!.toolEvents[0].ok).toBe(false);
    expect(ep!.toolEvents[0].errorLabel).toContain("Error: Command failed with EACCES");
  });

  test("supports user_cancel terminal status", () => {
    recorder.begin("Long running operation", []);
    recorder.onToolCall("search_code", { query: "export" });
    recorder.onError(new Error("AbortError: run cancelled"));
    const ep = recorder.end("user_cancel", "Operation was cancelled by user");

    expect(ep!.terminal).toBe("user_cancel");
    expect(ep!.finalAssistantText).toBe("Operation was cancelled by user");
  });

  test("compacts oversized string arguments (> 300 chars)", () => {
    recorder.begin("Write large file", []);
    const largeContent = "x".repeat(500);
    recorder.onToolCall("write_file", { path: "huge.txt", content: largeContent });
    recorder.onToolResult("write_file", { ok: true });
    const ep = recorder.end("answered", "File written");

    const event = ep!.toolEvents[0];
    expect(typeof event.args.content).toBe("string");
    expect((event.args.content as string).length).toBeLessThan(400);
    expect(event.args.content).toContain("…[500]");
  });

  test("tracks parentEpisodeId for nested/sub-agent steps", () => {
    recorder.begin("Sub-step of plan", [], "parent-ep-123");
    const ep = recorder.end("answered", "Sub-step done");
    expect(ep!.parentEpisodeId).toBe("parent-ep-123");
  });
});

describe("LessonStore Episodes & Resilience (EVO-001)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lesson-store-test-"));
    dbPath = join(tmpDir, "lessons.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("persists and reads episodes via getEpisode, listEpisodes, and allEpisodes", () => {
    const store = new LessonStore(dbPath);
    const epPayload = {
      id: "ep-1",
      goal: "Investigate failure",
      terminal: "answered",
      startedAt: 1000,
      endedAt: 2000,
      toolEvents: [],
      activatedSkillIds: [],
    };

    store.recordEpisode({
      id: "ep-1",
      goal: "Investigate failure",
      verdict: "success",
      score: 1.0,
      terminal: "answered",
      startedAt: 1000,
      endedAt: 2000,
      toolEventCount: 0,
      payload: JSON.stringify(epPayload),
    });

    const single = store.getEpisode("ep-1");
    expect(single).toEqual(epPayload);

    const missing = store.getEpisode("ep-nonexistent");
    expect(missing).toBeNull();

    const listed = store.listEpisodes(10);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("ep-1");

    const all = store.allEpisodes();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("ep-1");
    store.close();
  });

  test("quarantines corrupt database file and reopens cleanly", () => {
    writeFileSync(dbPath, "GARBAGE NOT SQLITE DATA HELLO CORRUPT");
    const store = new LessonStore(dbPath);

    // Should recover without throwing and accept writes
    store.recordEpisode({
      id: "ep-recovered",
      goal: "After corruption",
      verdict: "success",
      score: 1.0,
      terminal: "answered",
      startedAt: 5000,
      endedAt: 6000,
      toolEventCount: 0,
      payload: JSON.stringify({ id: "ep-recovered", goal: "After corruption" }),
    });

    const ep = store.getEpisode("ep-recovered");
    expect(ep).not.toBeNull();
    expect(ep!.id).toBe("ep-recovered");
    store.close();
  });
});
