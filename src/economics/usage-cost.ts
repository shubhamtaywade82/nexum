/**
 * Prices one provider reading. The reading decides what can be said about the cost:
 *   - Counts reported with the cache count: the cost is exact (per-response disjoint semantics).
 *   - Counts reported without the cache count: the fresh count is billed at the full input rate. Cache hits, which
 *     cost less, are then over-counted, so the figure is an UPPER BOUND. A cap built on it errs toward refusing.
 *   - Counts missing (`MISSING`): there is no cost. The caller records the call as unpriced, never as zero.
 */

import type { UsageReading } from "../models/usage-reading.js";
import { costFromDisjointCounts, type MicroUsd, type TokenPrice } from "./cost.js";

export type CostBasis = "EXACT" | "UPPER_BOUND_NO_CACHE_COUNT";

export interface PricedReading {
  readonly costMicroUsd: MicroUsd;
  readonly basis: CostBasis;
}

/** The cost of one reading at one price, or undefined when the provider did not report the counts. */
export function priceReading(reading: UsageReading, price: TokenPrice): PricedReading | undefined {
  if (reading.source !== "PROVIDER" || reading.promptTokens === undefined || reading.completionTokens === undefined) {
    return undefined;
  }
  const exact = reading.cachedPromptTokens !== undefined;
  const costMicroUsd = costFromDisjointCounts(
    {
      promptTokens: reading.promptTokens,
      cachedPromptTokens: reading.cachedPromptTokens ?? 0,
      completionTokens: reading.completionTokens,
    },
    price,
  );
  return { costMicroUsd, basis: exact ? "EXACT" : "UPPER_BOUND_NO_CACHE_COUNT" };
}
