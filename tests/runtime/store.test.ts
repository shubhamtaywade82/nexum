import { EventBus } from "../../src/runtime/events/bus.js";
import { initialRuntimeState, reduce, sanitizeText, Store } from "../../src/runtime/store.js";
import { RuntimeState } from "../../src/runtime/types.js";

function fresh(): RuntimeState {
  return initialRuntimeState({ workspace: "devagent", branch: "main", model: "qwen3:30b" });
}

describe("sanitizeText", () => {
  it("strips ANSI escape sequences and control chars", () => {
    expect(sanitizeText("a\x1b[31mred\x1b[0mb")).toBe("aredb");
    expect(sanitizeText("t\x1b]0;title\x07x")).toBe("tx");
    expect(sanitizeText("keep\nnewline\tand tab\rno-cr")).toBe("keep\nnewline\tand tabno-cr");
  });
});

describe("store reducer", () => {
  it("appends conversation messages and streams chunks into one entry", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "hi" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "he" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "llo" });
    expect(s.conversation).toHaveLength(2);
    expect(s.conversation[1]).toMatchObject({ kind: "text", role: "assistant", text: "hello" });
    expect(s.actors.conversation.health).toBe("active");
  });

  it("tags an assistant entry with the primary model by default", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "hi" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "hello" });
    expect(s.conversation[1]).toMatchObject({ model: "local/qwen3:30b" });
  });

  it("tags an assistant entry with the model from a 'model.answered' event", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "where is X?" });
    s = reduce(s, { type: "model.answered", tier: "local", model: "minicpm5-1b" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "found it" });
    expect(s.lastTurnModel).toBe("local/minicpm5-1b");
    expect(s.conversation[1]).toMatchObject({ model: "local/minicpm5-1b" });
  });

  it("tags an assistant entry with whichever model actually answered, even a different one mid-turn", () => {
    // Regression intent: the old status-string-parsing approach computed the
    // tag BEFORE routing happened, so it could show the wrong model if
    // Router.route widened to a different candidate. model.answered is
    // emitted from the actually-resolved response, so whatever it says is
    // definitionally correct — this just proves the tag isn't hardcoded to
    // the session's primary/default model.
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "where is X?" });
    s = reduce(s, { type: "model.answered", tier: "cloud", model: "gemma4:31b" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "found it" });
    expect(s.lastTurnModel).toBe("cloud/gemma4:31b");
    expect(s.conversation[1]).toMatchObject({ model: "cloud/gemma4:31b" });
  });

  it("does not leak a prior turn's model into a new turn where model.answered hasn't fired yet", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "where is X?" });
    s = reduce(s, { type: "model.answered", tier: "local", model: "minicpm5-1b" });
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "found it" });

    s = reduce(s, { type: "conversation.message", role: "user", text: "implement JWT auth" });
    expect(s.lastTurnModel).toBeNull();
    s = reduce(s, { type: "conversation.chunk", role: "assistant", chunk: "done" });
    expect(s.conversation[3]).toMatchObject({ model: "local/qwen3:30b" });
  });

  it("clears conversation", () => {
    let s = fresh();
    s = reduce(s, { type: "conversation.message", role: "user", text: "hi" });
    s = reduce(s, { type: "conversation.clear" });
    expect(s.conversation).toHaveLength(0);
  });

  it("tracks tool lifecycle and executor actor health", () => {
    let s = fresh();
    s = reduce(s, { type: "tool.started", id: "t1", name: "edit_file", args: { path: "a.ts" } });
    expect(s.execution.activeTool).toBe("edit_file");
    expect(s.actors.executor).toMatchObject({ health: "active", detail: "▶" });

    s = reduce(s, { type: "tool.completed", id: "t1", result: { ok: true } });
    expect(s.toolCalls[0]).toMatchObject({ status: "completed", result: { ok: true } });
    expect(s.execution.activeTool).toBeNull();
    expect(s.actors.executor).toMatchObject({ health: "healthy", detail: "✓" });
  });

  it("marks executor errored on tool failure", () => {
    let s = fresh();
    s = reduce(s, { type: "tool.started", id: "t1", name: "run_shell", args: {} });
    s = reduce(s, { type: "tool.failed", id: "t1", error: "exit 1" });
    expect(s.toolCalls[0]).toMatchObject({ status: "failed", error: "exit 1" });
    expect(s.actors.executor.health).toBe("error");
  });

  it("surfaces a top-level error as a visible notification, not just the executor glyph (regression: message was previously silent)", () => {
    let s = fresh();
    s = reduce(s, { type: "error", message: "Ollama local 400: model does not support tools" });
    expect(s.lastError).toBe("Ollama local 400: model does not support tools");
    expect(s.actors.executor).toMatchObject({ health: "error", detail: "✗" });
    expect(s.notifications[s.notifications.length - 1]).toMatchObject({
      kind: "error",
      text: "Ollama local 400: model does not support tools",
    });
  });

  it("applies task graph updates through the state machine", () => {
    let s = fresh();
    s = reduce(s, { type: "task.created", task: { id: "a", title: "A", status: "queued", dependencies: [] } });
    expect(s.actors.tasks.detail).toBe("1");
    s = reduce(s, { type: "task.progress", taskId: "a", status: "running", progress: 0.4 });
    expect(s.tasks[0]).toMatchObject({ status: "running", progress: 0.4 });
    s = reduce(s, { type: "task.progress", taskId: "a", status: "completed" });
    expect(s.actors.tasks.detail).toBe("✓");
    // invalid transition ignored
    const after = reduce(s, { type: "task.progress", taskId: "a", status: "running" });
    expect(after.tasks[0].status).toBe("completed");
  });

  it("updates git state and actor detail", () => {
    let s = fresh();
    s = reduce(s, {
      type: "git.changed",
      git: {
        branch: "main",
        ahead: 1,
        behind: 0,
        files: [
          { path: "a.ts", status: "modified", staged: false },
          { path: "b.ts", status: "added", staged: true },
        ],
      },
    });
    expect(s.actors.git).toMatchObject({ health: "waiting", detail: "2" });
  });

  it("appends sanitized logs and counts them", () => {
    let s = fresh();
    s = reduce(s, { type: "logs.appended", level: "info", source: "shell", message: "\x1b[32mok\x1b[0m" });
    expect(s.logs[0].message).toBe("ok");
    expect(s.actors.logs.detail).toBe("1");
  });

  it("handles approval request/resolve as a mode change", () => {
    let s = fresh();
    s = reduce(s, {
      type: "approval.requested",
      request: { id: "ap1", title: "Apply patch", summary: "3 files", filesChanged: 3, additions: 10, deletions: 2 },
    });
    expect(s.mode).toBe("approval");
    expect(s.actors.executor.health).toBe("waiting");
    s = reduce(s, { type: "approval.resolved", id: "ap1", approved: true });
    expect(s.approval).toBeNull();
    expect(s.mode).toBe("idle");
  });

  it("ignores approval.resolved for a stale id", () => {
    let s = fresh();
    s = reduce(s, {
      type: "approval.requested",
      request: { id: "ap1", title: "x", summary: "", filesChanged: 1, additions: 1, deletions: 0 },
    });
    const after = reduce(s, { type: "approval.resolved", id: "other", approved: true });
    expect(after.approval).not.toBeNull();
  });

  it("tracks model streaming and context", () => {
    let s = fresh();
    s = reduce(s, { type: "model.streaming", streaming: true, tokensPerSecond: 81 });
    expect(s.model).toMatchObject({ streaming: true, tokensPerSecond: 81 });
    expect(s.actors.models.health).toBe("thinking");
    s = reduce(s, { type: "context.changed", used: 48000, limit: 71000 });
    expect(s.model.contextUsed).toBe(48000);
  });

  it("bounds the log buffer", () => {
    let s = fresh();
    for (let i = 0; i < 600; i++) {
      s = reduce(s, { type: "logs.appended", level: "debug", source: "t", message: `m${i}` });
    }
    expect(s.logs.length).toBe(500);
    expect(s.logs[s.logs.length - 1].message).toBe("m599");
  });

  describe("skills.changed", () => {
    it("marks the actor muted with no skills at all", () => {
      const s = reduce(fresh(), { type: "skills.changed", skills: [] });
      expect(s.actors.skills).toMatchObject({ health: "muted", detail: "✓" });
      expect(s.skills).toEqual([]);
    });

    it("marks the actor healthy when skills exist but none are active", () => {
      const s = reduce(fresh(), {
        type: "skills.changed",
        skills: [{ id: "a", name: "A", tags: [], active: false }],
      });
      expect(s.actors.skills).toMatchObject({ health: "healthy", detail: "✓" });
    });

    it("marks the actor active and counts active skills", () => {
      const s = reduce(fresh(), {
        type: "skills.changed",
        skills: [
          { id: "a", name: "A", tags: [], active: true },
          { id: "b", name: "B", tags: [], active: false },
          { id: "c", name: "C", tags: [], active: true },
        ],
      });
      expect(s.actors.skills).toMatchObject({ health: "active", detail: "2" });
      expect(s.skills).toHaveLength(3);
    });
  });
});

describe("Store", () => {
  it("notifies subscribers on change and supports bus attachment", () => {
    const store = new Store(fresh());
    const bus = new EventBus();
    store.attach(bus);
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.status));
    bus.publish({ type: "status.changed", status: "working" });
    expect(seen).toEqual(["working"]);
    expect(store.getState().status).toBe("working");
  });

  it("does not notify when an event is a no-op", () => {
    const store = new Store(fresh());
    let calls = 0;
    store.subscribe(() => calls++);
    store.apply({ type: "approval.resolved", id: "nope", approved: false });
    expect(calls).toBe(0);
  });
});

describe("aggregated state (Stage 0)", () => {
  it("persists the last test result", () => {
    let s = fresh();
    s = reduce(s, {
      type: "conversation.test_result",
      command: "npm test",
      passed: 42,
      failed: 3,
      failures: [{ file: "a.ts", line: 1, message: "boom" }],
      durationMs: 1200,
    });
    expect(s.lastTestResult).toMatchObject({ command: "npm test", passed: 42, failed: 3 });
  });

  it("accumulates diagnostics per path and clears at zero", () => {
    let s = fresh();
    s = reduce(s, { type: "lsp.diagnostics", path: "a.ts", count: 2 });
    s = reduce(s, { type: "lsp.diagnostics", path: "b.ts", count: 1 });
    expect(s.diagnosticsByPath).toEqual({ "a.ts": 2, "b.ts": 1 });
    s = reduce(s, { type: "lsp.diagnostics", path: "a.ts", count: 0 });
    expect(s.diagnosticsByPath).toEqual({ "b.ts": 1 });
  });

  it("stamps text entries with the mission crumb", () => {
    let s = fresh();
    s = reduce(s, { type: "mission.started", goal: "Add auth" });
    s = reduce(s, { type: "mission.phase", id: "execute", status: "running" });
    s = reduce(s, { type: "conversation.message", role: "assistant", text: "working" });
    const last = s.conversation[s.conversation.length - 1];
    expect(last.kind).toBe("text");
    expect((last as { crumb?: string }).crumb).toContain("Execute");
  });
});

describe("rails.index event", () => {
  it("stores rails index state", () => {
    let s = fresh();
    s = reduce(s, {
      type: "rails.index",
      status: "ready",
      entityCount: 42,
      edgeCount: 17,
      scannerErrors: ["model: boom"],
    });
    expect(s.rails).toEqual({ status: "ready", entityCount: 42, edgeCount: 17, scannerErrors: ["model: boom"] });
  });

  it("defaults missing counts to zero", () => {
    let s = fresh();
    s = reduce(s, { type: "rails.index", status: "building" });
    expect(s.rails).toEqual({ status: "building", entityCount: 0, edgeCount: 0, scannerErrors: [] });
  });
});

describe("sanitizeText private-mode and charset escapes", () => {
  // The CSI pattern only allowed [0-9;] parameters, so private-mode sequences
  // fell through to the control-character pass, which stripped just the ESC
  // and left the rest as visible garbage in the fixed layout.
  it.each([
    ["\x1b[?25l", "hide cursor"],
    ["\x1b[?25h", "show cursor"],
    ["\x1b[?1049h", "alternate screen"],
    ["\x1b[?1004l", "focus reporting off"],
  ])("strips %s (%s) completely", (seq) => {
    expect(sanitizeText(`a${seq}b`)).toBe("ab");
  });

  it("strips a charset-selection escape", () => {
    expect(sanitizeText("a\x1b(Bb")).toBe("ab");
  });

  it("still strips ordinary SGR colour codes and keeps text", () => {
    expect(sanitizeText("\x1b[38;2;255;0;0mred\x1b[0m")).toBe("red");
  });

  it("preserves newlines and tabs", () => {
    expect(sanitizeText("a\nb\tc")).toBe("a\nb\tc");
  });
});

describe("notification ids stay unique once the buffer is full", () => {
  it("does not reuse an id when notifications.length has stopped growing", () => {
    let state = initialRuntimeState();
    for (let i = 0; i < 60; i++) {
      state = reduce(state, { type: "notification", kind: "info", text: `n${i}` });
    }
    const ids = state.notifications.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("task failure in the runtime store", () => {
  it("a failed task blocks its dependents and logs the transition with the failure reason", () => {
    let state = initialRuntimeState();
    state = reduce(state, {
      type: "task.created",
      task: { id: "a", title: "a", status: "running", dependencies: [] },
    } as never);
    state = reduce(state, {
      type: "task.created",
      task: { id: "b", title: "b", status: "queued", dependencies: ["a"] },
    } as never);

    state = reduce(state, { type: "task.progress", taskId: "a", status: "failed", reason: "lint failed" } as never);

    expect(state.tasks.find((t) => t.id === "b")).toMatchObject({
      status: "blocked",
      blockedBy: "a",
      blockReason: 'dependency "a" failed: lint failed',
    });
    const messages = state.logs.map((l) => l.message);
    expect(messages).toContain("task a: running → failed (lint failed)");
    expect(messages).toContain('task b: queued → blocked (dependency "a" failed: lint failed)');
  });

  it("a refused task transition is logged as a warning and changes nothing", () => {
    let state = initialRuntimeState();
    state = reduce(state, {
      type: "task.created",
      task: { id: "done", title: "done", status: "completed", dependencies: [] },
    } as never);
    const before = state.tasks;

    state = reduce(state, { type: "task.progress", taskId: "done", status: "running" } as never);

    expect(state.tasks).toBe(before);
    const refusal = state.logs.find((l) => l.message.startsWith("task transition refused"));
    expect(refusal).toMatchObject({
      level: "warn",
      message: "task transition refused: done completed → running is not allowed",
    });
  });
});

describe("task log lines are sanitized like every other log line", () => {
  it("strips terminal escapes and control characters from a failure reason before it reaches the log", () => {
    let state = initialRuntimeState();
    state = reduce(state, {
      type: "task.created",
      task: { id: "a", title: "a", status: "running", dependencies: [] },
    } as never);
    state = reduce(state, {
      type: "task.progress",
      taskId: "a",
      status: "failed",
      reason: "\u001b[31mred\u001b[0m\u0007 check",
    } as never);
    const joined = state.logs.map((l) => l.message).join("\n");
    expect(joined).toContain("task a: running → failed");
    expect(joined.includes("\u001b")).toBe(false);
    expect(joined.includes("\u0007")).toBe(false);
  });
});
