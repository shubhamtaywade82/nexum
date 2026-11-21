import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

/** Full record of one model invocation for the audit ledger. */
export interface ModelUsageRecord {
  runId: string;
  taskId: string;
  provider: string;
  model: string;
  inputTokens: number | "unknown";
  cachedInputTokens: number | "unknown";
  outputTokens: number | "unknown";
  estimatedCostUsd: number | "unknown";
  latencyMs: number;
  retryCount: number;
  status: "success" | "failure";
  timestamp: string;
  error?: string;
}

/** Standard published pricing rates in USD per million tokens. */
export const STANDARD_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  gemma4: { input: 0.14, output: 0.4 },
  "deepseek-v4.1": { input: 0.3, output: 1.2 },
  "glm-5.3": { input: 1.4, output: 4.4 },
  "kimi-k2.7": { input: 0.95, output: 4.0 },
  "gpt-oss": { input: 0.15, output: 0.6 },
  "kimi-k3.1-pro": { input: 2.0, output: 10.0 },
  beam: { input: 0.15, output: 0.6 },
};

/** Resolves per-token pricing with zero cost for local executions. */
export function resolveModelPricing(
  model: string,
  tier?: string,
  custom?: Record<string, { input: number; output: number }>,
): { input: number; output: number } | undefined {
  if (tier === "local") return { input: 0, output: 0 };
  if (custom?.[model]) return custom[model];
  const base = model.toLowerCase().split(":")[0];
  if (custom?.[base]) return custom[base];
  for (const [key, price] of Object.entries(STANDARD_MODEL_PRICING)) {
    if (base.includes(key)) return price;
  }
  return undefined;
}

/** Calculates estimated cost, returning unknown if counters or pricing are absent. */
export function calculateCostUsd(
  pricing: { input: number; output: number } | undefined,
  inputTokens?: number,
  outputTokens?: number,
): number | "unknown" {
  if (!pricing || inputTokens === undefined || outputTokens === undefined) return "unknown";
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return Math.round(cost * 1e6) / 1e6;
}

/** In-memory and persisted ledger of all model calls. */
export class ModelUsageLedger {
  private readonly records: ModelUsageRecord[] = [];
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.load();
  }

  record(entry: ModelUsageRecord): void {
    this.records.push(entry);
    this.persist();
  }

  forRun(runId: string): ModelUsageRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  aggregateForRun(runId: string): {
    runId: string;
    totalCostUsd: number;
    hasUnknownCosts: boolean;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
    failedCalls: number;
  } {
    const list = this.forRun(runId);
    let totalCostUsd = 0;
    let hasUnknownCosts = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let failedCalls = 0;

    for (const r of list) {
      if (typeof r.estimatedCostUsd === "number") totalCostUsd += r.estimatedCostUsd;
      else hasUnknownCosts = true;
      if (typeof r.inputTokens === "number") totalInputTokens += r.inputTokens;
      if (typeof r.outputTokens === "number") totalOutputTokens += r.outputTokens;
      if (r.status === "failure") failedCalls++;
    }

    return {
      runId,
      totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
      hasUnknownCosts,
      totalInputTokens,
      totalOutputTokens,
      totalCalls: list.length,
      failedCalls,
    };
  }

  all(): ModelUsageRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
    this.persist();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) this.records.push(...parsed);
    } catch {
      // Ignore corrupted ledger file on boot
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), "utf8");
    } catch {
      // Ignore disk persistence failures
    }
  }
}

export const globalModelLedger = new ModelUsageLedger();

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
