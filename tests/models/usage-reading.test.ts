import { describe, it, expect } from "@jest/globals";
import {
  budgetUsageOf,
  calculateCostUsd,
  ModelUsageLedger,
  readUsage,
  resolveModelPricing,
} from "../../src/models/usage-reading.js";

describe("readUsage", () => {
  it("is PROVIDER when the provider reports both the prompt and the completion counts", () => {
    const reading = readUsage({ prompt_eval_count: 120, eval_count: 30 });
    expect(reading).toMatchObject({ source: "PROVIDER", promptTokens: 120, completionTokens: 30 });
  });

  it("reports cache hits apart from freshly evaluated prompt tokens", () => {
    const reading = readUsage({ prompt_eval_count: 50, prompt_eval_cached_count: 400, eval_count: 10 });
    expect(reading.promptTokens).toBe(50);
    expect(reading.cachedPromptTokens).toBe(400);
  });

  it("is MISSING, never zero, when the provider omits its counters", () => {
    const reading = readUsage({ message: { role: "assistant", content: "hi" }, done: true });
    expect(reading.source).toBe("MISSING");
    expect(reading.promptTokens).toBeUndefined();
    expect(reading.completionTokens).toBeUndefined();
  });

  it("is MISSING for an absent response", () => {
    expect(readUsage(undefined).source).toBe("MISSING");
    expect(readUsage(null).source).toBe("MISSING");
  });

  it("keeps a partial reading as reported without completing the missing half", () => {
    const reading = readUsage({ prompt_eval_count: 99 });
    expect(reading.source).toBe("MISSING");
    expect(reading.promptTokens).toBe(99);
    expect(reading.completionTokens).toBeUndefined();
  });

  it("rejects counters that are not non-negative finite numbers", () => {
    expect(readUsage({ prompt_eval_count: "12", eval_count: 3 }).source).toBe("MISSING");
    expect(readUsage({ prompt_eval_count: -1, eval_count: 3 }).source).toBe("MISSING");
    expect(readUsage({ prompt_eval_count: Number.NaN, eval_count: 3 }).source).toBe("MISSING");
    expect(readUsage({ prompt_eval_count: 5, eval_count: Number.POSITIVE_INFINITY }).source).toBe("MISSING");
  });
});

describe("budgetUsageOf", () => {
  it("hands the budget the reported counts with their source", () => {
    expect(budgetUsageOf(readUsage({ prompt_eval_count: 7, eval_count: 3 }))).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      usageSource: "PROVIDER",
    });
  });

  it("hands the budget no invented counts for a MISSING reading", () => {
    const input = budgetUsageOf(readUsage({}));
    expect(input.usageSource).toBe("MISSING");
    expect(input.promptTokens).toBeUndefined();
    expect(input.completionTokens).toBeUndefined();
  });
});

describe("resolveModelPricing and calculateCostUsd", () => {
  it("treats local tier as zero cost", () => {
    const pricing = resolveModelPricing("gemma4:cloud", "local");
    expect(pricing).toEqual({ input: 0, output: 0 });
    expect(calculateCostUsd(pricing, 1000, 2000)).toBe(0);
  });

  it("resolves cloud standard pricing for known models", () => {
    const pricing = resolveModelPricing("gemma4:cloud", "cloud");
    expect(pricing).toEqual({ input: 0.14, output: 0.4 });
    // (1M / 1M * 0.14) + (1M / 1M * 0.40) = 0.54
    expect(calculateCostUsd(pricing, 1_000_000, 1_000_000)).toBe(0.54);
  });

  it("marks cost as unknown when counters or pricing are absent", () => {
    expect(calculateCostUsd(undefined, 100, 200)).toBe("unknown");
    expect(calculateCostUsd({ input: 0.14, output: 0.4 }, undefined, 200)).toBe("unknown");
  });
});

describe("ModelUsageLedger", () => {
  it("records success and failure calls with exact metadata", () => {
    const ledger = new ModelUsageLedger();
    ledger.record({
      runId: "run_1",
      taskId: "task_a",
      provider: "ollama",
      model: "gemma4:cloud",
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      estimatedCostUsd: 0.00034,
      latencyMs: 120,
      retryCount: 0,
      status: "success",
      timestamp: "2026-11-21T00:00:00.000Z",
    });

    ledger.record({
      runId: "run_1",
      taskId: "task_b",
      provider: "ollama",
      model: "gemma4:cloud",
      inputTokens: "unknown",
      cachedInputTokens: "unknown",
      outputTokens: "unknown",
      estimatedCostUsd: "unknown",
      latencyMs: 50,
      retryCount: 1,
      status: "failure",
      timestamp: "2026-11-21T00:00:01.000Z",
      error: "Connection timeout",
    });

    expect(ledger.all()).toHaveLength(2);
    const agg = ledger.aggregateForRun("run_1");
    expect(agg.runId).toBe("run_1");
    expect(agg.totalCostUsd).toBe(0.00034);
    expect(agg.hasUnknownCosts).toBe(true);
    expect(agg.totalInputTokens).toBe(1000);
    expect(agg.totalOutputTokens).toBe(500);
    expect(agg.totalCalls).toBe(2);
    expect(agg.failedCalls).toBe(1);
  });
});
