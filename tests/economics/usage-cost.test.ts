import { describe, it, expect, jest } from "@jest/globals";
import { priceReading } from "../../src/economics/usage-cost.js";
import { DEFAULT_PRICE_CATALOG, PriceCatalog } from "../../src/models/profiles/pricing-catalog.js";
import { estimatePerCallCostUsd, TYPICAL_TURN } from "../../src/models/router/scored-router.js";
import { recordModelCall } from "../../src/models/gateway/inference-dispatcher.js";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";
import { readUsage } from "../../src/models/usage-reading.js";

const GPT_OSS = DEFAULT_PRICE_CATALOG.requirePrice("gpt-oss:120b-cloud", new Date("2026-06-01T00:00:00Z"));
const NOW = new Date("2026-06-01T00:00:00Z");

describe("priceReading", () => {
  it("is exact when the provider reports the cache count", () => {
    const reading = readUsage({ prompt_eval_count: 500, prompt_eval_cached_count: 500, eval_count: 100 });
    // 500×$0.15 + 500×$0.014 + 100×$0.60 per million → 75 + 7 + 60 µ$
    expect(priceReading(reading, GPT_OSS)).toEqual({ costMicroUsd: 142, basis: "EXACT" });
  });

  it("is an upper bound when the cache count is absent: cached tokens are billed as fresh", () => {
    const reading = readUsage({ prompt_eval_count: 1000, eval_count: 100 });
    // 1000×$0.15 + 100×$0.60 = 150 + 60 µ$; the real cache discount can only lower this
    expect(priceReading(reading, GPT_OSS)).toEqual({ costMicroUsd: 210, basis: "UPPER_BOUND_NO_CACHE_COUNT" });
  });

  it("has no cost for a reading whose counts were missing: never zero", () => {
    expect(priceReading(readUsage({ prompt_eval_count: 1000 }), GPT_OSS)).toBeUndefined();
    expect(priceReading(readUsage({}), GPT_OSS)).toBeUndefined();
  });
});

describe("per-turn estimate used by routing", () => {
  it("prices the typical turn from the catalogue", () => {
    // 2,000 × $0.15 + 400 × $0.60 per million = 300 + 240 µ$ = $0.00054
    expect(estimatePerCallCostUsd("gpt-oss:120b-cloud", DEFAULT_PRICE_CATALOG, NOW)).toBeCloseTo(0.00054, 9);
    expect(TYPICAL_TURN).toEqual({ promptTokens: 2_000, completionTokens: 400 });
  });

  it("is undefined for an unpriced model, so a local model never gets a cloud price", () => {
    expect(estimatePerCallCostUsd("llama3.2", DEFAULT_PRICE_CATALOG, NOW)).toBeUndefined();
  });

  it("uses the price in force at the time of the estimate", () => {
    const catalog = new PriceCatalog([
      { model: "m:cloud", effectiveFrom: "2025-01-01", inputPerMTok: 1_000_000, cachedInputPerMTok: 0, outputPerMTok: 0, source: "t", verified: true },
      { model: "m:cloud", effectiveFrom: "2026-01-01", inputPerMTok: 3_000_000, cachedInputPerMTok: 0, outputPerMTok: 0, source: "t", verified: true },
    ]);
    const before = estimatePerCallCostUsd("m:cloud", catalog, new Date("2025-06-01T00:00:00Z"));
    const after = estimatePerCallCostUsd("m:cloud", catalog, new Date("2026-06-01T00:00:00Z"));
    expect(after).toBeCloseTo((before ?? 0) * 3, 9);
  });
});

describe("recordModelCall (cloud calls)", () => {
  function cloudResponse(extra: Record<string, unknown>): ChatResponse {
    return {
      message: { role: "assistant", content: "ok" },
      done: true,
      routedTier: "cloud",
      routedModel: "gpt-oss:120b-cloud",
      ...extra,
    } as ChatResponse;
  }

  it("records the exact catalogue cost of a cloud call with cache counts", () => {
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });
    recordModelCall(budget, DEFAULT_PRICE_CATALOG, cloudResponse({ prompt_eval_count: 500, prompt_eval_cached_count: 500, eval_count: 100 }));
    expect(budget.snapshot()).toMatchObject({ modelCalls: 1, costUsd: 0.000142 });
  });

  it("records no cost for an unpriced cloud model rather than zero", () => {
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });
    const consume = jest.spyOn(budget, "consumeModelCall");
    const response = cloudResponse({ prompt_eval_count: 500, eval_count: 100, routedModel: "unpriced:cloud" });
    recordModelCall(budget, DEFAULT_PRICE_CATALOG, response);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ costUsd: undefined, usageSource: "PROVIDER" }));
  });

  it("does not price a local call even if its counts are present", () => {
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });
    const spy = jest.spyOn(DEFAULT_PRICE_CATALOG, "priceAt");
    recordModelCall(budget, DEFAULT_PRICE_CATALOG, cloudResponse({ routedTier: "local", routedModel: "llama3.2", prompt_eval_count: 5, eval_count: 5 }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
