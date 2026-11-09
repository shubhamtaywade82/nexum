import { Provider, ChatResponse } from "../../src/models/adapters/provider.js";
import { runBenchmark } from "../../src/benchmark/runner.js";
import { AgenticBenchmarkCase, BenchmarkCase } from "../../src/benchmark/types.js";

function response(content: string, extra: Partial<ChatResponse> = {}): ChatResponse {
  return { message: { role: "assistant", content }, done: true, ...extra };
}

const passingCase: BenchmarkCase = {
  id: "always-pass",
  description: "trivially passes",
  messages: [{ role: "user", content: "hi" }],
  validate: () => ({ pass: true }),
};

const failingCase: BenchmarkCase = {
  id: "always-fail",
  description: "trivially fails",
  messages: [{ role: "user", content: "hi" }],
  validate: () => ({ pass: false, reason: "nope" }),
};

describe("runBenchmark", () => {
  it("runs every case against every target and records pass/fail", async () => {
    const provider = new Provider({ tier: "local", model: "placeholder" });
    jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase, failingCase]);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.caseId === "always-pass")?.pass).toBe(true);
    expect(results.find((r) => r.caseId === "always-fail")?.pass).toBe(false);
    expect(results.find((r) => r.caseId === "always-fail")?.reason).toBe("nope");
  });

  it("sets the provider's model/tier before invoking chat", async () => {
    const provider = new Provider({ tier: "cloud", model: "placeholder" });
    const chatSpy = jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));

    await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(provider.currentModel).toBe("qwen3:8b");
    expect(provider.currentTier).toBe("local");
    expect(chatSpy).toHaveBeenCalled();
  });

  it("records a failing result with the error message when chat throws", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockRejectedValue(new Error("connection refused"));

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(results[0].pass).toBe(false);
    expect(results[0].error).toBe("connection refused");
    expect(results[0].tokensPerSec).toBeNull();
  });

  it("computes tokensPerSec from eval_count/eval_duration when present", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(
      response("ok", { eval_count: 100, eval_duration: 2_000_000_000 }), // 2s -> 50 tok/s
    );

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(results[0].tokensPerSec).toBe(50);
  });

  it("falls back to a content-length estimate when eval fields are absent", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest
      .spyOn(provider, "chat")
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(response("a".repeat(40))), 5)));

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase]);

    expect(results[0].tokensPerSec).not.toBeNull();
    expect(results[0].tokensPerSec).toBeGreaterThan(0);
  });

  it("fast-fails remaining cases for a target model that returns 402 subscription error", async () => {
    const provider = new Provider({ tier: "cloud", model: "paid-model" });
    const chatSpy = jest
      .spyOn(provider, "chat")
      .mockRejectedValue(new Error("Ollama cloud 402: requires a subscription"));

    const results = await runBenchmark(
      [{ model: "paid-model", tier: "cloud", provider }],
      [passingCase, failingCase, passingCase],
    );

    expect(results).toHaveLength(3);
    expect(chatSpy).toHaveBeenCalledTimes(1); // called only once, subsequent cases fast-failed
    expect(results[0].error).toContain("402");
    expect(results[1].error).toContain("402");
    expect(results[2].error).toContain("402");
    expect(results[1].latencyMs).toBe(0);
  });
});

function toolCallResponse(name: string, args: Record<string, unknown>): ChatResponse {
  return {
    message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] },
    done: true,
  };
}

describe("runBenchmark — agentic cases", () => {
  it("loops through scripted tool calls and validates the final trajectory", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    let call = 0;
    jest.spyOn(provider, "chat").mockImplementation(async () => {
      call += 1;
      if (call === 1) return toolCallResponse("step_one", { x: 1 });
      if (call === 2) return toolCallResponse("step_two", { y: 2 });
      return response("done: 42");
    });

    const agenticCase: AgenticBenchmarkCase = {
      id: "two-step",
      kind: "agentic",
      description: "two scripted tool calls then a final answer",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      maxTurns: 5,
      resolveTool: async (name) => ({ ok: true, from: name }),
      validate: (trajectory) => {
        const names = trajectory.toolCallsMade.map((c) => c.name);
        if (names.join(",") !== "step_one,step_two")
          return { pass: false, reason: `wrong tool order: ${names.join(",")}` };
        if (!trajectory.finalContent.includes("42")) return { pass: false, reason: "final content missing 42" };
        if (trajectory.hitMaxTurns) return { pass: false, reason: "should not have hit max turns" };
        return { pass: true };
      },
    };

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [agenticCase]);

    expect(results[0].pass).toBe(true);
    expect(results[0].category).toBeUndefined();
  });

  it("runs each case the requested number of times, rebuilding the case factory for each repeat", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));
    let factoryCalls = 0;
    const buildCases = (): BenchmarkCase[] => {
      factoryCalls += 1;
      return [
        {
          id: "repeated",
          kind: "single",
          description: "one turn",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          validate: () => ({ pass: true }),
        } as SingleTurnBenchmarkCase,
      ];
    };

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], buildCases, { repeats: 3 });

    expect(results.map((r) => r.sample)).toEqual([0, 1, 2]);
    expect(factoryCalls).toBe(3);
  });

  it("leaves results unlabelled by sample when the case runs once", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));
    const [result] = await runBenchmark(
      [{ model: "qwen3:8b", tier: "local", provider }],
      [
        {
          id: "once",
          kind: "single",
          description: "one turn",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          validate: () => ({ pass: true }),
        } as SingleTurnBenchmarkCase,
      ],
    );
    expect(result).not.toHaveProperty("sample");
  });

  it("records the tool calls it executed and how many returned an error, from the trajectory", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    let call = 0;
    jest.spyOn(provider, "chat").mockImplementation(async () => {
      call += 1;
      if (call === 1) return toolCallResponse("lookup", { id: "missing" });
      if (call === 2) return toolCallResponse("lookup", { id: "u123" });
      return response("done");
    });
    const agenticCase: AgenticBenchmarkCase = {
      id: "counted",
      kind: "agentic",
      description: "one failing and one successful lookup",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      maxTurns: 5,
      resolveTool: async (_name, args) => (args.id === "u123" ? { ok: true } : { error: "not found" }),
      validate: () => ({ pass: true }),
    };

    const [result] = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [agenticCase]);

    expect(result.toolCalls).toBe(2);
    expect(result.toolErrors).toBe(1);
  });

  it("records zero executed tool calls for a single-turn case, which runs no tools", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(response("an answer"));
    const singleCase: SingleTurnBenchmarkCase = {
      id: "single",
      kind: "single",
      description: "one turn",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      validate: () => ({ pass: true }),
    } as SingleTurnBenchmarkCase;

    const [result] = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [singleCase]);

    expect(result.toolCalls).toBe(0);
    expect(result.toolErrors).toBe(0);
  });

  it("marks hitMaxTurns when the model never stops calling tools", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(toolCallResponse("loop_forever", {}));

    const agenticCase: AgenticBenchmarkCase = {
      id: "never-ends",
      kind: "agentic",
      description: "the model keeps calling a tool and never answers",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      maxTurns: 3,
      resolveTool: async () => ({ ok: true }),
      validate: (trajectory) => ({
        pass: !trajectory.hitMaxTurns,
        reason: trajectory.hitMaxTurns ? "hit max turns" : undefined,
      }),
    };

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [agenticCase]);

    expect(results[0].pass).toBe(false);
    expect(results[0].reason).toBe("hit max turns");
  });

  it("calls a case factory fresh per target, so per-target closure state doesn't leak across models", async () => {
    const providerA = new Provider({ tier: "local", model: "a" });
    const providerB = new Provider({ tier: "local", model: "b" });
    jest.spyOn(providerA, "chat").mockImplementation(async () => response("first call always"));
    jest.spyOn(providerB, "chat").mockImplementation(async () => response("first call always"));

    let factoryCalls = 0;
    const buildCases = (): BenchmarkCase[] => {
      factoryCalls += 1;
      let callCount = 0;
      const stateful: AgenticBenchmarkCase = {
        id: "stateful",
        kind: "agentic",
        description: "tracks its own call count via a per-target-fresh closure",
        messages: [{ role: "user", content: "go" }],
        tools: [],
        maxTurns: 2,
        resolveTool: async () => ({ ok: true }),
        validate: () => {
          callCount += 1;
          // If the factory weren't called fresh per target, callCount would
          // keep incrementing across targets instead of always starting at 1.
          return { pass: callCount === 1, reason: `callCount was ${callCount}` };
        },
      };
      return [stateful];
    };

    const results = await runBenchmark(
      [
        { model: "a", tier: "local", provider: providerA },
        { model: "b", tier: "local", provider: providerB },
      ],
      buildCases,
    );

    expect(factoryCalls).toBe(2);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

describe("runBenchmark — progress events and timeouts", () => {
  it("emits a running event before and a done event after each case", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    jest.spyOn(provider, "chat").mockResolvedValue(response("ok"));

    const events: Array<{ caseId: string; index: number; total: number; status: string; pass?: boolean }> = [];
    await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase, failingCase], {
      onProgress: (e) => events.push(e),
    });

    expect(events).toEqual([
      expect.objectContaining({ caseId: "always-pass", index: 0, total: 2, status: "running" }),
      expect.objectContaining({ caseId: "always-pass", index: 0, total: 2, status: "done", pass: true }),
      expect.objectContaining({ caseId: "always-fail", index: 1, total: 2, status: "running" }),
      expect.objectContaining({ caseId: "always-fail", index: 1, total: 2, status: "done", pass: false }),
    ]);
  });

  it("records a timeout as a failing result and reports it via onProgress instead of hanging", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    // Never resolves — simulates a stalled local Ollama server (no built-in timeout on that tier).
    jest.spyOn(provider, "chat").mockImplementation(() => new Promise(() => {}));

    const events: Array<{ status: string; error?: string }> = [];
    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase], {
      timeoutMs: 20,
      onProgress: (e) => events.push(e),
    });

    expect(results[0].pass).toBe(false);
    expect(results[0].error).toMatch(/timed out after 20ms/);
    expect(events[events.length - 1]).toEqual(
      expect.objectContaining({ status: "done", error: expect.stringMatching(/timed out/) }),
    );
  });

  it("moves on to the next case after one times out, rather than blocking the run", async () => {
    const provider = new Provider({ tier: "local", model: "x" });
    let call = 0;
    jest.spyOn(provider, "chat").mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise(() => {}); // first case's call never resolves
      return Promise.resolve(response("ok"));
    });

    const results = await runBenchmark([{ model: "qwen3:8b", tier: "local", provider }], [passingCase, passingCase], {
      timeoutMs: 20,
    });

    expect(results).toHaveLength(2);
    expect(results[0].error).toMatch(/timed out/);
    expect(results[1].pass).toBe(true); // second case ran to completion, unaffected
  });
});
