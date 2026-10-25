import {
  filterCasesByCategory,
  getAllBenchmarkCases,
  runHarnessBenchmark,
  toTaskExecutionResult,
} from "../../src/evolution/benchmarks.js";
import { BenchmarkCase, BenchmarkResult } from "../../src/benchmark/types.js";
import { isHeldOutCase } from "../../src/evolution/heldout-split.js";
import { Provider } from "../../src/models/adapters/provider.js";

describe("Evolution Benchmarks Bridge", () => {
  it("gathers all benchmark cases across suites", async () => {
    const cases = await getAllBenchmarkCases();
    expect(cases.length).toBeGreaterThan(10);
    const categories = cases.map((c) => c.category);
    expect(categories).toContain("agentic-looping");
    expect(categories).toContain("tool-calling");
  });

  it("filters cases by category", async () => {
    const cases = await getAllBenchmarkCases();
    const filtered = filterCasesByCategory(cases, ["agentic-looping"]);
    expect(filtered.length).toBeGreaterThan(0);
    for (const c of filtered) {
      expect(c.category).toBe("agentic-looping");
    }
  });

  it("transforms BenchmarkResult to TaskExecutionResult", () => {
    const bRes: BenchmarkResult = {
      model: "qwen2.5-coder:7b",
      tier: "local",
      caseId: "case-loop-1",
      category: "agentic-looping",
      pass: true,
      latencyMs: 1200,
      tokensPerSec: 45,
      tokens: 812,
      tokensEstimated: false,
    };

    const taskRes = toTaskExecutionResult(bRes);
    expect(taskRes.taskId).toBe("case-loop-1");
    expect(taskRes.success).toBe(true);
    expect(taskRes.verificationPassed).toBe(true);
    expect(taskRes.toolCalls).toBe(2);
    expect(taskRes.toolErrors).toBe(0);
    expect(taskRes.latencyMs).toBe(1200);
    // The provider-reported usage, not a constant.
    expect(taskRes.tokens).toBe(812);
    expect(taskRes.tokensEstimated).toBe(false);
  });

  it("assigns held-out by the frozen case-id split, never by category label", () => {
    const base = {
      model: "m",
      tier: "local" as const,
      pass: true,
      latencyMs: 1,
      tokensPerSec: null,
      tokens: 0,
      tokensEstimated: false,
    };
    // A category label carries no held-out meaning: the flag is the same hash assignment for every category.
    for (const category of ["reasoning", "thinking", "tool-calling"] as const) {
      const taskRes = toTaskExecutionResult({ ...base, caseId: "case-split-probe", category });
      expect(taskRes.isHeldOut).toBe(isHeldOutCase("case-split-probe"));
    }
  });

  it("runs benchmark cases with a mock provider", async () => {
    const mockProvider = {
      model: "mock-model",
      tier: "local" as const,
      currentModel: "mock-model",
      currentTier: "local" as const,
      chat: jest.fn().mockResolvedValue({
        message: { role: "assistant", content: "pong" },
      }),
      setModel: jest.fn(),
      setTier: jest.fn(),
    } as unknown as Provider;

    const mockCase: BenchmarkCase = {
      id: "test-ping",
      category: "output-format",
      description: "Ping case",
      messages: [{ role: "user", content: "ping" }],
      validate: (resp) => ({ pass: resp.message?.content === "pong" }),
    };

    const results = await runHarnessBenchmark(mockProvider, ["output-format"], [mockCase]);
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("test-ping");
    expect(results[0].success).toBe(true);
  });
});
