/**
 * Versioned cloud prices, looked up by model and effective date.
 *
 * A price is data, not code: each version carries the day it starts to apply, and a call is priced by the version
 * in force when it is admitted. A later price change never re-prices an earlier call, because the ledger stores the
 * version id with each reservation (see the ledger, N-5). A cloud model with no version is unpriced, and an unpriced
 * cloud call is refused before it is sent. Local models are not priced and never reach this catalogue.
 *
 * Prices are integer micro-dollars per million tokens. The default catalogue holds only the models whose identifier
 * is confirmed in this repository. Adding a model means adding a version here with its source; it is never inferred
 * from a display name.
 */

import { AgentRuntimeError } from "../errors.js";
import { assertTokenPrice, type TokenPrice } from "../../economics/cost.js";

export interface PriceVersion extends TokenPrice {
  /** Exact model identifier as routed, e.g. "gpt-oss:120b-cloud". */
  readonly model: string;
  /** First UTC day the price applies, YYYY-MM-DD. "1970-01-01" means the start day is not known. */
  readonly effectiveFrom: string;
  /** Where the number came from. Shown in reports. */
  readonly source: string;
  /** False when the figure has not been checked against the provider's pricing page. Enforcement still applies. */
  readonly verified: boolean;
}

export class UnpricedModelError extends AgentRuntimeError {
  constructor(public readonly model: string) {
    super(`cloud model "${model}" has no price in effect; the call is refused`, "UNPRICED_MODEL");
  }
}

export class PriceCatalogError extends AgentRuntimeError {
  constructor(message: string) {
    super(message, "INVALID_PRICE_CATALOG");
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function priceVersionId(version: Pick<PriceVersion, "model" | "effectiveFrom">): string {
  return `${version.model}@${version.effectiveFrom}`;
}

export class PriceCatalog {
  private readonly byModel = new Map<string, PriceVersion[]>();

  constructor(versions: readonly PriceVersion[]) {
    const seen = new Set<string>();
    for (const version of versions) {
      if (version.model.trim() === "") throw new PriceCatalogError("price version has an empty model id");
      if (!DATE_PATTERN.test(version.effectiveFrom) || Number.isNaN(Date.parse(`${version.effectiveFrom}T00:00:00Z`))) {
        throw new PriceCatalogError(`"${version.effectiveFrom}" is not a valid effectiveFrom date for ${version.model}`);
      }
      try {
        assertTokenPrice(version);
      } catch (err) {
        throw new PriceCatalogError(`${priceVersionId(version)}: ${(err as Error).message}`);
      }
      const id = priceVersionId(version);
      if (seen.has(id)) throw new PriceCatalogError(`duplicate price version ${id}`);
      seen.add(id);
      const list = this.byModel.get(version.model) ?? [];
      list.push(version);
      this.byModel.set(version.model, list);
    }
    for (const list of this.byModel.values()) {
      list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
    }
  }

  has(model: string): boolean {
    return this.byModel.has(model);
  }

  /** The version in force at `at` (UTC day), or undefined when the model has no version that has started yet. */
  priceAt(model: string, at: Date): PriceVersion | undefined {
    const day = at.toISOString().slice(0, 10);
    const list = this.byModel.get(model);
    if (!list) return undefined;
    let found: PriceVersion | undefined;
    for (const version of list) {
      if (version.effectiveFrom <= day) found = version;
    }
    return found;
  }

  /** As priceAt, but an unpriced model throws, so a caller cannot continue without a price. */
  requirePrice(model: string, at: Date): PriceVersion {
    const version = this.priceAt(model, at);
    if (!version) throw new UnpricedModelError(model);
    return version;
  }
}

/**
 * Prices from the budget plan document (`source` below). Unverified: the figures are the plan's, not read from the
 * provider's pricing page today. Enforcement uses them as given; a report marks the cost as unverified.
 */
export const PLAN_PRICE_SOURCE = "budget plan document (unverified against provider pricing page)";

export const DEFAULT_PRICE_CATALOG = new PriceCatalog([
  {
    model: "gpt-oss:120b-cloud",
    effectiveFrom: "1970-01-01",
    inputPerMTok: 150_000, // $0.15 / M
    cachedInputPerMTok: 14_000, // $0.014 / M
    outputPerMTok: 600_000, // $0.60 / M
    source: PLAN_PRICE_SOURCE,
    verified: false,
  },
]);
