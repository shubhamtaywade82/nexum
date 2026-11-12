/**
 * Reconciles the ledger with the provider's own account figures (N-7, N-8).
 *
 * The money truth is the balance. For an included allowance, spend in the cycle is `allowance_usd − balance_usd`;
 * purchased credits add `baseline − current`. Both are read only when the provider's period matches the ledger's
 * cycle, so a stale period is never read as this cycle's spend. `usageAll` is fetched as corroboration and recorded
 * with the result; it is not used for money, because `usage_usd` includes plan-covered usage that was never charged.
 *
 * Holds are released only under a proof that the provider was not charged for them:
 *   provider spend P, ledger settled S (each settled call rounded up by at most 3 µ$), unknown holds U.
 *   - P > S + U        → spend the ledger cannot explain. Cycle flagged OVEREXPOSED; nothing released.
 *   - P ≤ S − 3·n      → no unknown call was charged (n = settled calls). Holds older than the grace period are
 *                        released with PROVIDER_TOTALS_NO_CHARGE evidence.
 *   - otherwise        → some unknown call may have been charged. Holds stay and are noted as unattributed.
 * The grace period exists because a charge can post to the provider's totals after the call returned.
 *
 * A legacy balance (session and weekly percentages, no USD figure) has no USD spend to reconcile. Such an account runs
 * with no USD ceiling, and reconciliation reports PERCENT_MODE without changing any hold.
 */

import type { AccountBalance, AccountUsage } from "../../models/adapters/provider.js";
import { MICRO_USD_PER_USD } from "../cost.js";
import type { BudgetLedger } from "./budget-ledger.js";

export interface ProviderAccountSource {
  usageAll(): Promise<AccountUsage[]>;
  balanceAll(): Promise<AccountBalance[]>;
}

export interface ReconcileOptions {
  ledger: BudgetLedger;
  source: ProviderAccountSource;
  accountId: string;
  /** The provider's label for this account (the pooled key's label). */
  label: string;
  cycleId: string;
  now: Date;
  /** Holds younger than this are not released (see the module comment). */
  graceMs: number;
  /**
   * µ$ of rounding a settled call may over-state. Default 3 (each of three components rounds up by at most 1 µ$).
   * Set to 0 only after the provider's billing is confirmed to match the catalogue formula to the micro-dollar.
   */
  roundingSlackPerCallMicro?: number;
}

export type ReconcileStatus =
  | "RECONCILED"
  | "AWAITING_GRACE"
  | "HELD_UNATTRIBUTED"
  | "OVEREXPOSED"
  | "PERCENT_MODE"
  | "PERIOD_MISMATCH"
  | "INCONSISTENT_BALANCE"
  | "UNAVAILABLE";

export interface ReconcileResult {
  readonly status: ReconcileStatus;
  readonly providerSpendMicro?: number;
  readonly settledMicro?: number;
  readonly unknownMicro?: number;
  readonly releasedReservationIds: readonly string[];
  readonly detail: string;
}

/** Each settled call rounds up its three cost components, so it may over-state its true cost by at most this. */
const ROUNDING_SLACK_PER_CALL_MICRO = 3;

function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO_USD_PER_USD);
}

export async function reconcileAccount(opts: ReconcileOptions): Promise<ReconcileResult> {
  const { ledger, source, accountId, label, cycleId, now, graceMs } = opts;
  const roundingSlack = opts.roundingSlackPerCallMicro ?? ROUNDING_SLACK_PER_CALL_MICRO;
  const unavailable = (detail: string): ReconcileResult => ({
    status: "UNAVAILABLE",
    releasedReservationIds: [],
    detail,
  });

  const [balances, usages] = await Promise.all([
    source.balanceAll().catch((err: unknown) => ({ error: String(err) }) as const),
    source.usageAll().catch(() => [] as AccountUsage[]),
  ]);
  if (!Array.isArray(balances)) return unavailable(`balance query failed: ${balances.error}`);

  const row = balances.find((b) => b.label === label);
  if (!row || !row.balance) {
    return unavailable(row?.error ? `balance for ${label} failed: ${row.error}` : `no balance for account ${label}`);
  }
  const corroboration = usages.find((u) => u.label === label)?.usage?.totals.request_count;
  const requests = corroboration === undefined ? "usage not reported" : `provider requests ${corroboration}`;

  const included = row.balance.included;
  if (!("balance_usd" in included)) {
    return {
      status: "PERCENT_MODE",
      releasedReservationIds: [],
      detail: "legacy session/weekly balance: no USD spend to reconcile; the account runs with no USD ceiling",
    };
  }

  const cycle = ledger.cycle(accountId, cycleId);
  if (!cycle) throw new Error(`cycle ${cycleId} is not open for account ${accountId}`);

  const periodStart = new Date(included.period.from);
  if (Number.isNaN(periodStart.getTime())) {
    return {
      status: "INCONSISTENT_BALANCE",
      releasedReservationIds: [],
      detail: "provider period start is not a date",
    };
  }
  if (periodStart.toISOString().slice(0, 10) !== cycle.startsAt.slice(0, 10)) {
    return {
      status: "PERIOD_MISMATCH",
      releasedReservationIds: [],
      detail: `provider period starts ${periodStart.toISOString().slice(0, 10)}, ledger cycle starts ${cycle.startsAt.slice(0, 10)}`,
    };
  }

  const allowance = usdToMicro(included.allowance_usd);
  const remaining = usdToMicro(included.balance_usd);
  if (!(remaining >= 0 && allowance >= remaining)) {
    return {
      status: "INCONSISTENT_BALANCE",
      releasedReservationIds: [],
      detail: "included balance is outside [0, allowance]",
    };
  }
  const spendIncluded = allowance - remaining;

  const purchasedNow = usdToMicro(row.balance.purchased.balance_usd);
  if (cycle.purchasedBaselineMicro === null) ledger.setPurchasedBaseline(accountId, cycleId, purchasedNow);
  const baseline = cycle.purchasedBaselineMicro ?? purchasedNow;
  if (purchasedNow > baseline) {
    return {
      status: "INCONSISTENT_BALANCE",
      releasedReservationIds: [],
      detail: "purchased credits rose during the cycle (a top-up): spend is not observable from balances",
    };
  }
  const providerSpend = spendIncluded + (baseline - purchasedNow);

  const exposure = ledger.exposure(accountId, cycleId);
  const settled = exposure.settledMicro;
  const unknown = exposure.unknownMicro;
  const holds = ledger.unknownHolds(accountId, cycleId);

  if (providerSpend > settled + unknown) {
    const reason = `provider spend ${providerSpend} exceeds settled ${settled} plus holds ${unknown} (${requests})`;
    ledger.flagOverexposed(accountId, cycleId, reason);
    return {
      status: "OVEREXPOSED",
      providerSpendMicro: providerSpend,
      settledMicro: settled,
      unknownMicro: unknown,
      releasedReservationIds: [],
      detail: reason,
    };
  }

  if (holds.length === 0) {
    return {
      status: "RECONCILED",
      providerSpendMicro: providerSpend,
      settledMicro: settled,
      unknownMicro: unknown,
      releasedReservationIds: [],
      detail: "no unknown holds; provider spend is within the ledger's settled total",
    };
  }

  const slack = roundingSlack * ledger.settledCount(accountId, cycleId);
  if (providerSpend > settled - slack) {
    for (const hold of holds) {
      ledger.note(
        hold.reservationId,
        "RECONCILED",
        `unattributed: provider spend ${providerSpend}, settled ${settled}, holds ${unknown}; hold kept`,
      );
    }
    return {
      status: "HELD_UNATTRIBUTED",
      providerSpendMicro: providerSpend,
      settledMicro: settled,
      unknownMicro: unknown,
      releasedReservationIds: [],
      detail: `provider spend ${providerSpend} cannot rule out a charge for the ${holds.length} unknown call(s)`,
    };
  }

  const cutoff = now.getTime() - graceMs;
  const eligible = holds.filter((h) => Date.parse(h.createdAt) <= cutoff);
  const evidence = JSON.stringify({
    label,
    cycleId,
    providerSpendMicro: providerSpend,
    settledMicro: settled,
    roundingSlackMicro: slack,
    observedAt: now.toISOString(),
    corroboration: requests,
  });
  const released: string[] = [];
  for (const hold of eligible) {
    ledger.release(hold.reservationId, { kind: "PROVIDER_TOTALS_NO_CHARGE", evidence });
    released.push(hold.reservationId);
  }
  const waiting = holds.length - released.length;
  return {
    status: waiting > 0 ? "AWAITING_GRACE" : "RECONCILED",
    providerSpendMicro: providerSpend,
    settledMicro: settled,
    unknownMicro: unknown,
    releasedReservationIds: released,
    detail:
      waiting > 0
        ? `released ${released.length}; ${waiting} hold(s) younger than the grace period`
        : `released ${released.length} hold(s) with no provider charge`,
  };
}
