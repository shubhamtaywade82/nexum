import {
  filterCasesByCategory,
  getAllBenchmarkCases,
  EVOLUTION_BENCHMARK_REPEATS,
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
    // Not recorded for this result, so not invented: the reliability aggregate ignores it.
    expect(taskRes.toolCalls).toBeUndefined();
    expect(taskRes.toolErrors).toBeUndefined();
    expect(taskRes.latencyMs).toBe(1200);
    // The provider-reported usage, not a constant.
    expect(taskRes.tokens).toBe(812);
    expect(taskRes.tokensEstimated).toBe(false);
  });

  it("carries the tool-call counts the runner recorded, and never a category-derived constant", () => {
    const bRes: BenchmarkResult = {
      model: "m",
      tier: "local",
      caseId: "case-tools-1",
      category: "tool-calling",
      pass: false,
      latencyMs: 1,
      tokensPerSec: null,
      tokens: 0,
      tokensEstimated: false,
      toolCalls: 5,
      toolErrors: 3,
    };
    expect(toTaskExecutionResult(bRes)).toEqual(expect.objectContaining({ toolCalls: 5, toolErrors: 3 }));
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

    // The evolution measurement repeats every case; each repeat is one sample of the same task.
    const results = await runHarnessBenchmark(mockProvider, ["output-format"], [mockCase]);
    expect(results).toHaveLength(EVOLUTION_BENCHMARK_REPEATS);
    expect(results.map((r) => r.taskId)).toEqual(Array(EVOLUTION_BENCHMARK_REPEATS).fill("test-ping"));
    expect(results.map((r) => r.sample)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.success)).toBe(true);
  });
});
