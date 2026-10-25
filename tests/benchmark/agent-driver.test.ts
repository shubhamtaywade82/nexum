import { Agent } from "../../src/cli/agent.js";
import { createAgentDriver, caseRequest } from "../../src/benchmark/agent-driver.js";
import { runBenchmark, type BenchmarkTarget, type CaseRunOutcome } from "../../src/benchmark/runner.js";
import type { AgenticBenchmarkCase, AgenticTrajectory, BenchmarkCase } from "../../src/benchmark/types.js";
import { Provider } from "../../src/models/adapters/provider.js";

/**
 * Mocks Ollama for a real Agent: each /api/chat call answers with the next scripted turn, with
 * usage counts, as Ollama's final stream chunk carries them. Other endpoints are answered without
 * consuming a turn, so incidental calls (model listing, capability probes) cannot shift the script.
 */
function mockOllama(turns: Array<{ content?: string; tool_calls?: unknown[] }>): () => number {
  let chatCalls = 0;
  const encoder = new TextEncoder();
  (globalThis as any).fetch = jest.fn().mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: [] }) };
    }
    if (typeof url !== "string" || !url.endsWith("/api/chat")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const turn = turns[Math.min(chatCalls, turns.length - 1)];
    chatCalls += 1;
    const message = { role: "assistant", content: turn.content ?? "", tool_calls: turn.tool_calls };
    const body = { message, done: true, prompt_eval_count: 40, eval_count: 10 };
    const line = JSON.stringify(body) + "\n";
    let delivered = false;
    const reader = {
      read: async () => {
        if (delivered) return { done: true, value: undefined };
        delivered = true;
        return { done: false, value: encoder.encode(line) };
      },
    };
    return { ok: true, status: 200, json: async () => body, body: { getReader: () => reader } };
  });
  return () => chatCalls;
}

function noteCase(validate: (t: AgenticTrajectory) => { pass: boolean; reason?: string }): AgenticBenchmarkCase {
  return {
    id: "agent-driver-note",
    description: "fetch a note through the case tool",
    kind: "agentic",
    category: "agentic-looping",
    messages: [{ role: "user", content: "Fetch the note n1 and tell me exactly what the note says." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_note",
          description: "Fetch a note by its id",
          parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    ],
    maxTurns: 3,
    resolveTool: async (_name, args) => ({ id: args.id, text: "the vault code is 4471" }),
    validate,
  };
}

const target = (): BenchmarkTarget => ({
  model: "bench-model",
  tier: "local",
  provider: new Provider({ tier: "local", model: "bench-model" }),
});

describe("agent-driven benchmark", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  // The case runs through the real Agent: its loop, prompt and tool selection.
  function realAgentDriver(seen: { tools?: string[] } = {}) {
    return createAgentDriver(({ workspaceRoot, target: t, events }) => {
      const agent = new Agent({
        config: { workspaceRoot, tier: t.tier, model: t.model, quickModel: t.model, toolSelectionMode: "heuristic" },
        events,
      });
      const replace = agent.tools.replaceAllTools.bind(agent.tools);
      agent.tools.replaceAllTools = (tools, meta, category) => {
        replace(tools, meta, category);
        seen.tools = agent.tools.registry.getTools().map((tool) => tool.name);
      };
      return agent;
    });
  }

  it("works the case through the agent's own loop, using only the case's tools", async () => {
    mockOllama([
      { tool_calls: [{ function: { name: "get_note", arguments: { id: "n1" } } }] },
      { content: "The note says: the vault code is 4471." },
    ]);
    let trajectory: AgenticTrajectory | undefined;
    const seen: { tools?: string[] } = {};
    const outcome = await realAgentDriver(seen)(
      target(),
      noteCase((t) => {
        trajectory = t;
        return { pass: t.finalContent.includes("4471") && t.toolCallsMade.length === 1 };
      }),
    );

    expect(outcome.pass).toBe(true);
    expect(trajectory?.toolCallsMade).toEqual([
      { name: "get_note", args: { id: "n1" }, result: { id: "n1", text: "the vault code is 4471" } },
    ]);
    // No built-in tool (shell, filesystem, network) survives: the case is the whole environment.
    expect(seen.tools).toEqual(["get_note"]);
    expect(outcome.modelsUsed).toEqual(["bench-model"]);
  });

  it("counts the tokens the model reported for every call, not a fixed number", async () => {
    const chatCalls = mockOllama([
      { tool_calls: [{ function: { name: "get_note", arguments: { id: "n1" } } }] },
      { content: "The note says: the vault code is 4471." },
    ]);
    const outcome = await realAgentDriver()(
      target(),
      noteCase(() => ({ pass: true })),
    );

    expect(outcome.tokensEstimated).toBe(false);
    // Each scripted reply reports 40 prompt + 10 completion tokens.
    expect(outcome.tokens).toBe(50 * chatCalls());
    expect(outcome.tokens).toBeGreaterThan(0);
  });

  it("cuts a runaway loop off at the case's budget and records the cut-off", async () => {
    // The model keeps calling the tool and never answers.
    mockOllama([{ tool_calls: [{ function: { name: "get_note", arguments: { id: "n1" } } }] }]);
    let trajectory: AgenticTrajectory | undefined;
    const runaway = { ...noteCase((t) => ((trajectory = t), { pass: !t.hitMaxTurns })), maxTurns: 1 };

    const outcome = await realAgentDriver()(target(), runaway);

    expect(trajectory?.hitMaxTurns).toBe(true);
    expect(trajectory?.toolCallsMade).toHaveLength(1);
    expect(outcome.pass).toBe(false);
  }, 30_000);

  it("joins the case's messages into the request the agent receives", () => {
    const request = caseRequest({
      ...noteCase(() => ({ pass: true })),
      messages: [
        { role: "system", content: "Answer with the code only." },
        { role: "user", content: "What is the code?" },
      ],
    });
    expect(request).toBe("Answer with the code only.\n\nWhat is the code?");
  });

  it("runs only agentic cases under the agent driver, and labels every result with its driver", async () => {
    const singleTurn: BenchmarkCase = {
      id: "single",
      description: "raw model output",
      messages: [{ role: "user", content: "hi" }],
      validate: () => ({ pass: true }),
    };
    const agentic = noteCase(() => ({ pass: true }));
    const fakeDriver = async (): Promise<CaseRunOutcome> => ({
      pass: true,
      tokensPerSec: null,
      tokens: 7,
      tokensEstimated: false,
      modelsUsed: ["bench-model"],
    });

    const results = await runBenchmark([target()], [singleTurn, agentic], { agentDriver: fakeDriver });

    expect(results.map((r) => r.caseId)).toEqual(["agent-driver-note"]);
    expect(results[0]).toMatchObject({ driver: "agent", tokens: 7, modelsUsed: ["bench-model"] });
  });
});
