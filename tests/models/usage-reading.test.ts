import { describe, it, expect } from "@jest/globals";
import { budgetUsageOf, readUsage } from "../../src/models/usage-reading.js";

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
