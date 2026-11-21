/**
 * MonthlySpendGuard — cross-session monthly spend ceiling (review: budget
 * guardrails).
 *
 * The per-run `maxCostUsd` ceiling dies with the run. This guard answers a
 * different question: "how much has Nexum spent on cloud-tier calls THIS
 * calendar month, across every session and run?" It reads the persisted
 * usage ledger (~/.nexum/usage/ledger.jsonl), so it survives restarts.
 *
 * Policy (defaults match the team's stated guardrails):
 *   - monthlyBudgetUsd: total cloud spend allowed per calendar month
 *     (default $48 — NEXUM_MONTHLY_BUDGET_USD / monthlyBudgetUsd in config);
 *   - reserveUsd: credit kept in reserve for manual/emergency use, i.e. the
 *     guard blocks automated calls once spent >= budget - reserve
 *     (default $12 — NEXUM_RESERVE_USD / reserveUsd);
 *   - the guard is advisory at the CLI layer (a hard error would brick the
 *     tool when the ledger over-reports) but hard at the dispatcher's
 *     admission: a refused call never reaches the provider.
 *
 * Costs in the ledger are catalog estimates, not billing; unknown-cost calls
 * are counted as their worst case (see usage-ledger costUnknown). When the
 * ledger has no records for the month, spend is 0 — a fresh install is
 * never blocked.
 */

import type { ModelUsageLedger, ModelUsageRecord } from "./usage-ledger.js";

export interface MonthlySpendOptions {
  /** Ledger whose persisted records are the spend source of truth. */
  ledger: ModelUsageLedger;
  /** Total allowed cloud spend per calendar month (USD). Default 48. */
  monthlyBudgetUsd?: number;
  /** Credit held back from automated spend (USD). Default 12. */
  reserveUsd?: number;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Worst-case USD charged to a call whose cost is unknown. Default 0.01. */
  unknownCostAssumptionUsd?: number;
}

export interface SpendSnapshot {
  /** Calendar month key the snapshot covers ("YYYY-MM"). */
  month: string;
  /** Estimated cloud spend so far this month (USD, ledger catalog estimates). */
  spentUsd: number;
  /** Spend at which the guard refuses new automated cloud calls. */
  blockAtUsd: number;
  /** Spend remaining before the block (may be negative if already past). */
  remainingUsd: number;
  /** True when spentUsd >= blockAtUsd — new automated cloud calls are refused. */
  blocked: boolean;
  /** Cloud calls counted this month. */
  calls: number;
}

/** Calendar-month key of an ISO timestamp (UTC) — the ledger's clock. */
export function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

export class MonthlySpendGuard {
  private readonly ledger: ModelUsageLedger;
  private readonly monthlyBudgetUsd: number;
  private readonly reserveUsd: number;
  private readonly now: () => Date;
  private readonly unknownCostAssumptionUsd: number;

  constructor(opts: MonthlySpendOptions) {
    this.ledger = opts.ledger;
    this.monthlyBudgetUsd = opts.monthlyBudgetUsd ?? 48;
    this.reserveUsd = opts.reserveUsd ?? 12;
    this.now = opts.now ?? (() => new Date());
    this.unknownCostAssumptionUsd = opts.unknownCostAssumptionUsd ?? 0.01;
    if (this.reserveUsd < 0 || this.reserveUsd > this.monthlyBudgetUsd) {
      // A reserve larger than the budget would block everything before the
      // first call; clamp instead of bricking the tool.
      this.reserveUsd = Math.max(0, Math.min(this.reserveUsd, this.monthlyBudgetUsd));
    }
  }

  /** Spend snapshot for the current calendar month. */
  snapshot(): SpendSnapshot {
    const month = monthKeyOf(this.now().toISOString());
    const records = this.ledger.loadAll().filter((r) => r.tier === "cloud" && monthKeyOf(r.at) === month);
    let spent = 0;
    for (const r of records) {
      spent += this.costOf(r);
    }
    // Round to micro-dollars so float noise never crosses the threshold by itself.
    const spentUsd = Math.round(spent * 1e6) / 1e6;
    const blockAtUsd = Math.max(0, this.monthlyBudgetUsd - this.reserveUsd);
    const remainingUsd = Math.round((blockAtUsd - spentUsd) * 1e6) / 1e6;
    return {
      month,
      spentUsd,
      blockAtUsd,
      remainingUsd,
      blocked: spentUsd >= blockAtUsd && blockAtUsd > 0,
      calls: records.length,
    };
  }

  /** True when a new automated cloud call must be refused (spend floor hit). */
  shouldBlock(): boolean {
    return this.snapshot().blocked;
  }

  /** Ledger cost of a record, with the worst-case assumption for unknowns. */
  private costOf(r: ModelUsageRecord): number {
    if (r.costUsd !== undefined) return r.costUsd;
    if (r.costUnknown) return this.unknownCostAssumptionUsd;
    return 0;
  }
}
