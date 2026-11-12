import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_PRICE_CATALOG,
  PriceCatalog,
  PriceCatalogError,
  UnpricedModelError,
  priceVersionId,
  type PriceVersion,
} from "../../src/models/profiles/pricing-catalog.js";

const base = { inputPerMTok: 1_000_000, cachedInputPerMTok: 100_000, outputPerMTok: 2_000_000, source: "test", verified: true };

const OLD: PriceVersion = { ...base, model: "m:cloud", effectiveFrom: "2025-01-01" };
const NEW: PriceVersion = { ...base, model: "m:cloud", effectiveFrom: "2026-01-01", inputPerMTok: 1_500_000 };

describe("PriceCatalog (N-3)", () => {
  it("selects the version in force on the call's UTC day", () => {
    const catalog = new PriceCatalog([NEW, OLD]);

    expect(catalog.priceAt("m:cloud", new Date("2025-06-01T12:00:00Z"))?.effectiveFrom).toBe("2025-01-01");
    expect(catalog.priceAt("m:cloud", new Date("2025-12-31T23:59:59Z"))?.effectiveFrom).toBe("2025-01-01");
    expect(catalog.priceAt("m:cloud", new Date("2026-01-01T00:00:00Z"))?.effectiveFrom).toBe("2026-01-01");
  });

  it("has no price before the first version starts", () => {
    expect(new PriceCatalog([OLD]).priceAt("m:cloud", new Date("2024-12-31T23:59:59Z"))).toBeUndefined();
  });

  it("refuses an unpriced model rather than returning a zero price", () => {
    const catalog = new PriceCatalog([OLD]);
    expect(() => catalog.requirePrice("other:cloud", new Date("2026-01-01T00:00:00Z"))).toThrow(UnpricedModelError);
    try {
      catalog.requirePrice("other:cloud", new Date("2026-01-01T00:00:00Z"));
    } catch (err) {
      expect((err as UnpricedModelError).code).toBe("UNPRICED_MODEL");
    }
  });

  it("gives every price version a stable id, so a reservation can name the price it used", () => {
    expect(priceVersionId(OLD)).toBe("m:cloud@2025-01-01");
  });

  it("rejects an invalid catalogue at construction", () => {
    expect(() => new PriceCatalog([OLD, OLD])).toThrow(PriceCatalogError);
    expect(() => new PriceCatalog([{ ...OLD, effectiveFrom: "2025-13-01" }])).toThrow(PriceCatalogError);
    expect(() => new PriceCatalog([{ ...OLD, effectiveFrom: "yesterday" }])).toThrow(PriceCatalogError);
    expect(() => new PriceCatalog([{ ...OLD, inputPerMTok: 1.5 }])).toThrow(PriceCatalogError);
    expect(() => new PriceCatalog([{ ...OLD, model: " " }])).toThrow(PriceCatalogError);
  });

  it("prices the confirmed cloud model and nothing else", () => {
    expect(DEFAULT_PRICE_CATALOG.has("gpt-oss:120b-cloud")).toBe(true);
    expect(DEFAULT_PRICE_CATALOG.priceAt("gpt-oss:120b-cloud", new Date())).toMatchObject({
      inputPerMTok: 150_000,
      cachedInputPerMTok: 14_000,
      outputPerMTok: 600_000,
      verified: false,
    });
    // A local model never reaches the catalogue; if it did, it is unpriced and refused.
    expect(() => DEFAULT_PRICE_CATALOG.requirePrice("llama3.2", new Date())).toThrow(UnpricedModelError);
  });
});
