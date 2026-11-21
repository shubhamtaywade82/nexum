import { describe, it, expect } from "@jest/globals";
import { ModelUsageLedger, type ModelUsageRecord } from "../../src/models/observability/usage-ledger.js";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function rec(partial: Partial<ModelUsageRecord> = {}): Omit<ModelUsageRecord, "id" | "at"> {
  return {
    runId: "run_test",
    purpose: "test",
    lane: "cloud",
    tier: "cloud",
    model: "gemma4",
    tokensUnknown: false,
    costUnknown: false,
    latencyMs: 100,
    retryCount: 0,
    status: "success",
    ...partial,
  };
}

describe("ModelUsageLedger", () => {
  it("records a call and round-trips it through JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-ledger-"));
    const ledger = new ModelUsageLedger({ dir });
    const out = ledger.record(rec({ promptTokens: 120, completionTokens: 30, costUsd: 0.0001, cachedPromptTokens: 5 }));
    expect(out.id).toMatch(/^usage_/);
    expect(out.at).toBeTruthy();

    const text = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    const parsed = JSON.parse(text.trim()) as ModelUsageRecord;
    expect(parsed.model).toBe("gemma4");
    expect(parsed.promptTokens).toBe(120);
    expect(parsed.cachedPromptTokens).toBe(5);
    expect(parsed.costUsd).toBeCloseTo(0.0001, 6);
  });

  it("marks unknown tokens and cost as unknown, not zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-ledger-"));
    const ledger = new ModelUsageLedger({ dir });
    ledger.record(rec({ tokensUnknown: true, costUnknown: true, promptTokens: undefined, costUsd: undefined }));
    const loaded = ledger.loadAll();
    expect(loaded[0].tokensUnknown).toBe(true);
    expect(loaded[0].costUnknown).toBe(true);
    expect(loaded[0].promptTokens).toBeUndefined();
    expect(loaded[0].costUsd).toBeUndefined();
  });

  it("aggregates by model with per-model unknown counts", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    ledger.record(rec({ model: "gemma4", promptTokens: 100, completionTokens: 20, costUsd: 0.001 }));
    ledger.record(
      rec({
        model: "gemma4",
        promptTokens: 50,
        completionTokens: 10,
        costUsd: 0.0005,
        status: "error",
        error: "ProviderError",
      }),
    );
    ledger.record(
      rec({ model: "kimi-k3.1:pro", tier: "cloud", promptTokens: 200, completionTokens: 400, costUsd: 0.0044 }),
    );
    ledger.record(rec({ model: "llama3.2:1b", tier: "local", tokensUnknown: true, costUnknown: true }));

    const agg = ledger.aggregate();
    expect(agg.records).toBe(4);
    expect(agg.success).toBe(3);
    expect(agg.errors).toBe(1);
    expect(agg.tokensUnknown).toBe(1);
    expect(agg.costUnknown).toBe(1);
    expect(agg.totalCostUsd).toBeCloseTo(0.0059, 6);

    const gemma = agg.byModel.find((m) => m.model === "gemma4");
    expect(gemma?.calls).toBe(2);
    expect(gemma?.promptTokens).toBe(150);
    const kimi = agg.byModel.find((m) => m.model === "kimi-k3.1:pro");
    expect(kimi?.costUsd).toBeCloseTo(0.0044, 6);
  });

  it("computes p95 latency over sorted latencies", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    for (let i = 1; i <= 20; i++) {
      ledger.record(rec({ latencyMs: i * 10 }));
    }
    const agg = ledger.aggregate();
    expect(agg.avgLatencyMs).toBe(105);
    expect(agg.p95LatencyMs).toBe(190);
  });

  it("never throws when persistence is broken", () => {
    // dir path that cannot be created (a file in the path)
    const ledger = new ModelUsageLedger({ dir: "/proc/definitely/not/writable" });
    expect(() => ledger.record(rec())).not.toThrow();
    expect(ledger.all()).toHaveLength(1);
  });

  it("loadAll merges disk records with in-memory ones (dedup by id)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-ledger-"));
    const first = new ModelUsageLedger({ dir });
    const written = first.record(rec({ promptTokens: 1 }));
    // new process instance, same dir
    const second = new ModelUsageLedger({ dir });
    second.record(rec({ promptTokens: 2 }));
    const all = second.loadAll();
    expect(all).toHaveLength(2);
    expect(all.some((r) => r.id === written.id)).toBe(true);
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(true);
  });
});
