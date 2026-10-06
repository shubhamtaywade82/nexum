import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { EventBus } from "../../src/runtime/events/bus.js";
import { wireAgentBridge } from "../../src/ui/agent-bridge.js";

function fakeAgent() {
  const em = new EventEmitter();
  return {
    on: (e: string, h: (...a: any[]) => void) => em.on(e, h),
    emit: (e: string, ...a: unknown[]) => em.emit(e, ...a),
  };
}

describe("agent bridge — diff previews and test results", () => {
  it("publishes a diff for write_file computed from before/after snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-"));
    writeFileSync(join(root, "a.ts"), "const a = 1;\n");
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    const agent = fakeAgent();
    wireAgentBridge(agent, bus, { workspaceRoot: root });

    agent.emit("onToolCall", "write_file", { path: "a.ts", content: "const a = 2;\n" });
    writeFileSync(join(root, "a.ts"), "const a = 2;\n");
    agent.emit("onToolResult", "write_file", { path: "a.ts", bytesWritten: 13 });

    const diff = events.find((e) => e.type === "conversation.diff");
    expect(diff).toMatchObject({ filePath: "a.ts", status: "approved" });
    expect(diff.diff).toContain("-const a = 1;");
    expect(diff.diff).toContain("+const a = 2;");
  });

  it("uses the diff carried by CAS tools and skips dry runs", () => {
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    const agent = fakeAgent();
    wireAgentBridge(agent, bus, {});
    agent.emit("onToolCall", "apply_patch", { path: "x.ts" });
    agent.emit("onToolResult", "apply_patch", { path: "x.ts", applied: true, diff: "@@ -1 +1 @@\n-a\n+b" });
    agent.emit("onToolCall", "apply_patch", { path: "x.ts" });
    agent.emit("onToolResult", "apply_patch", { path: "x.ts", dry_run: true, diff: "@@" });
    expect(events.filter((e) => e.type === "conversation.diff")).toHaveLength(1);
  });

  it("publishes a test_result for run_rspec output", () => {
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));
    const agent = fakeAgent();
    wireAgentBridge(agent, bus, {});
    agent.emit("onToolCall", "run_rspec", {});
    agent.emit("onToolResult", "run_rspec", {
      command: "bundle exec rspec",
      exitCode: 1,
      stdout: "3 examples, 1 failure\n\nrspec ./spec/a_spec.rb:7 # A fails",
      stderr: "",
      duration: 1.5,
    });
    expect(events.find((e) => e.type === "conversation.test_result")).toMatchObject({
      command: "bundle exec rspec",
      passed: 2,
      failed: 1,
      durationMs: 1500,
      failures: [{ file: "spec/a_spec.rb", line: 7 }],
    });
  });
});
