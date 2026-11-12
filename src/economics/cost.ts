/**
 * Cost arithmetic for the budget ledger.
 *
 * Every amount is an integer count of micro-dollars (1 µ$ = 1e-6 USD) and every price is an integer count of
 * micro-dollars per million tokens. Floats are not used for amounts that feed a cap: a sum of float prices drifts,
 * and an estimate that rounds down can admit spend past the ceiling. Each component rounds UP, so a cost computed
 * here never understates what the provider will bill.
 *
 * Two token semantics exist, and they must not be mixed:
 *   - Per response (Ollama `prompt_eval_count` + `prompt_eval_cached_count`): the two counters are disjoint.
 *     Input tokens are their sum.
 *   - Dashboard (`/api/usage` `input_tokens`): the total already includes the cached tokens. The fresh count is
 *     `input_tokens - cached_input_tokens`.
 * `costFromDisjointCounts` and `costFromInclusiveCounts` take those two shapes explicitly, so a caller cannot pass
 * one where the other is meant without the arithmetic failing.
 */

import { AgentRuntimeError } from "../models/errors.js";

export const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_PRICE_UNIT = 1_000_000n;

/** An integer count of micro-dollars. */
export type MicroUsd = number;

/** Prices in integer micro-dollars per million tokens. */
export interface TokenPrice {
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok: number;
  readonly outputPerMTok: number;
}

export class CostInputError extends AgentRuntimeError {
  constructor(message: string) {
    super(message, "INVALID_COST_INPUT");
  }
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CostInputError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

function assertPrice(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CostInputError(`${name} must be a non-negative integer micro-dollar price, got ${String(value)}`);
  }
}

/** ceil(tokens × pricePerMTok / 1e6), exact. */
export function ceilMicroUsd(tokens: number, pricePerMTok: number): MicroUsd {
  assertCount("tokens", tokens);
  assertPrice("price", pricePerMTok);
  const numerator = BigInt(tokens) * BigInt(pricePerMTok);
  const quotient = (numerator + TOKENS_PER_PRICE_UNIT - 1n) / TOKENS_PER_PRICE_UNIT;
  if (quotient > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CostInputError("cost exceeds the safe integer range");
  }
  return Number(quotient);
}

export function assertTokenPrice(price: TokenPrice): void {
  assertPrice("inputPerMTok", price.inputPerMTok);
  assertPrice("cachedInputPerMTok", price.cachedInputPerMTok);
  assertPrice("outputPerMTok", price.outputPerMTok);
}

export interface DisjointUsage {
  /** Ollama `prompt_eval_count`: prompt tokens evaluated fresh. Excludes cache hits. */
  readonly promptTokens: number;
  /** Ollama `prompt_eval_cached_count`: prompt tokens served from the cache. Disjoint from promptTokens. */
  readonly cachedPromptTokens: number;
  readonly completionTokens: number;
}

export interface InclusiveUsage {
  /** Dashboard `input_tokens`: the total, cached tokens included. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** Cost of one response whose prompt and cache counters are disjoint (Ollama per-response shape). */
export function costFromDisjointCounts(usage: DisjointUsage, price: TokenPrice): MicroUsd {
  assertTokenPrice(price);
  return (
    ceilMicroUsd(usage.promptTokens, price.inputPerMTok) +
    ceilMicroUsd(usage.cachedPromptTokens, price.cachedInputPerMTok) +
    ceilMicroUsd(usage.completionTokens, price.outputPerMTok)
  );
}

/** Cost of usage whose input total already includes the cached tokens (dashboard shape). */
export function costFromInclusiveCounts(usage: InclusiveUsage, price: TokenPrice): MicroUsd {
  assertTokenPrice(price);
  assertCount("inputTokens", usage.inputTokens);
  assertCount("cachedInputTokens", usage.cachedInputTokens);
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new CostInputError(
      `cachedInputTokens (${usage.cachedInputTokens}) exceeds inputTokens (${usage.inputTokens}); ` +
        "the dashboard total includes the cache, so this is not a valid reading",
    );
  }
  return (
    ceilMicroUsd(usage.inputTokens - usage.cachedInputTokens, price.inputPerMTok) +
    ceilMicroUsd(usage.cachedInputTokens, price.cachedInputPerMTok) +
    ceilMicroUsd(usage.outputTokens, price.outputPerMTok)
  );
}

/**
 * The most a request can cost before it runs: every input token billed at the higher input rate, plus the full
 * output allowance. A reservation is taken at this bound and settled to the real cost afterwards. Because each
 * input token is one or more UTF-8 bytes, a byte count of the serialized prompt is an upper bound on its tokens.
 */
export function reservationBoundMicroUsd(
  inputTokenBound: number,
  maxOutputTokens: number,
  price: TokenPrice,
): MicroUsd {
  assertTokenPrice(price);
  const inputRate = Math.max(price.inputPerMTok, price.cachedInputPerMTok);
  return ceilMicroUsd(inputTokenBound, inputRate) + ceilMicroUsd(maxOutputTokens, price.outputPerMTok);
}

/** Converts micro-dollars to USD for display or for the in-memory BudgetTracker (which is float-based). */
export function microUsdToUsd(amount: MicroUsd): number {
  return amount / MICRO_USD_PER_USD;
}
