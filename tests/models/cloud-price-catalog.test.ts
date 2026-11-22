import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_CLOUD_PRICES,
  loadPriceTable,
  priceFor,
  estimateCallCostUsd,
  PRICE_FILE_ENV,
} from "../../src/models/profiles/cloud-price-catalog.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cloud price catalog", () => {
  it("has a price for every entry with positive rates", () => {
    for (const [model, price] of Object.entries(DEFAULT_CLOUD_PRICES)) {
      expect(price.inputPerMillion).toBeGreaterThan(0);
      expect(price.outputPerMillion).toBeGreaterThan(0);
      expect(typeof model).toBe("string");
    }
  });

  it("matches exact ids case-insensitively", () => {
    const table = loadPriceTable({});
    expect(priceFor(table, "GLM-5.3")).toBeDefined();
    expect(priceFor(table, "gemma4")).toBeDefined();
  });

  it("falls back to the base name before ':'", () => {
    const table = loadPriceTable({});
    // "gpt-oss:20b" has its own exact entry; a NEW size variant with no entry
    // resolves through the base name "gpt-oss" -> matches "gpt-oss:20b"? No —
    // the fallback strips to "gpt-oss", and the table keys on full ids. What
    // actually resolves: an unlisted variant of a family whose BASE name is
    // itself a table key.
    expect(priceFor(table, "gemma4:some-new-variant")).toEqual(priceFor(table, "gemma4"));
    expect(priceFor(table, "deepseek-v4-pro:0813")).toEqual(priceFor(table, "deepseek-v4-pro"));
    // exact match still wins over the fallback
    expect(priceFor(table, "gpt-oss:20b")).toEqual({ inputPerMillion: 0.07, outputPerMillion: 0.3 });
    // a base name with no entry and no family entry stays unknown
    expect(priceFor(table, "not-a-family")).toBeUndefined();
  });

  it("returns undefined for an unknown model — never a zero price", () => {
    const table = loadPriceTable({});
    expect(priceFor(table, "totally-unknown-model")).toBeUndefined();
    expect(estimateCallCostUsd(table, "totally-unknown-model", 1000, 1000)).toBeUndefined();
  });

  it("computes per-million cost from both counts", () => {
    const table = loadPriceTable({});
    // gemma4: $0.14/M in, $0.40/M out
    const cost = estimateCallCostUsd(table, "gemma4", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.54, 6);
  });

  it("treats zero tokens as a real zero cost, not unknown", () => {
    const table = loadPriceTable({});
    expect(estimateCallCostUsd(table, "gemma4", 0, 0)).toBe(0);
  });

  it("layers a user price file over the curated table", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-price-"));
    const file = join(dir, "prices.json");
    writeFileSync(file, JSON.stringify({ gemma4: { input: 0.2, output: 0.5 }, "my-private": { input: 1, output: 2 } }));
    const table = loadPriceTable({ [PRICE_FILE_ENV]: file });
    expect(priceFor(table, "gemma4")).toEqual({ inputPerMillion: 0.2, outputPerMillion: 0.5 });
    expect(priceFor(table, "my-private")).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
    // untouched entries survive
    expect(priceFor(table, "glm-5.3")).toBeDefined();
  });

  it("ignores a corrupt price file (curated defaults stand)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-price-"));
    const file = join(dir, "broken.json");
    writeFileSync(file, "{not json");
    const table = loadPriceTable({ [PRICE_FILE_ENV]: file });
    expect(table.size).toBe(Object.keys(DEFAULT_CLOUD_PRICES).length);
  });
});
