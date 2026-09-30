import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";

const MULTI = "Add the model, then write the migration and update the specs, finally document it";

function mockOllama(firstReply?: string) {
  const encoder = new TextEncoder();
  let call = 0;
  (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: [] }) };
    }
    call += 1;
    const content = call === 1 && firstReply ? firstReply : "done";
    const line = JSON.stringify({ message: { role: "assistant", content }, done: true }) + "\n";
    let delivered = false;
    const reader = {
      read: async () => {
        if (delivered) return { done: true, value: undefined };
        delivered = true;
        return { done: false, value: encoder.encode(line) };
      },
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { role: "assistant", content }, done: true }),
      body: { getReader: () => reader },
    };
  });
}

const hints = (statuses: string[]) => statuses.filter((s) => s.includes("looks multi-step"));

describe("multi-step /plan hint", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hint-"));
    delete process.env.NEXUM_PLAN_HINT;
  });

  it("suggests /plan once for a top-level multi-step request, without starting a plan", async () => {
    mockOllama();
    const statuses: string[] = [];
    const plans: string[] = [];
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "m" },
      events: { onStatus: (s) => statuses.push(s), onPlanUpdate: (g) => plans.push(g) },
    });

    await agent.runUserMessage(MULTI);

    expect(hints(statuses)).toHaveLength(1);
    expect(hints(statuses)[0]).toContain("/plan");
    expect(plans).toEqual([]);
  });

  it("stays quiet for a single-step request and when NEXUM_PLAN_HINT=0", async () => {
    mockOllama();
    const statuses: string[] = [];
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "m" },
      events: { onStatus: (s) => statuses.push(s) },
    });

    await agent.runUserMessage("fix the typo in README.md");
    expect(hints(statuses)).toHaveLength(0);

    process.env.NEXUM_PLAN_HINT = "0";
    await agent.runUserMessage(MULTI);
    expect(hints(statuses)).toHaveLength(0);
    delete process.env.NEXUM_PLAN_HINT;
  });

  it("does not hint on the steps of a running plan", async () => {
    mockOllama(JSON.stringify([{ id: "s1", description: MULTI, dependencies: [] }]));
    const statuses: string[] = [];
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "m" },
      events: { onStatus: (s) => statuses.push(s) },
    });

    const steps = await agent.runPlan("ship it");

    expect(steps.every((s) => s.status === "completed")).toBe(true);
    expect(hints(statuses)).toHaveLength(0);
  });
});
