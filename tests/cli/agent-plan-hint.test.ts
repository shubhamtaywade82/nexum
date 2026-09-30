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

describe("multi-step auto-plan routing", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-hint-"));
    delete process.env.NEXUM_AUTO_PLAN;
    delete process.env.NEXUM_PLAN_HINT;
  });

  const PLAN = JSON.stringify([
    { id: "s1", description: "add the model", dependencies: [] },
    { id: "s2", description: "write the migration", dependencies: ["s1"] },
  ]);

  function build(over: Record<string, unknown>, events: Record<string, unknown> = {}) {
    return new Agent({ config: { workspaceRoot: dir, tier: "local", model: "m", ...over }, events: events as any });
  }

  it("ask mode with nobody to approve: hints once, runs a normal turn, starts no plan", async () => {
    mockOllama();
    const statuses: string[] = [];
    const plans: string[] = [];
    const agent = build(
      { autoPlan: "ask" },
      { onStatus: (s: string) => statuses.push(s), onPlanUpdate: (g: string) => plans.push(g) },
    );

    await agent.runUserMessage(MULTI);

    expect(hints(statuses)).toHaveLength(1);
    expect(hints(statuses)[0]).toContain("/plan");
    expect(plans).toEqual([]);
  });

  it("ask mode routes to the orchestrator once the user approves, and returns a plan summary", async () => {
    mockOllama(PLAN);
    const plans: Array<{ goal: string; status: string }> = [];
    let agent!: Agent;
    agent = build(
      { autoPlan: "ask" },
      {
        onApprovalRequested: (req: { id: string; title: string }) => {
          expect(req.title).toBe("Run as a plan?");
          agent.resolveApproval(req.id, true);
        },
        onPlanUpdate: (goal: string, _steps: unknown, status: string) => plans.push({ goal, status }),
      },
    );

    const out = await agent.runUserMessage(MULTI);

    expect(plans.map((p) => p.status)).toEqual(["running", "completed"]);
    expect(plans[0].goal).toBe(MULTI);
    expect(out).toContain("Ran as a plan: 2/2 steps completed.");
    expect(out).toContain("✓ add the model");
  });

  it("a declined offer continues as a normal turn, and stops asking after two declines", async () => {
    mockOllama();
    let asked = 0;
    let agent!: Agent;
    agent = build(
      { autoPlan: "ask" },
      {
        onApprovalRequested: (req: { id: string }) => {
          asked++;
          agent.resolveApproval(req.id, false);
        },
      },
    );

    await agent.runUserMessage(MULTI);
    await agent.runUserMessage(MULTI);
    await agent.runUserMessage(MULTI);

    expect(asked).toBe(2);
  });

  it("always mode plans without asking", async () => {
    mockOllama(PLAN);
    let asked = 0;
    const plans: string[] = [];
    const agent = build(
      { autoPlan: "always" },
      { onApprovalRequested: () => asked++, onPlanUpdate: (_g: string, _s: unknown, st: string) => plans.push(st) },
    );

    const out = await agent.runUserMessage(MULTI);

    expect(asked).toBe(0);
    expect(plans).toEqual(["running", "completed"]);
    expect(out).toContain("Ran as a plan");
  });

  it("falls back to a normal turn when the plan cannot be generated", async () => {
    mockOllama("this is not a plan");
    const statuses: string[] = [];
    const agent = build({ autoPlan: "always" }, { onStatus: (s: string) => statuses.push(s) });

    const out = await agent.runUserMessage(MULTI);

    expect(statuses.some((s) => s.includes("plan could not be generated"))).toBe(true);
    expect(out).not.toContain("Ran as a plan");
  });

  it("off mode never routes or hints; single-step requests are untouched", async () => {
    mockOllama();
    const statuses: string[] = [];
    const off = build({ autoPlan: "off" }, { onStatus: (s: string) => statuses.push(s) });
    await off.runUserMessage(MULTI);
    expect(hints(statuses)).toHaveLength(0);

    const on = build({ autoPlan: "always" }, { onStatus: (s: string) => statuses.push(s) });
    await on.runUserMessage("fix the typo in README.md");
    expect(statuses.some((s) => s.includes("running as a plan"))).toBe(false);
  });

  it("does not route the steps of a running plan", async () => {
    mockOllama(JSON.stringify([{ id: "s1", description: MULTI, dependencies: [] }]));
    const statuses: string[] = [];
    const agent = build({ autoPlan: "always" }, { onStatus: (s: string) => statuses.push(s) });

    const steps = await agent.runPlan("ship it");

    expect(steps.every((s) => s.status === "completed")).toBe(true);
    expect(statuses.some((s) => s.includes("running as a plan"))).toBe(false);
    expect(hints(statuses)).toHaveLength(0);
  });
});
