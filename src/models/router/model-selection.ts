/**
 * ModelSelection + ModelRouter (review item 18) — selection separated from
 * transport.
 *
 *   ModelRouter            scored selection over capability profiles (item 17)
 *      ↓
 *   ModelSelection          chosen model + tier + score + reasons + estimate
 *      ↓
 *   ProviderAdapter         transport that executes the call (Ollama local/cloud)
 *
 * The legacy `Router` (models/router/router.ts) remains as the
 * failover-executing engine; it now consults the scored router for
 * candidate ordering. The DefaultModelGateway composes router+catalog and
 * speaks ModelSelection to callers.
 */

import type { ChatMessage, ChatOptions, ChatResponse, Tier } from "../adapters/provider.js";
import type { ModelProfile } from "../profiles/model-profile.js";

// ── ProviderAdapter (transport port, review item 18) ────────────────────────

/**
 * The transport contract. Provider (Ollama local/cloud) implements it;
 * tests and alternative stacks implement it too. Selection never touches
 * transport internals; transport never decides routing.
 */
export interface ProviderAdapter {
  readonly tier: Tier;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
  availableModels(): Promise<unknown>;
}

// ── ModelSelection ──────────────────────────────────────────────────────────

/** Why a model was chosen — surfaced to callers and persisted for audits. */
export interface SelectionReason {
  dimension: string;
  weight: number;
  score: number;
  note: string;
}

export interface ModelSelection {
  model: string;
  tier: Tier;
  /** 0..1 aggregate score (higher = better fit). */
  score: number;
  reasons: SelectionReason[];
  /** Estimated per-call cost in USD when profiled. */
  estimatedCostUsd?: number;
  /** Profile the decision was made from (when known). */
  profile?: ModelProfile;
}

// ── Route request (scored dimensions, review item 17) ───────────────────────

/** The nine routing dimensions (review item 17). */
export type RoutingDimension =
  | "reasoning"
  | "coding"
  | "toolCalling"
  | "vision"
  | "structuredOutput"
  | "contextCapacity"
  | "latency"
  | "cost"
  | "availability";

export interface RouteConstraints {
  /** Minimum context window in tokens. */
  minContextTokens?: number;
  /** Reject models slower than this latency class. */
  maxLatencyClass?: "fast" | "balanced" | "slow";
  /** Reject models estimated above this per-call cost (USD). */
  maxCostUsd?: number;
  /** Tool calling must be at least this score. */
  minToolCalling?: number;
}

export interface RoutePreferences {
  /** Local models get a flat bonus (data locality / privacy / cost). */
  localFirst?: boolean;
  /** Tier override ("local" or "cloud" only). */
  tier?: Tier;
  /** Dimension weights; defaults activate by capability tag. */
  weights?: Partial<Record<RoutingDimension, number>>;
}

export interface RouteRequest {
  /** Legacy capability tag ("coding", "reasoning", ...) → default weights. */
  capability?: string;
  constraints?: RouteConstraints;
  preferences?: RoutePreferences;
}

export interface ModelRouter {
  select(request: RouteRequest): ModelSelection[];
}

/** Default weight vectors per capability tag (review item 17). */
export const CAPABILITY_WEIGHTS: Record<string, Partial<Record<RoutingDimension, number>>> = {
  reasoning: { reasoning: 0.4, contextCapacity: 0.2, latency: 0.1, availability: 0.2, cost: 0.1 },
  coding: { coding: 0.4, contextCapacity: 0.25, latency: 0.1, availability: 0.15, cost: 0.1 },
  agentic: { toolCalling: 0.35, reasoning: 0.3, contextCapacity: 0.15, availability: 0.1, latency: 0.05, cost: 0.05 },
  tools: { toolCalling: 0.5, latency: 0.2, availability: 0.2, cost: 0.1 },
  vision: { vision: 0.6, reasoning: 0.15, latency: 0.1, availability: 0.15 },
  quick: { latency: 0.5, cost: 0.25, availability: 0.25 },
  structured: { structuredOutput: 0.5, reasoning: 0.2, availability: 0.15, latency: 0.15 },
  // Judging needs reliable structured output (strict JSON verdicts) and
  // reasoning (rubric application) more than raw speed.
  judge: { structuredOutput: 0.4, reasoning: 0.35, availability: 0.15, cost: 0.1 },
};
