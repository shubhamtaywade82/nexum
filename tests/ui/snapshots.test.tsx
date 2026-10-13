import React from "react";
import { App } from "../../src/ui/App.js";
import { EventBus } from "../../src/runtime/events/bus.js";
import { initialRuntimeState, Store } from "../../src/runtime/store.js";
import { renderWide } from "./wide-render.js";

const NOW = new Date(2026, 0, 1, 10, 42, 11).getTime();

function seededWorld() {
  const bus = new EventBus();
  const store = new Store(initialRuntimeState({ workspace: "ollama-agent", branch: "main", model: "qwen3:30b" }));
  store.attach(bus);
  bus.publish({ type: "conversation.message", role: "user", text: "create filesystem tool" });
  bus.publish({
    type: "conversation.chunk",
    role: "assistant",
    chunk: "Analyzing project structure and existing patterns...\n- Reading package.json\n- Found TypeScript project",
  });
  bus.publish({
    type: "task.created",
    task: { id: "t1", title: "Design interface", status: "completed", dependencies: [] },
  });
  bus.publish({
    type: "task.created",
    task: { id: "t2", title: "Implement tool", status: "running", dependencies: ["t1"], progress: 0.7 },
  });
  bus.publish({
    type: "task.created",
    task: { id: "t3", title: "Write tests", status: "queued", dependencies: ["t2"] },
  });
  bus.publish({ type: "tool.started", id: "tc1", name: "edit_file", args: { path: "src/tools/fs.ts" } });
  bus.publish({ type: "context.changed", used: 48000, limit: 71000 });
  bus.publish({
    type: "git.changed",
    git: {
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [
        { path: "src/tools/fs.ts", status: "modified", staged: false, additions: 128, deletions: 4 },
        { path: "src/tools/index.ts", status: "added", staged: true, additions: 12, deletions: 0 },
      ],
    },
  });
  return { bus, store };
}

describe("layout snapshots", () => {
  // The default render() hardcodes its stdout.columns to
  // 100 (see tests/ui/wide-render.ts), silently corrupting any render wider
  // than that — Dashboard is now the default view and needs >=130 cols to
  // show its real 3-column layout, so every size here goes through
  // renderWide for a frame that faithfully represents a real terminal.
  const sizes: [number, number][] = [
    [80, 24],
    [100, 30],
    [120, 30],
    [160, 45],
    [220, 60],
  ];

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(sizes)("same structure, density-only changes at %dx%d", (columns, rows) => {
    const { bus, store } = seededWorld();
    const { lastFrame, unmount } = renderWide(
      <App bus={bus} store={store} columns={columns} rows={rows} now={NOW} />,
      columns,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it("dashboard view at 140x40", () => {
    const { bus, store } = seededWorld();
    bus.publish({ type: "mission.started", goal: "add authentication" });
    bus.publish({ type: "mission.phase", id: "understand", status: "completed" });
    bus.publish({ type: "mission.phase", id: "inspect", status: "completed" });
    bus.publish({ type: "mission.phase", id: "plan", status: "completed" });
    bus.publish({ type: "mission.phase", id: "execute", status: "running" });
    bus.publish({
      type: "mission.step",
      step: { id: "s1", description: "Create User model", status: "completed", dependencies: [], retryCount: 0 },
    });
    bus.publish({
      type: "mission.step",
      step: { id: "s2", description: "Add Devise gem", status: "implementing", dependencies: [], retryCount: 0 },
    });
    bus.publish({ type: "conversation.diff", filePath: "Gemfile", diff: "+gem 'devise'", status: "pending_review" });
    bus.publish({
      type: "project.detected",
      info: { language: "TypeScript", framework: "React", testFramework: "Jest" },
    });

    // Dashboard is the default view now — no navigation needed.
    const { lastFrame, unmount } = renderWide(<App bus={bus} store={store} columns={140} rows={40} now={NOW} />, 140);
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});
