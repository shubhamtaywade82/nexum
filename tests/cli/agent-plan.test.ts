import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";

describe("Agent.runPlan", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-plan-test-"));
  });

  it("generates a plan, executes each step through the orchestrator, and emits onPlanUpdate start+end", async () => {
    const planJson = JSON.stringify([
      { id: "s1", description: "step one", dependencies: [] },
      { id: "s2", description: "step two", dependencies: ["s1"] },
    ]);
    let call = 0;
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
      }
      call += 1;
      // Call 1 is generatePlan's non-streamed request; every subsequent call
      // is a step's own runUserMessage turn (streamed) — answer "done" with
      // no tool calls so each step succeeds on the first attempt.
      const content = call === 1 ? planJson : "done";
      const line = JSON.stringify({ message: { role: "assistant", content }, done: true }) + "\n";
      let delivered = false;
      const reader = {
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(line) };
        },
        releaseLock: () => {},
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { role: "assistant", content }, done: true }),
        body: { getReader: () => reader },
      };
    });

    const updates: Array<{ goal: string; status: string; stepCount: number }> = [];
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "m" },
      events: {
        onPlanUpdate: (goal, steps, status) => updates.push({ goal, status, stepCount: steps.length }),
      },
    });

    const finalSteps = await agent.runPlan("build the thing");

    expect(finalSteps.every((s) => s.status === "completed")).toBe(true);
    expect(updates[0]).toEqual({ goal: "build the thing", status: "running", stepCount: 2 });
    expect(updates[1]).toEqual({ goal: "build the thing", status: "completed", stepCount: 2 });
  });
});
