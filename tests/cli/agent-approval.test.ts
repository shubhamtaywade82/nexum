import { isolateModelSubsystems } from "../support/isolate-model-subsystems.js";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";
import { ApprovalRequest } from "../../src/runtime/types.js";

function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Each entry is one assistant turn's `message`; `content` and/or
 * `tool_calls` matching Ollama's real response shape. */
function mockChatFetch(turns: Array<{ content?: string; tool_calls?: unknown[] }>) {
  let call = 0;
  const encoder = new TextEncoder();
  return jest.fn().mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: [] }) };
    }
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    const message = { role: "assistant", content: turn.content ?? "", tool_calls: turn.tool_calls };
    const line = JSON.stringify({ message, done: true }) + "\n";
    let delivered = false;
    const reader = {
      read: async () => {
        if (delivered) return { done: true, value: undefined };
        delivered = true;
        return { done: false, value: encoder.encode(line) };
      },
      releaseLock: () => {},
    };
    return { ok: true, status: 200, json: async () => ({ message, done: true }), body: { getReader: () => reader } };
  });
}

isolateModelSubsystems();

describe("Agent approval gate", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-approval-test-"));
  });

  it("resolveApproval on an unknown id is a no-op, not a crash", () => {
    (globalThis as any).fetch = mockChatFetch([{ content: "done" }]);
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    expect(() => agent.resolveApproval("nonexistent", true)).not.toThrow();
  });

  it("denies a destructive call instead of hanging when no approval listener is wired", async () => {
    const target = join(tempDir, "unwatched.txt");
    await writeFile(target, "still here");

    (globalThis as any).fetch = mockChatFetch([
      { tool_calls: [{ function: { name: "delete_file", arguments: { path: "unwatched.txt" } } }] },
      { content: "done" },
    ]);

    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });

    await agent.runUserMessage("delete the unwatched file");

    expect(await fileExists(target)).toBe(true);
  });

  it("skips the prompt entirely when autoApprove is set", async () => {
    const target = join(tempDir, "auto.txt");
    await writeFile(target, "bye");

    (globalThis as any).fetch = mockChatFetch([
      { tool_calls: [{ function: { name: "delete_file", arguments: { path: "auto.txt" } } }] },
      { content: "done" },
    ]);

    let approvalRequested = false;
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m", autoApprove: true },
      events: {
        onApprovalRequested: () => {
          approvalRequested = true;
        },
      },
    });

    await agent.runUserMessage("delete the auto file");

    expect(approvalRequested).toBe(false);
    expect(await fileExists(target)).toBe(false);
  });

  it("requests approval before delete_file and actually deletes once approved", async () => {
    const target = join(tempDir, "doomed.txt");
    await writeFile(target, "bye");

    (globalThis as any).fetch = mockChatFetch([
      { tool_calls: [{ function: { name: "delete_file", arguments: { path: "doomed.txt" } } }] },
      { content: "done" },
    ]);

    const requests: ApprovalRequest[] = [];
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: {
        onApprovalRequested: (request) => {
          requests.push(request);
          agent.resolveApproval(request.id, true);
        },
      },
    });

    await agent.runUserMessage("delete the doomed file");

    expect(requests).toHaveLength(1);
    expect(requests[0].title).toBe(`Delete doomed.txt`);
    expect(await fileExists(target)).toBe(false);
  });

  it("blocks delete_file when the user rejects — the file survives", async () => {
    const target = join(tempDir, "survivor.txt");
    await writeFile(target, "still here");

    (globalThis as any).fetch = mockChatFetch([
      { tool_calls: [{ function: { name: "delete_file", arguments: { path: "survivor.txt" } } }] },
      { content: "done" },
    ]);

    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: { onApprovalRequested: (request) => agent.resolveApproval(request.id, false) },
    });

    await agent.runUserMessage("delete the survivor file");

    expect(await fileExists(target)).toBe(true);
  });

  it("does not gate non-destructive tool calls (list_directory runs immediately)", async () => {
    (globalThis as any).fetch = mockChatFetch([
      { tool_calls: [{ function: { name: "list_directory", arguments: {} } }] },
      { content: "done" },
    ]);

    let approvalRequested = false;
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: {
        onApprovalRequested: () => {
          approvalRequested = true;
        },
      },
    });

    await agent.runUserMessage("list the workspace");
    expect(approvalRequested).toBe(false);
  });

  it("gates a destructive shell command (rm -rf) but not an ordinary one", async () => {
    (globalThis as any).fetch = mockChatFetch([
      { tool_calls: [{ function: { name: "run_shell", arguments: { command: "rm -rf build" } } }] },
      { content: "done" },
    ]);

    const requests: ApprovalRequest[] = [];
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: {
        onApprovalRequested: (request) => {
          requests.push(request);
          agent.resolveApproval(request.id, false); // reject — don't actually spawn Docker in a unit test
        },
      },
    });

    await agent.runUserMessage("clean the build dir");
    expect(requests).toHaveLength(1);
    expect(requests[0].summary).toBe("rm -rf build");
  });
});
