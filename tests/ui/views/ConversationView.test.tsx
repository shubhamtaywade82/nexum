import React from "react";
import { render } from "ink-testing-library";
import { ConversationView, summarizeGroup } from "../../../src/ui/views/ConversationView.js";
import { initialRuntimeState, reduce } from "../../../src/runtime/store.js";
import { ChatEntry, RuntimeState } from "../../../src/runtime/types.js";

function stateWith(events: Parameters<typeof reduce>[1][]): RuntimeState {
  let s = initialRuntimeState({ workspace: "devagent", branch: "main", model: "qwen3:30b" });
  for (const e of events) s = reduce(s, e);
  return s;
}

describe("summarizeGroup", () => {
  it("returns null for groups without diffs or tests", () => {
    const entries: ChatEntry[] = [
      { kind: "tool_call", role: "assistant", id: "1", name: "read_file", args: {}, status: "completed", at: 1 },
    ];
    expect(summarizeGroup(entries)).toBeNull();
  });

  it("aggregates diffs per file and test results", () => {
    const entries: ChatEntry[] = [
      {
        kind: "diff_preview",
        role: "assistant",
        filePath: "a.ts",
        diff: "+one\n+two\n-three",
        status: "approved",
        at: 1,
      },
      { kind: "diff_preview", role: "assistant", filePath: "a.ts", diff: "+four", status: "approved", at: 2 },
      { kind: "diff_preview", role: "assistant", filePath: "b.ts", diff: "+x", status: "approved", at: 3 },
      {
        kind: "test_result",
        role: "assistant",
        command: "npm test",
        passed: 10,
        failed: 1,
        failures: [],
        durationMs: 100,
        at: 4,
      },
    ];
    const s = summarizeGroup(entries);
    expect(s).not.toBeNull();
    expect(s!.files).toEqual([
      { path: "a.ts", additions: 3, deletions: 1 },
      { path: "b.ts", additions: 1, deletions: 0 },
    ]);
    expect(s!.totalAdditions).toBe(4);
    expect(s!.totalDeletions).toBe(1);
    expect(s!.test).toEqual({ passed: 10, failed: 1 });
  });
});

describe("ConversationView activity stream", () => {
  it("renders user prompt and Nexum speaker rows", () => {
    const state = stateWith([
      { type: "conversation.message", role: "user", text: "hello" },
      { type: "conversation.chunk", role: "assistant", chunk: "hi there" },
    ]);
    const { lastFrame, unmount } = render(<ConversationView state={state} width={80} rows={20} detail="full" />);
    const frame = lastFrame()!;
    expect(frame).toContain("> hello");
    expect(frame).toContain("◆ Nexum");
    expect(frame).toContain("hi there");
    unmount();
  });

  it("renders a phase header when the mission crumb changes", () => {
    const state = stateWith([
      { type: "mission.started", goal: "Add auth" },
      { type: "mission.phase", id: "execute", status: "running" },
      { type: "conversation.tool_call", id: "t1", name: "edit_file", args: { path: "a.ts" }, status: "running" },
    ]);
    const { lastFrame, unmount } = render(<ConversationView state={state} width={80} rows={20} detail="full" />);
    expect(lastFrame()!).toContain("◆ Execute");
    unmount();
  });

  it("renders a group summary after diff and test entries", () => {
    const state = stateWith([
      { type: "mission.started", goal: "Add auth" },
      { type: "mission.phase", id: "execute", status: "running" },
      { type: "conversation.diff", filePath: "a.ts", diff: "+new line", status: "approved" },
      { type: "conversation.test_result", command: "npm test", passed: 5, failed: 0, failures: [], durationMs: 100 },
    ]);
    const { lastFrame, unmount } = render(<ConversationView state={state} width={80} rows={24} detail="full" />);
    const frame = lastFrame()!;
    expect(frame).toContain("1 file · +1 −0");
    expect(frame).toContain("✓ 5 passed");
    unmount();
  });

  it("renders an expanded block when thinking is actively in progress", () => {
    let state = stateWith([{ type: "conversation.message", role: "user", text: "how does auth work?" }]);
    state = reduce(state, { type: "conversation.chunk", role: "thinking", chunk: "Analyzing the auth flow" });
    const { lastFrame, unmount } = render(<ConversationView state={state} width={80} rows={20} detail="full" />);
    const frame = lastFrame()!;
    expect(frame).toContain("▸ Thinking...");
    expect(frame).toContain("Analyzing the auth flow");
    unmount();
  });

  it("renders a collapsed Thought row with summary once completed", () => {
    const state = stateWith([
      { type: "conversation.message", role: "user", text: "how does auth work?" },
      { type: "conversation.chunk", role: "thinking", chunk: "Analyzing the auth flow in detail" },
      { type: "conversation.chunk", role: "assistant", chunk: "Here is how auth works" },
    ]);
    const { lastFrame, unmount } = render(<ConversationView state={state} width={80} rows={20} detail="full" />);
    const frame = lastFrame()!;
    expect(frame).toContain("▸ Thought");
    expect(frame).toContain("(Analyzing the auth flow in detail)");
    expect(frame).not.toContain("▸ Thinking...");
    unmount();
  });
});
