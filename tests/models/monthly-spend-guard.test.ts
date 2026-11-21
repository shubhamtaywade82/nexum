import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { ModelUsageLedger, type ModelUsageRecord } from "../../src/models/observability/usage-ledger.js";
import { MonthlySpendGuard, monthKeyOf } from "../../src/models/observability/monthly-spend-guard.js";

/** Minimal record builder — only the fields the guard reads. */
function rec(partial: Partial<ModelUsageRecord>): ModelUsageRecord {
  return {
    id: `usage_${Math.random().toString(36).slice(2)}`,
    runId: "run_test",
    purpose: "chat.primary",
    lane: "primary",
    tier: "cloud",
    model: "gemma4",
    tokensUnknown: false,
    costUnknown: false,
    latencyMs: 10,
    retryCount: 0,
    status: "success",
    at: new Date().toISOString(),
    ...partial,
  };
}

describe("monthKeyOf", () => {
  it("extracts the YYYY-MM prefix", () => {
    expect(monthKeyOf("2026-11-21T03:47:00.000Z")).toBe("2026-11");
  });
});

describe("MonthlySpendGuard", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-spend-guard-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks once month-to-date cloud spend crosses budget - reserve", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    // $36 spent; default budget 48 - reserve 12 = block at 36.
    ledger.record(rec({ costUsd: 36 }));
    const guard = new MonthlySpendGuard({ ledger });
    const snap = guard.snapshot();
    expect(snap.blocked).toBe(true);
    expect(snap.blockAtUsd).toBe(36);
    expect(snap.spentUsd).toBeCloseTo(36, 6);
    expect(snap.remainingUsd).toBeCloseTo(0, 6);
    expect(guard.shouldBlock()).toBe(true);
  });

  it("does not block below the threshold", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    ledger.record(rec({ costUsd: 35.999 }));
    const guard = new MonthlySpendGuard({ ledger });
    expect(guard.shouldBlock()).toBe(false);
    expect(guard.snapshot().remainingUsd).toBeCloseTo(0.001, 6);
  });

  it("counts only this month's cloud-tier records (persisted from a previous session)", () => {
    // A ledger file from an earlier process, with last month's spend, this
    // month's spend, and a local-tier record that must not count.
    mkdirSync(dir, { recursive: true });
    const earlier = [
      rec({ costUsd: 100, at: "2026-10-05T00:00:00.000Z" }), // last month — ignored
      rec({ costUsd: 10, at: "2026-11-01T00:00:00.000Z" }), // this month
      rec({ costUsd: 500, tier: "local", at: "2026-11-02T00:00:00.000Z" }), // local — ignored
    ];
    writeFileSync(join(dir, "ledger.jsonl"), earlier.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const ledger = new ModelUsageLedger({ dir, persist: true });
    const guard = new MonthlySpendGuard({ ledger, now: () => new Date("2026-11-21T12:00:00.000Z") });
    const snap = guard.snapshot();
    expect(snap.month).toBe("2026-11");
    expect(snap.spentUsd).toBeCloseTo(10, 6);
    expect(snap.calls).toBe(1);
    expect(snap.blocked).toBe(false);
  });

  it("charges the worst-case assumption for unknown-cost calls", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    // 3600 unknown-cost calls at the default $0.01 assumption = $36 → blocked.
    for (let i = 0; i < 3600; i++) {
      ledger.record(rec({ costUsd: undefined, costUnknown: true }));
    }
    const guard = new MonthlySpendGuard({ ledger });
    expect(guard.snapshot().spentUsd).toBeCloseTo(36, 6);
    expect(guard.shouldBlock()).toBe(true);
  });

  it("reserve 0 disables the reserve (blocks only at the full budget)", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    ledger.record(rec({ costUsd: 40 }));
    const guard = new MonthlySpendGuard({ ledger, reserveUsd: 0 });
    // Budget 48, no reserve: block at 48, not 36.
    expect(guard.shouldBlock()).toBe(false);
    ledger.record(rec({ costUsd: 8 })); // total 48
    expect(guard.shouldBlock()).toBe(true);
  });

  it("clamps a reserve larger than the budget instead of blocking everything", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    const guard = new MonthlySpendGuard({ ledger, monthlyBudgetUsd: 10, reserveUsd: 99 });
    // Clamped to 10 → block at 0... but a fresh install must still not block on
    // an empty ledger when the budget equals the reserve after clamping.
    // blockAtUsd = max(0, 10 - 10) = 0 → blocked only when blockAtUsd > 0 per
    // the snapshot rule, i.e. an all-reserve budget never blocks (documented).
    const snap = guard.snapshot();
    expect(snap.blockAtUsd).toBe(0);
    expect(snap.blocked).toBe(false);
  });

  it("a fresh ledger with no records is never blocked", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    const guard = new MonthlySpendGuard({ ledger });
    const snap = guard.snapshot();
    expect(snap.spentUsd).toBe(0);
    expect(snap.calls).toBe(0);
    expect(snap.blocked).toBe(false);
  });

  it("float noise cannot cross the threshold by itself (micro-dollar rounding)", () => {
    const ledger = new ModelUsageLedger({ persist: false });
    // 0.1 + 0.2 style noise: 240 * 0.15 = 35.99999999999999 must not read as 36.
    for (let i = 0; i < 240; i++) {
      ledger.record(rec({ costUsd: 0.15 }));
    }
    const guard = new MonthlySpendGuard({ ledger });
    const snap = guard.snapshot();
    expect(snap.spentUsd).toBeCloseTo(36, 6);
    expect(snap.blocked).toBe(true); // exactly at the threshold IS blocked (>=)
  });
});
