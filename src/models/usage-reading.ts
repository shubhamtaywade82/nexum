/**
 * What one provider response says about the tokens it consumed, and whether the provider said it at all.
 *
 * A missing counter is `MISSING`, never zero. Zero is a claim ("this call cost nothing"); a provider that
 * omitted its counters has made no such claim. Accounting that turns absence into zero lets a metered call
 * disappear from the budget, so callers must carry the source along and count the unknowns.
 */

export type UsageSource = "PROVIDER" | "MISSING";

export interface UsageReading {
  readonly source: UsageSource;
  /** Prompt tokens freshly evaluated this request (Ollama `prompt_eval_count`). Excludes cache hits. */
  readonly promptTokens?: number;
  /** Prompt tokens served from the KV prompt cache (`prompt_eval_cached_count`). Disjoint from promptTokens. */
  readonly cachedPromptTokens?: number;
  /** Completion tokens generated (Ollama `eval_count`). */
  readonly completionTokens?: number;
}

/** The budget tracker's input for one reading. MISSING carries no invented counts. */
export interface BudgetUsageInput {
  promptTokens?: number;
  completionTokens?: number;
  usageSource: UsageSource;
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reads Ollama's token counters off a response. `PROVIDER` only when both the prompt and the completion
 * counts were reported; a reading with either one missing is `MISSING`, and the counts that did arrive are
 * kept as reported.
 */
export function readUsage(response: unknown): UsageReading {
  const fields = (response ?? {}) as Record<string, unknown>;
  const promptTokens = countOf(fields.prompt_eval_count);
  const completionTokens = countOf(fields.eval_count);
  const cachedPromptTokens = countOf(fields.prompt_eval_cached_count);
  const source: UsageSource = promptTokens !== undefined && completionTokens !== undefined ? "PROVIDER" : "MISSING";
  return { source, promptTokens, completionTokens, cachedPromptTokens };
}

/** Maps a reading onto the budget tracker's `consumeModelCall` input. */
export function budgetUsageOf(reading: UsageReading): BudgetUsageInput {
  return {
    promptTokens: reading.promptTokens,
    completionTokens: reading.completionTokens,
    usageSource: reading.source,
  };
}
