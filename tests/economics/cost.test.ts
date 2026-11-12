import { describe, it, expect } from "@jest/globals";
import {
  CostInputError,
  ceilMicroUsd,
  costFromDisjointCounts,
  costFromInclusiveCounts,
  reservationBoundMicroUsd,
  type TokenPrice,
} from "../../src/economics/cost.js";

// $2 / M input, $0.50 / M cached input, $8 / M output, in integer micro-dollars per million tokens.
const PRICE: TokenPrice = { inputPerMTok: 2_000_000, cachedInputPerMTok: 500_000, outputPerMTok: 8_000_000 };

describe("cost formulas (N-4)", () => {
  it("per-response counts and dashboard totals describe the same usage and cost the same", () => {
    // Ollama per-response: 40 fresh prompt tokens, 60 served from cache, 10 generated.
    const disjoint = costFromDisjointCounts({ promptTokens: 40, cachedPromptTokens: 60, completionTokens: 10 }, PRICE);
    // Dashboard: the same 100 input tokens, with the 60 cached ones included in the total.
    const inclusive = costFromInclusiveCounts({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 }, PRICE);

    expect(disjoint).toBe(190); // 40×$2 + 60×$0.50 + 10×$8, all per million, in micro-dollars
    expect(inclusive).toBe(disjoint);
  });

  it("does not double count cached tokens in either shape", () => {
    // Reading the disjoint counts as inclusive would bill 60 cached tokens twice: the fresh count would be 40 - 60.
    expect(() => costFromInclusiveCounts({ inputTokens: 40, cachedInputTokens: 60, outputTokens: 0 }, PRICE)).toThrow(
      CostInputError,
    );
  });

  it("rounds each component up, so the estimate never understates the bill", () => {
    // 1 token at 125,000 µ$/M is 0.125 µ$, which must round up to 1 µ$.
    const cheap: TokenPrice = { inputPerMTok: 125_000, cachedInputPerMTok: 0, outputPerMTok: 0 };
    expect(costFromDisjointCounts({ promptTokens: 1, cachedPromptTokens: 0, completionTokens: 0 }, cheap)).toBe(1);
    expect(ceilMicroUsd(1_000_000, 125_000)).toBe(125_000);
    expect(ceilMicroUsd(3, 333_333)).toBe(1);
  });

  it("returns zero for zero tokens at any price", () => {
    expect(costFromDisjointCounts({ promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, PRICE)).toBe(0);
    expect(costFromInclusiveCounts({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, PRICE)).toBe(0);
  });

  it("is exact at large counts (10M tokens at $15/M is exactly $150)", () => {
    const kimiOutput: TokenPrice = { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 15_000_000 };
    expect(costFromDisjointCounts({ promptTokens: 0, cachedPromptTokens: 0, completionTokens: 10_000_000 }, kimiOutput))
      .toBe(150_000_000);
  });

  it("rejects negative, fractional and unsafe counts and prices", () => {
    const base = { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1 };
    expect(() => costFromDisjointCounts({ ...base, promptTokens: -1 }, PRICE)).toThrow(CostInputError);
    expect(() => costFromDisjointCounts({ ...base, completionTokens: 1.5 }, PRICE)).toThrow(CostInputError);
    expect(() => costFromDisjointCounts(base, { ...PRICE, inputPerMTok: 0.5 })).toThrow(CostInputError);
    expect(() => costFromDisjointCounts(base, { ...PRICE, outputPerMTok: -1 })).toThrow(CostInputError);
    // MAX_SAFE_INTEGER tokens at 1e9 µ$/M gives a cost of ~9e18 µ$, beyond the safe range: refuse, do not round.
    expect(() =>
      costFromDisjointCounts({ promptTokens: Number.MAX_SAFE_INTEGER, cachedPromptTokens: 0, completionTokens: 0 }, {
        inputPerMTok: 1_000_000_000,
        cachedInputPerMTok: 0,
        outputPerMTok: 0,
      }),
    ).toThrow(CostInputError);
  });
});

describe("reservation bound (N-13)", () => {
  it("is the input bound at the higher input rate plus the full output allowance", () => {
    // 1,000 input bytes at $2/M = 2,000 µ$; 500 output tokens at $8/M = 4,000 µ$.
    expect(reservationBoundMicroUsd(1_000, 500, PRICE)).toBe(6_000);
  });

  it("is never below the cost of any real usage it has to cover (randomised, deterministic seed)", () => {
    let seed = 42;
    const next = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % (max + 1);
    };
    for (let i = 0; i < 500; i++) {
      const inputBound = next(200_000);
      const maxOutput = next(50_000);
      const actualInput = next(inputBound);
      const actualCached = next(actualInput);
      const actualOutput = next(maxOutput);
      const bound = reservationBoundMicroUsd(inputBound, maxOutput, PRICE);
      const actual = costFromInclusiveCounts(
        { inputTokens: actualInput, cachedInputTokens: actualCached, outputTokens: actualOutput },
        PRICE,
      );
      expect(actual).toBeLessThanOrEqual(bound);
    }
  });
});
