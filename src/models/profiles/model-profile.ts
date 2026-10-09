/**
 * ModelProfile — the rich metadata contract for models, promoting the flat
 * Capability enum from provider/catalog.ts into a queryable registry shape
 * (review recommendation §3):
 *
 *   capability enum  →  numeric capability scores + constraints + cost
 *
 * The registry is the source the ModelGateway routes from; the legacy
 * ModelCatalog stays the discovery transport (it talks to Ollama) and the
 * registry adapts its ModelInfo into profiles until richer metadata is
 * available per provider.
 */

import { Capability, ModelInfo } from "../catalog.js";
import type { Tier } from "../adapters/provider.js";

export interface ModelCapabilities {
  /** 0..1 qualitative scores; -1 means "unknown" (no metadata yet). */
  reasoning: number;
  coding: number;
  vision: number;
  /** 0..1 score (-1 unknown) — evolved from a boolean so scored routing
   *  (review item 17) can rank models by tool-calling fit. */
  toolCalling: number;
  /** 0..1 score (-1 unknown) — structured-output fit. */
  structuredOutput: number;
  streaming: boolean;
}

export interface ModelConstraints {
  contextWindow: number;
  maxOutputTokens?: number;
  /** "fast" | "medium" | "slow" | "unknown" */
  latencyClass: string;
  /**
   * Prompt tokens this model should normally receive — below contextWindow
   * for models that degrade on long prompts. Read by budgetForProfile();
   * unset means the size-class default (see context-budget.ts).
   */
  preferredContextTokens?: number;
  /** Maximum tool schemas to expose per call; unset means the size-class default. */
  maxToolCount?: number;
}

export interface ModelCost {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export interface ModelProfile {
  id: string;
  provider: string;
  tier: Tier;
  capabilities: ModelCapabilities;
  constraints: ModelConstraints;
  cost?: ModelCost;
  /** Legacy enum tags preserved for Router compatibility during migration. */
  legacyCapabilities: Capability[];
}

export const UNKNOWN_SCORE = -1;

export function defaultConstraints(overrides?: Partial<ModelConstraints>): ModelConstraints {
  return {
    contextWindow: overrides?.contextWindow ?? 128_000,
    maxOutputTokens: overrides?.maxOutputTokens,
    latencyClass: overrides?.latencyClass ?? "unknown",
    ...(overrides?.preferredContextTokens !== undefined
      ? { preferredContextTokens: overrides.preferredContextTokens }
      : {}),
    ...(overrides?.maxToolCount !== undefined ? { maxToolCount: overrides.maxToolCount } : {}),
  };
}

function scoreFor(legacy: Capability[], target: Capability): number {
  // No per-model scoring metadata exists yet in the transport layer; the
  // registry records presence (1) / absence (0) and leaves refinement to
  // future provider metadata. Embedding-only models get 0 everywhere.
  return legacy.includes(target) ? 1 : 0;
}

/** Adapt a legacy ModelInfo (from provider/catalog.ts) into a profile. */
export function profileFromLegacy(info: ModelInfo, provider = "ollama"): ModelProfile {
  return {
    id: info.name,
    provider,
    tier: info.tier,
    capabilities: {
      reasoning: scoreFor(info.capabilities, "reasoning"),
      coding: scoreFor(info.capabilities, "coding"),
      vision: scoreFor(info.capabilities, "vision"),
      toolCalling: scoreFor(info.capabilities, "tools"),
      structuredOutput: scoreFor(info.capabilities, "tools") > 0 ? 0.5 : 0,
      streaming: true,
    },
    constraints: defaultConstraints({ latencyClass: info.capabilities.includes("quick") ? "fast" : "unknown" }),
    legacyCapabilities: info.capabilities,
  };
}
