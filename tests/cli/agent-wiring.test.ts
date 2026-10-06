import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";

function chatResponse(content: string) {
  const encoder = new TextEncoder();
  const body = { message: { role: "assistant", content }, done: true };
  let delivered = false;
  return {
    ok: true,
    status: 200,
    json: async () => body,
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(JSON.stringify(body) + "\n") };
        },
      }),
    },
  };
}

const QUICK = { name: "minicpm5-1b", capabilities: ["completion", "tools"], details: { parameter_size: "1B" } };

function chatBodies(): Array<{ model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[] }> {
  return (globalThis.fetch as jest.Mock).mock.calls.filter((c) => c[1]?.body).map((c) => JSON.parse(c[1].body));
}

function mockFetch(reply: (body: { model: string; messages: Array<{ content: string }> }) => string) {
  let first = true;
  (globalThis as any).fetch = jest.fn().mockImplementation(async (_url: string, init?: { body?: string }) => {
    if (!init?.body) {
      if (first) {
        first = false;
        return { ok: true, status: 200, json: async () => ({ models: [QUICK] }) };
      }
      return { ok: true, status: 200, json: async () => ({ models: [QUICK] }) };
    }
    return chatResponse(reply(JSON.parse(init.body)));
  });
}

describe("Agent wiring — model budget", () => {
  afterEach(() => jest.restoreAllMocks());

  it("caps tool schemas sent to a small quick model at its toolBudget, keeping escalate_task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockFetch(() => "ok");
    const agent = new Agent({
      config: {
        workspaceRoot: dir,
        tier: "local",
        model: "test-model",
        maxActiveTools: 30,
        enableHeuristicGate: false,
      },
    });
    await agent.runUserMessage("read the config file and list files in the src directory");
    const quickCall = chatBodies().find((b) => b.model === "minicpm5-1b")!;
    const names = ((quickCall.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names.length).toBeLessThanOrEqual(6);
    expect(names).toContain("escalate_task");
    expect(agent.budgetFor("quick")).toMatchObject({ modelId: "minicpm5-1b", sizeClass: "small", toolBudget: 6 });
  });
});

describe("Agent wiring — opt-in critic (NEXUM_VERIFIER)", () => {
  afterEach(() => jest.restoreAllMocks());

  const critic = (b: { messages: Array<{ content: string }> }) =>
    b.messages.some((m) => m.content.startsWith("You are a code critic"));

  it("escalates to the primary model with the critic's issues when the quick answer is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockFetch((b) => {
      if (critic(b)) return "REJECT\n- the capital of Australia is Canberra, not Sydney";
      return b.model === "minicpm5-1b" ? "Sydney" : "Canberra";
    });
    const onStatus = jest.fn();
    const agent = new Agent({
      config: {
        workspaceRoot: dir,
        tier: "local",
        model: "test-model",
        enableHeuristicGate: false,
        enableLocalWorker: true,
        enableVerifier: true,
      },
      events: { onStatus },
    });
    const reply = await agent.runUserMessage("hey, what's the capital of Australia?");
    expect(reply).toBe("Canberra");
    expect(onStatus).toHaveBeenCalledWith("escalating to primary model: critic rejected the quick-model answer");
    const primary = chatBodies().find((b) => b.model === "test-model" && !critic(b))!;
    expect(primary.messages.some((m) => m.content.includes("A reviewer rejected the previous draft"))).toBe(true);
    expect(primary.messages.some((m) => m.content === "Sydney")).toBe(false);
  });

  it("keeps the quick answer when the critic verifies it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockFetch((b) => (critic(b) ? "VERIFIED" : b.model === "minicpm5-1b" ? "Canberra" : "primary"));
    const agent = new Agent({
      config: {
        workspaceRoot: dir,
        tier: "local",
        model: "test-model",
        enableHeuristicGate: false,
        enableLocalWorker: true,
        enableVerifier: true,
      },
    });
    expect(await agent.runUserMessage("hey, what's the capital of Australia?")).toBe("Canberra");
  });
});

import { FakeDecisionGateway } from "../../src/models/decision/fake-gateway.js";

describe("Agent wiring — decision plane", () => {
  afterEach(() => jest.restoreAllMocks());

  it("routes an ambiguous prompt through System One and escalates on a cloud verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockFetch((b) => (b.model === "minicpm5-1b" ? "quick" : "primary"));
    const decide = jest.fn();
    const gateway = new FakeDecisionGateway({
      decisions: {
        tier: { selected: "cloud", probabilities: { cloud: 0.95, local: 0.05 } },
        domain: { selected: "filesystem", probabilities: { filesystem: 0.9 } },
      },
      onDecide: (req) => decide(req.questions.map((q) => q.id)),
    });
    const onStatus = jest.fn();
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model", enableDecision: true },
      decisionGateway: gateway,
      events: { onStatus },
    });
    const reply = await agent.runUserMessage("hmm, thoughts on this?");
    expect(reply).toBe("primary");
    expect(decide).toHaveBeenCalledWith(["tier"]);
    expect(onStatus).toHaveBeenCalledWith("escalating to primary model: decision plane classified it as cloud-tier");
  });

  it("falls back to deterministic routing when System One fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockFetch((b) => (b.model === "minicpm5-1b" ? "quick" : "primary"));
    const { DecisionTransportError } = await import("../../src/models/decision/index.js");
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model", enableDecision: true },
      decisionGateway: new FakeDecisionGateway({ decisions: {}, failWith: new DecisionTransportError("down") }),
    });
    expect(await agent.runUserMessage("hmm, thoughts on this?")).toBe("quick");
  });
});
