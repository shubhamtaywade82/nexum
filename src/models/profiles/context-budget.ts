/**
 * ModelBudget — how much context and how many tools one model call should
 * receive, derived from the selected model's profile.
 *
 * The context window is a ceiling, not a target: a 2B model with a 128K
 * window still reasons best over a few thousand relevant tokens and a
 * handful of tool schemas. The ContextCompiler (src/context/compiler.ts)
 * sizes its payload from this budget, so the same world state compiles to a
 * small prompt for the quick tier and a richer one for reasoning/cloud
 * models — without any caller knowing which model was picked.
 */

import type { ModelProfile } from "./model-profile.js";

/** Rough chars-per-token ratio, consistent with compaction/ and skills/. */
export const CHARS_PER_TOKEN = 4;

export type ReasoningBudget = "low" | "medium" | "high";

/** Size class a profile falls into when it carries no explicit budget. */
export type ModelSizeClass = "small" | "standard" | "frontier";

export interface ModelBudget {
  modelId: string;
  sizeClass: ModelSizeClass;
  /** Prompt-side token budget the compiled context must fit into. */
  contextTokens: number;
  /** contextTokens expressed in characters (contextTokens × CHARS_PER_TOKEN). */
  contextChars: number;
  /** Maximum number of tool schemas exposed for one call. */
  toolBudget: number;
  reasoning: ReasoningBudget;
  /** Tokens held back from the window for the model's own output. */
  reserveOutputTokens: number;
}

export interface ModelBudgetOverrides {
  contextTokens?: number;
  toolBudget?: number;
  reasoning?: ReasoningBudget;
}

interface ClassDefaults {
  contextTokens: number;
  toolBudget: number;
  reasoning: ReasoningBudget;
}

export const SIZE_CLASS_DEFAULTS: Readonly<Record<ModelSizeClass, Readonly<ClassDefaults>>> = {
  small: { contextTokens: 8_000, toolBudget: 6, reasoning: "low" },
  standard: { contextTokens: 24_000, toolBudget: 12, reasoning: "medium" },
  frontier: { contextTokens: 48_000, toolBudget: 20, reasoning: "high" },
};

const DEFAULT_RESERVE_OUTPUT_TOKENS = 4_096;
const MIN_CONTEXT_TOKENS = 1_024;
const MIN_TOOL_BUDGET = 1;

/**
 * Classify a profile. Explicit `quick` tagging or a fast latency class means
 * a small resident model; cloud-tier models are treated as frontier; every
 * other local model is standard.
 */
export function sizeClassFor(profile: ModelProfile): ModelSizeClass {
  if (profile.legacyCapabilities.includes("quick") || profile.constraints.latencyClass === "fast") return "small";
  if (profile.tier === "cloud") return "frontier";
  return "standard";
}

function positiveInt(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive number (got ${value})`);
  return Math.floor(value);
}

/**
 * Resolve the budget for one model. Precedence (highest first): explicit
 * overrides → profile constraints (preferredContextTokens / maxToolCount) →
 * size-class defaults. The result is always clamped to the model's real
 * context window minus the output reserve, so a budget can never exceed
 * what the model can physically accept.
 */
export function budgetForProfile(profile: ModelProfile, overrides: ModelBudgetOverrides = {}): ModelBudget {
  const sizeClass = sizeClassFor(profile);
  const defaults = SIZE_CLASS_DEFAULTS[sizeClass];

  const window = positiveInt(profile.constraints.contextWindow, "contextWindow") ?? 0;
  const reserveOutputTokens = Math.min(
    positiveInt(profile.constraints.maxOutputTokens, "maxOutputTokens") ?? DEFAULT_RESERVE_OUTPUT_TOKENS,
    Math.floor(window / 2),
  );
  const ceiling = Math.max(MIN_CONTEXT_TOKENS, window - reserveOutputTokens);

  const requested =
    positiveInt(overrides.contextTokens, "overrides.contextTokens") ??
    positiveInt(profile.constraints.preferredContextTokens, "preferredContextTokens") ??
    defaults.contextTokens;
  const contextTokens = Math.max(MIN_CONTEXT_TOKENS, Math.min(requested, ceiling));

  const toolBudget = Math.max(
    MIN_TOOL_BUDGET,
    positiveInt(overrides.toolBudget, "overrides.toolBudget") ??
      positiveInt(profile.constraints.maxToolCount, "maxToolCount") ??
      defaults.toolBudget,
  );

  return {
    modelId: profile.id,
    sizeClass,
    contextTokens,
    contextChars: contextTokens * CHARS_PER_TOKEN,
    toolBudget,
    reasoning: overrides.reasoning ?? defaults.reasoning,
    reserveOutputTokens,
  };
}
