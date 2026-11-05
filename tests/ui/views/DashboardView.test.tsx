import React from "react";
import { App, ShellAgent } from "../../../src/ui/App.js";
import { EventBus } from "../../../src/runtime/events/bus.js";
import { initialRuntimeState, Store } from "../../../src/runtime/store.js";
import { renderWide } from "../wide-render.js";

const NOW = new Date(2026, 0, 1, 10, 42, 11).getTime();

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeWorld() {
  const bus = new EventBus();
  const store = new Store(initialRuntimeState({ workspace: "ollama-agent", branch: "main", model: "qwen3:30b" }));
  store.attach(bus);
  const agent: ShellAgent = {
    runUserMessage: jest.fn(async () => "ok"),
  };
  return { bus, store, agent };
}

// The default test render hardcodes stdout.columns to 100, which
// silently corrupts any render wider than that (see tests/ui/wide-render.ts's
// doc comment) — the Dashboard view only activates its rail layout at
// >=130 cols, so it must be rendered through renderWide to get a frame
// that faithfully represents what a real terminal shows.
//
// `seed` runs against the bus/store BEFORE mount — App's store subscription
// is throttled to a real 50ms window (RENDER_THROTTLE_MS), so publishing
// after mount and reading lastFrame() synchronously would race it. Seeding
// pre-mount sidesteps that entirely (matches snapshots.test.tsx's pattern).
function renderApp(columns: number, rows: number, seed?: (world: ReturnType<typeof makeWorld>) => void) {
  const world = makeWorld();
  seed?.(world);
  const r = renderWide(
    <App bus={world.bus} store={world.store} agent={world.agent} columns={columns} rows={rows} now={NOW} />,
    columns,
  );
  return { ...world, ...r };
}

function seedExecuteMission(bus: EventBus) {
  bus.publish({ type: "mission.started", goal: "add authentication" });
  bus.publish({ type: "mission.phase", id: "understand", status: "completed" });
  bus.publish({ type: "mission.phase", id: "inspect", status: "completed" });
  bus.publish({ type: "mission.phase", id: "plan", status: "completed" });
  bus.publish({ type: "mission.phase", id: "execute", status: "running" });
}

let mockTime = NOW;

describe("DashboardView", () => {
  beforeEach(() => {
    mockTime = NOW;
    jest.spyOn(Date, "now").mockImplementation(() => mockTime);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is the default view: idle shows a full-width centered welcome, no rails", () => {
    const { lastFrame, unmount } = renderApp(140, 40);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Type a message below");
    expect(frame).not.toContain("MISSION");
    expect(frame).not.toContain("CONTEXT");
    expect(frame).not.toContain("DIFF PREVIEW");
    unmount();
  });

  it("omits the diff summary entirely while no diff exists", () => {
    const { lastFrame, unmount } = renderApp(140, 40);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("No changes yet");
    expect(frame).not.toContain("open diff");
    unmount();
  });

  it("shows mission and files rails while executing", () => {
    const { lastFrame, unmount } = renderApp(140, 40, ({ bus }) => {
      seedExecuteMission(bus);
      bus.publish({
        type: "git.changed",
        git: {
          branch: "main",
          ahead: 0,
          behind: 0,
          files: [{ path: "src/tools/fs.ts", status: "modified", staged: false }],
        },
      });
    });
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("MISSION");
    expect(frame).toContain("TOOLS");
    expect(frame).toContain("FILES (1 CHANGED)");
    expect(frame).toContain("src/tools/fs.ts");
    // Inner dividers only — no box borders.
    expect(frame).not.toContain("╭");
    expect(frame).not.toContain("╰");
    unmount();
  });

  it("shows the diagnostics rail while validating", () => {
    const { lastFrame, unmount } = renderApp(140, 40, ({ bus }) => {
      bus.publish({ type: "mission.started", goal: "add authentication" });
      bus.publish({ type: "mission.phase", id: "validate", status: "running" });
      bus.publish({
        type: "conversation.test_result",
        command: "npm test",
        passed: 38,
        failed: 4,
        failures: [],
        durationMs: 900,
      });
    });
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("DIAGNOSTICS");
    expect(frame).toContain("✗ 4 of 42");
    unmount();
  });

  it("drops all rails once the mission completes", () => {
    const { lastFrame, unmount } = renderApp(140, 40, ({ bus }) => {
      seedExecuteMission(bus);
      bus.publish({ type: "mission.phase", id: "execute", status: "completed" });
      bus.publish({ type: "mission.phase", id: "complete", status: "completed" });
    });
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("MISSION");
    expect(frame).toContain("Type a message below");
    unmount();
  });

  it("renders a one-line diff summary under the stream when diffs exist", () => {
    const { lastFrame, unmount } = renderApp(140, 40, ({ bus }) => {
      bus.publish({ type: "conversation.diff", filePath: "Gemfile", diff: "+gem 'devise'", status: "pending_review" });
      bus.publish({
        type: "conversation.diff",
        filePath: "db/migrate/x.rb",
        diff: "+create_table :users",
        status: "pending_review",
      });
    });
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("2 files changed");
    expect(frame).toContain("Ctrl+D open diff");
    unmount();
  });

  it("falls back to the plain conversation view below 130 cols", () => {
    const { lastFrame, unmount } = renderApp(100, 30);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Type a message below");
    expect(frame).not.toContain("ACTIVITY STREAM");
    unmount();
  });

  it("groups tool calls by name with a live count while executing", () => {
    const { lastFrame, unmount } = renderApp(140, 40, ({ bus }) => {
      seedExecuteMission(bus);
      bus.publish({ type: "tool.started", id: "tc1", name: "read_file", args: {} });
      bus.publish({ type: "tool.completed", id: "tc1", result: {} });
      bus.publish({ type: "tool.started", id: "tc2", name: "read_file", args: {} });
      bus.publish({ type: "tool.completed", id: "tc2", result: {} });
    });
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("read_file");
    expect(frame).toContain("(2)");
    unmount();
  });

  it("shows real mission phase progress driven by orchestrator events", () => {
    const { lastFrame, unmount } = renderApp(140, 40, ({ bus }) => {
      seedExecuteMission(bus);
      bus.publish({
        type: "mission.step",
        step: { id: "s1", description: "Create User model", status: "completed", dependencies: [], retryCount: 0 },
      });
      bus.publish({
        type: "mission.step",
        step: { id: "s2", description: "Add Devise gem", status: "implementing", dependencies: [], retryCount: 0 },
      });
    });
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("add authentication");
    expect(frame).toContain("Create User model");
    expect(frame).toContain("Add Devise gem");
    unmount();
  });
});
