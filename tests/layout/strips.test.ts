import { activityStripTokens, contextStripTokens } from "../../src/ui/layout/strips.js";
import { initialRuntimeState, reduce } from "../../src/runtime/store.js";
import { RuntimeState } from "../../src/runtime/types.js";

function fresh(): RuntimeState {
  return initialRuntimeState({ workspace: "ollama-agent", branch: "main", model: "qwen3:30b" });
}

describe("activityStripTokens", () => {
  it("emits the five primary tabs plus the palette hint", () => {
    const texts = activityStripTokens(fresh()).map((t) => t.text.trim());
    expect(texts).toEqual(["Chat", "Plan", "Tasks", "Changes", "Logs", "Ctrl+P Palette"]);
  });

  it("brackets the active tab", () => {
    const texts = activityStripTokens(fresh(), "git").map((t) => t.text);
    expect(texts).toContain("[Changes]");
    expect(texts).not.toContain("[Chat]");
  });

  it("treats the dashboard as the Chat tab", () => {
    const texts = activityStripTokens(fresh(), "dashboard").map((t) => t.text);
    expect(texts).toContain("[Chat]");
  });

  it("keeps the palette hint at the lowest priority so tabs never drop first", () => {
    const tokens = activityStripTokens(fresh());
    const hint = tokens.find((t) => t.text.includes("Ctrl+P"))!;
    for (const t of tokens.filter((x) => x !== hint)) {
      expect(t.priority).toBeLessThan(hint.priority);
    }
  });
});

describe("contextStripTokens", () => {
  it("idle mode shows the footer status strip", () => {
    const s = fresh();
    const texts = contextStripTokens(s, undefined, s.session.startedAt).map((t) => t.text);
    // Sandbox token absent: sandboxAvailable is undefined until the bootstrap
    // docker probe resolves (see tui/index.ts) — never fabricated.
    expect(texts).toEqual(["● Connected", "🔀 Git main", "⏱ 0m"]);
  });

  it("idle strip shows sandbox status once detected", () => {
    let s = fresh();
    s = reduce(s, { type: "sandbox.detected", available: true });
    const texts = contextStripTokens(s, undefined, s.session.startedAt).map((t) => t.text);
    expect(texts).toContain("⊞ Sandbox ✓");
  });

  it("streaming mode shows generation state", () => {
    let s = fresh();
    s = reduce(s, { type: "mode.changed", mode: "streaming" });
    s = reduce(s, { type: "model.streaming", streaming: true, tokensPerSecond: 81 });
    const texts = contextStripTokens(s).map((t) => t.text);
    expect(texts[0]).toBe("Generating...");
    expect(texts).toContain("81 tok/s");
    expect(texts).toContain("Ctrl+C Stop Generation");
  });

  it("approval mode shows the approval hints", () => {
    let s = fresh();
    s = reduce(s, {
      type: "approval.requested",
      request: { id: "1", title: "t", summary: "s", filesChanged: 3, additions: 128, deletions: 4 },
    });
    const texts = contextStripTokens(s).map((t) => t.text);
    expect(texts[0]).toBe("Waiting for approval");
    expect(texts).toContain("3 files +128 -4");
    expect(texts).toContain("Enter Approve");
  });

  it("git view gets a view-specific strip while idle", () => {
    let s = fresh();
    s = reduce(s, {
      type: "git.changed",
      git: { branch: "main", ahead: 2, behind: 0, files: [{ path: "a.ts", status: "modified", staged: false }] },
    });
    const texts = contextStripTokens(s, "git").map((t) => t.text);
    expect(texts).toEqual(["Branch:main", "Modified:1", "Ahead:2", "Behind:0"]);
  });

  it("logs view gets level counts while idle", () => {
    let s = fresh();
    s = reduce(s, { type: "logs.appended", level: "info", source: "t", message: "a" });
    s = reduce(s, { type: "logs.appended", level: "error", source: "t", message: "b" });
    const texts = contextStripTokens(s, "logs").map((t) => t.text);
    expect(texts).toContain("INFO:1");
    expect(texts).toContain("ERROR:1");
  });

  it("mode strips override view strips (planning wins over git view)", () => {
    let s = fresh();
    s = reduce(s, { type: "mode.changed", mode: "planning" });
    const texts = contextStripTokens(s, "git").map((t) => t.text);
    expect(texts[0]).toBe("Planning");
  });
});
