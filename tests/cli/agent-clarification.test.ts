import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";
import { ClarificationRequest } from "../../src/runtime/types.js";

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

describe("Agent clarification flow", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-clarification-test-"));
  });

  it("resolveClarification on an unknown id is a no-op, not a crash", () => {
    (globalThis as any).fetch = mockChatFetch([{ content: "done" }]);
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    expect(() => agent.resolveClarification({ id: "unknown", selectedId: "opt1" })).not.toThrow();
  });

  it("resolves immediately with default option when no listener is wired (headless fallback)", async () => {
    (globalThis as any).fetch = mockChatFetch([{ content: "general explanation" }]);
    const agent = new Agent({ config: { workspaceRoot: tempDir, tier: "local", model: "m" } });
    const req: ClarificationRequest = {
      id: "clar-1",
      prompt: "explain oops",
      question: "Which aspect?",
      options: [{ id: "opt1", label: "General OOP" }],
    };
    const res = await agent.requestClarification(req);
    expect(res.selectedId).toBe("opt1");
  });

  it("pauses and refines prompt when onClarificationRequested is handled", async () => {
    (globalThis as any).fetch = mockChatFetch([{ content: "OOP in TypeScript explained" }]);
    let capturedRequest: ClarificationRequest | null = null;

    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: {
        onClarificationRequested: (req) => {
          capturedRequest = req;
          // Simulate user selecting option 2
          agent.resolveClarification({ id: req.id, selectedId: req.options[0].id });
        },
      },
    });

    const output = await agent.runUserMessage("explain oops");
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.question).toContain("OOP");
    expect(output).toBe("OOP in TypeScript explained");
  });

  it("does not trigger clarification for clear prompts with language specifier", async () => {
    (globalThis as any).fetch = mockChatFetch([{ content: "Java OOP explained" }]);
    let requested = false;

    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: {
        onClarificationRequested: () => {
          requested = true;
        },
      },
    });

    const output = await agent.runUserMessage("explain oops in java");
    expect(requested).toBe(false);
    expect(output).toBe("Java OOP explained");
  });
});
