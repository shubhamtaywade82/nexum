/**
 * ScoredModelRouter (review item 17) — capability tags evolved into scored
 * profiles routed by dimension.
 *
 * Every candidate ModelProfile is scored across the nine dimensions
 * (reasoning, coding, tool calling, vision, structured output, context
 * capacity, latency, cost, availability) with per-capability weight
 * vectors, then hard constraints (min context, max latency class, max
 * cost, min tool calling) filter before ranking. Unknown scores (-1)
 * contribute a neutral 0.5 with a "unknown dimension" reason rather than
 * silently zeroing a candidate.
 *
 * Ordering replaces curated name matching: a qwq with a higher reasoning
 * score beats a lower-scored model regardless of what the names look
 * like. Curated preferences (item 35) now live in config data and only
 * act as tie-breakers, never as the primary signal.
 */

import type { ModelProfile } from "../profiles/model-profile.js";
import { ModelCapabilityRegistry } from "../profiles/model-capability-registry.js";
import { DEFAULT_PRICE_CATALOG, type PriceCatalog } from "../profiles/pricing-catalog.js";
import { costFromDisjointCounts, microUsdToUsd } from "../../economics/cost.js";
import {
  CAPABILITY_WEIGHTS,
  ModelRouter,
  ModelSelection,
  RouteConstraints,
  RouteRequest,
  RoutingDimension,
  SelectionReason,
} from "./model-selection.js";

const LATENCY_CLASS_SCORE: Record<string, number> = { fast: 1, balanced: 0.6, medium: 0.6, slow: 0.3, unknown: 0.4 };
const LATENCY_CLASS_ORDER: Record<string, number> = { fast: 0, balanced: 1, medium: 1, slow: 2, unknown: 2 };
const UNKNOWN_NEUTRAL = 0.5;

export interface ScoredRouterOptions {
  registry: ModelCapabilityRegistry;
  /** Availability map (model name → 0..1); missing = unknown (0.5). */
  availability?: (model: string) => number | undefined;
  /** Local-first flat bonus (default 0.05). */
  localBonus?: number;
  /** Price source for cost estimates. Defaults to the shared catalogue. */
  prices?: PriceCatalog;
}

export class ScoredModelRouter implements ModelRouter {
  private readonly registry: ModelCapabilityRegistry;
  private readonly availabilityFn: (model: string) => number | undefined;
  private readonly localBonus: number;
  private readonly prices: PriceCatalog;

  constructor(opts: ScoredRouterOptions) {
    this.registry = opts.registry;
    this.prices = opts.prices ?? DEFAULT_PRICE_CATALOG;
    this.availabilityFn = opts.availability ?? (() => undefined);
    this.localBonus = opts.localBonus ?? 0.05;
  }

  private estimatePerCallUsd(modelId: string): number | undefined {
    return estimatePerCallCostUsd(modelId, this.prices, new Date());
  }

  select(request: RouteRequest): ModelSelection[] {
    const weights = this.resolveWeights(request);
    const constraints = request.constraints ?? {};
    const tier = request.preferences?.tier;
    const localFirst = request.preferences?.localFirst ?? true;

    const candidates = this.registry
      .all()
      .filter((p) => (tier ? p.tier === tier : true))
      .filter((p) => this.passesConstraints(p, constraints));

    const scored: ModelSelection[] = candidates.map((profile) => {
      const { score, reasons } = this.scoreProfile(profile, weights);
      const adjusted = score + (localFirst && profile.tier === "local" ? this.localBonus : 0);
      return {
        model: profile.id,
        tier: profile.tier,
        score: Math.max(0, Math.min(1, Math.round(adjusted * 1e4) / 1e4)),
        reasons,
        estimatedCostUsd: this.estimatePerCallUsd(profile.id),
        profile,
      };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  private resolveWeights(request: RouteRequest): Record<RoutingDimension, number> {
    const base: Record<RoutingDimension, number> = {
      reasoning: 0.2,
      coding: 0.15,
      toolCalling: 0.1,
      vision: 0.05,
      structuredOutput: 0.1,
      contextCapacity: 0.15,
      latency: 0.15,
      cost: 0.05,
      availability: 0.05,
    };
    const tagged = request.capability ? CAPABILITY_WEIGHTS[request.capability] : undefined;
    const merged = { ...base, ...(tagged ?? {}), ...(request.preferences?.weights ?? {}) };
    return merged;
  }

  private passesConstraints(profile: ModelProfile, c: RouteConstraints): boolean {
    if (c.minContextTokens !== undefined && profile.constraints.contextWindow < c.minContextTokens) {
      return false;
    }
    if (c.maxLatencyClass !== undefined) {
      const modelClass = LATENCY_CLASS_ORDER[profile.constraints.latencyClass] ?? 2;
      const limit = LATENCY_CLASS_ORDER[c.maxLatencyClass] ?? LATENCY_CLASS_ORDER[c.maxLatencyClass.toLowerCase()] ?? 2;
      if (modelClass > limit) return false;
    }
    if (c.minToolCalling !== undefined) {
      const t = profile.capabilities.toolCalling;
      if (t >= 0 && t < c.minToolCalling) return false;
    }
    if (c.maxCostUsd !== undefined) {
      const estimate = this.estimatePerCallUsd(profile.id);
      if (estimate !== undefined && estimate > c.maxCostUsd) return false;
    }
    return true;
  }

  private scoreProfile(
    profile: ModelProfile,
    weights: Record<RoutingDimension, number>,
  ): { score: number; reasons: SelectionReason[] } {
    const reasons: SelectionReason[] = [];
    let total = 0;
    let weightSum = 0;

    const dimensionValue = (dim: RoutingDimension): number => {
      switch (dim) {
        case "reasoning":
          return profile.capabilities.reasoning;
        case "coding":
          return profile.capabilities.coding;
        case "toolCalling":
          return profile.capabilities.toolCalling;
        case "vision":
          return profile.capabilities.vision;
        case "structuredOutput":
          return profile.capabilities.structuredOutput;
        case "contextCapacity":
          // log scale: 8k → 0.33, 128k → 0.67, 1M → 0.83
          return Math.min(1, Math.log10(Math.max(1024, profile.constraints.contextWindow)) / 6);
        case "latency":
          return LATENCY_CLASS_SCORE[profile.constraints.latencyClass] ?? 0.3;
        case "cost": {
          const perCall = this.estimatePerCallUsd(profile.id);
          if (perCall === undefined) return UNKNOWN_NEUTRAL;
          // cheaper is better: $0.001 → ~0.95, $0.10 → ~0.2, $1 → 0
          return Math.max(0, 1 - Math.log10(Math.max(0.001, perCall) * 1000) / 3);
        }
        case "availability": {
          const known = this.availabilityFn(profile.id);
          return known === undefined ? UNKNOWN_NEUTRAL : known;
        }
      }
    };

    for (const dim of Object.keys(weights) as RoutingDimension[]) {
      const weight = weights[dim];
      if (weight <= 0) continue;
      const raw = dimensionValue(dim);
      const normalized = raw < 0 ? UNKNOWN_NEUTRAL : raw; // -1 = unknown
      total += weight * normalized;
      weightSum += weight;
      reasons.push({
        dimension: dim,
        weight,
        score: Math.round(normalized * 1e3) / 1e3,
        note: raw < 0 ? "unknown — neutral" : "profiled",
      });
    }

    const score = weightSum > 0 ? total / weightSum : 0;
    return { score, reasons };
  }
}

/** Assumed size of one agentic turn for routing estimates: about 2k prompt tokens and 400 completion tokens. */
export const TYPICAL_TURN = { promptTokens: 2_000, completionTokens: 400 } as const;

/**
 * Estimated USD cost of one typical turn, priced by the catalogue version in force at `at`. Undefined for an unpriced
 * model, which includes every local model. The estimate assumes no cache hits, so it is an upper bound.
 */
export function estimatePerCallCostUsd(modelId: string, prices: PriceCatalog, at: Date): number | undefined {
  const version = prices.priceAt(modelId, at);
  if (!version) return undefined;
  return microUsdToUsd(
    costFromDisjointCounts(
      { promptTokens: TYPICAL_TURN.promptTokens, cachedPromptTokens: 0, completionTokens: TYPICAL_TURN.completionTokens },
      version,
    ),
  );
}
