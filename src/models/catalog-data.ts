/**
 * Model preference DATA (review item 35) — curated model names live in
 * configuration, not in routing code.
 *
 * Sources, in precedence order:
 *   1. environment overrides      NEXUM_MODEL_PREFS_<CAPABILITY>="a,b,c"
 *   2. a preferences file          { "reasoning": ["m1","m2"], ... } (JSON)
 *   3. the shipped defaults        below (the historical curation)
 *
 * The catalog/router only ORDER candidates with these as tie-breakers;
 * primary selection is scored (ScoredModelRouter, review item 17).
 */

import type { Capability } from "./catalog.js";
import { readFileSync } from "node:fs";

/** Historical curation — the shipped default data. */
export const DEFAULT_CURATED_PREFERENCES: Partial<Record<Capability, string[]>> = {
  reasoning: ["qwq", "llama3.3:70b", "hermes3:70b", "qwen3:8b", "qwen3"],
  coding: ["qwen2.5-coder:32b", "qwen2.5-coder:7b", "llama3.3", "qwen3.5", "granite4"],
  agentic: ["hermes3:70b", "llama3.3:70b", "qwq", "qwen3:8b", "llama3.1:70b"],
  tools: ["granite4", "llama3.1:8b", "qwen2.5:7b", "hermes3:8b"],
  quick: ["llama3.2:1b", "qwen2.5:0.5b", "llama3.2:3b", "minicpm5"],
};

export interface ModelPreferenceSource {
  /** Raw env map (process.env or a test double). */
  env?: Record<string, string | undefined>;
  /** Path to a JSON file with { "capability": ["model", ...] }. */
  file?: string;
  /** In-memory overrides (highest precedence besides env). */
  inline?: Partial<Record<Capability, string[]>>;
}

/**
 * Load the effective preference table (review item 35). Failures reading
 * the file are non-fatal — the shipped defaults still apply.
 */
export function loadModelPreferences(source: ModelPreferenceSource = {}): Partial<Record<Capability, string[]>> {
  const merged: Partial<Record<Capability, string[]>> = {
    ...DEFAULT_CURATED_PREFERENCES,
  };

  // file layer
  if (source.file) {
    try {
      // static import — `require()` would be undefined at runtime in the
      // real ESM build and silently fall into the catch below
      const parsed = JSON.parse(readFileSync(source.file, "utf8")) as Record<string, unknown>;
      for (const [cap, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          (merged as Record<string, string[]>)[cap] = value as string[];
        }
      }
    } catch {
      // missing/corrupt file: defaults stand
    }
  }

  // env layer: NEXUM_MODEL_PREFS_REASONING="model-a,model-b"
  const env = source.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^NEXUM_MODEL_PREFS_([A-Z_]+)$/);
    if (!m || !value) continue;
    const cap = m[1].toLowerCase();
    const list = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) {
      (merged as Record<string, string[]>)[cap] = list;
    }
  }

  // inline layer
  if (source.inline) {
    for (const [cap, list] of Object.entries(source.inline)) {
      if (list && list.length > 0) {
        (merged as Record<string, string[]>)[cap] = list;
      }
    }
  }

  return merged;
}
