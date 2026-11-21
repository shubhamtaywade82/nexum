/**
 * Cloud price catalog (measurement-infrastructure item 1).
 *
 * The dispatcher's recordModelCall() only estimates a cost when the model's
 * profile carries `cost` — and profileFromLegacy() never sets it, so every
 * cloud call's costUsd is undefined, maxCostUsd / maxCloudSpendUsd can never
 * fire, and the ledger records "unknown" forever. This module is the data
 * source that fixes that: a curated per-model price table for Ollama Cloud,
 * layered with a user-configurable file so rates can be corrected without a
 * release.
 *
 * Prices are USD per million tokens, matching Ollama Cloud's published
 * per-model rates (input / output). They are ESTIMATES used for internal
 * budget enforcement and reporting, not billing claims — the account's own
 * /api/usage and /api/balance remain the source of truth for what was
 * actually charged.
 *
 * Lookup precedence (most specific wins):
 *   1. exact model id            ("gpt-oss:120b")
 *   2. base name before ":"      ("gpt-oss:120b-cloud" -> "gpt-oss")
 *   3. case-insensitive variants of the above
 */

import { readFileSync } from "node:fs";

export interface ModelPrice {
  /** USD per million input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per million output (completion) tokens. */
  outputPerMillion: number;
}

/** Shape of the user-supplied price file (see PRICE_FILE_ENV). */
export interface PriceFile {
  [model: string]: { input: number; output: number } | ModelPrice;
}

/** Env var pointing at a JSON price file overriding/extending the catalog. */
export const PRICE_FILE_ENV = "NEXUM_PRICE_FILE";

/**
 * Curated Ollama Cloud standard rates (USD / 1M tokens), 2026-11 snapshot.
 * A model missing from this table has no estimate — unknown, never zero.
 */
export const DEFAULT_CLOUD_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // ── inexpensive tier ──
  gemma4: { inputPerMillion: 0.14, outputPerMillion: 0.4 },
  "gemma4:cloud": { inputPerMillion: 0.14, outputPerMillion: 0.4 },
  "gpt-oss:20b": { inputPerMillion: 0.08, outputPerMillion: 0.28 },
  "gpt-oss:120b": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-oss:120b-cloud": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "deepseek-v4.1:flash": { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  minicpm5: { inputPerMillion: 0.05, outputPerMillion: 0.18 },
  "minicpm5:2b": { inputPerMillion: 0.05, outputPerMillion: 0.18 },

  // ── mid tier ──
  "qwen3.5:32b": { inputPerMillion: 0.4, outputPerMillion: 1.4 },
  "kimi-k2.7:code": { inputPerMillion: 0.95, outputPerMillion: 4.0 },
  granite4: { inputPerMillion: 0.45, outputPerMillion: 1.6 },

  // ── premium tier ──
  "glm5.3": { inputPerMillion: 1.4, outputPerMillion: 4.4 },
  "glm5.3:cloud": { inputPerMillion: 1.4, outputPerMillion: 4.4 },
  "kimi-k3.1:pro": { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  qwq: { inputPerMillion: 1.2, outputPerMillion: 4.0 },
});

/** Case-insensitive index over the merged table, built once per lookup batch. */
function normalizeKey(model: string): string {
  return model.trim().toLowerCase();
}

/** Base name before the first ":" — "gpt-oss:120b-cloud" -> "gpt-oss". */
function baseName(model: string): string {
  const idx = model.indexOf(":");
  return idx > 0 ? model.slice(0, idx) : model;
}

function asPrice(value: unknown): ModelPrice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const input = typeof v.input === "number" ? v.input : v.inputPerMillion;
  const output = typeof v.output === "number" ? v.output : v.outputPerMillion;
  if (typeof input !== "number" || typeof output !== "number" || input < 0 || output < 0) return undefined;
  return { inputPerMillion: input, outputPerMillion: output };
}

/**
 * The price table with the user file layered on top. Never throws: a missing
 * or corrupt file means the curated defaults stand (same failure posture as
 * loadModelPreferences).
 */
export function loadPriceTable(env: NodeJS.ProcessEnv = process.env): Map<string, ModelPrice> {
  const merged = new Map<string, ModelPrice>();
  for (const [model, price] of Object.entries(DEFAULT_CLOUD_PRICES)) {
    merged.set(normalizeKey(model), { ...price });
  }
  const file = env[PRICE_FILE_ENV];
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PriceFile;
      for (const [model, value] of Object.entries(parsed)) {
        const price = asPrice(value);
        if (price) merged.set(normalizeKey(model), price);
      }
    } catch {
      // missing/corrupt price file: curated defaults stand
    }
  }
  return merged;
}

/**
 * Price for one model id, or undefined when unknown. Matches the exact id,
 * then the base name before ":" (so ":cloud" and size variants inherit the
 * family rate), both case-insensitively.
 */
export function priceFor(table: Map<string, ModelPrice>, model: string): ModelPrice | undefined {
  const exact = table.get(normalizeKey(model));
  if (exact) return exact;
  return table.get(normalizeKey(baseName(model)));
}

/**
 * USD cost of one call. undefined when the model has no price entry — the
 * caller must treat that as "unknown", never $0 (see usage-reading.ts).
 */
export function estimateCallCostUsd(
  table: Map<string, ModelPrice>,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const price = priceFor(table, model);
  if (!price) return undefined;
  const cost =
    (Math.max(0, promptTokens) / 1_000_000) * price.inputPerMillion +
    (Math.max(0, completionTokens) / 1_000_000) * price.outputPerMillion;
  return Math.round(cost * 1e6) / 1e6;
}
