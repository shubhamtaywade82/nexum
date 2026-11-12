import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger, type ReserveRequest } from "../../src/economics/ledger/budget-ledger.js";
import { reconcileAccount, type ProviderAccountSource } from "../../src/economics/ledger/reconcile.js";

const ACCOUNT = "acct-1";
const LABEL = "key-a";
const CYCLE = "2026-06";
const DOLLAR = 1_000_000;
const CAP = 46 * DOLLAR;
const GRACE_MS = 15 * 60 * 1000;
const CREATED = new Date("2026-06-02T00:00:00Z");

let dir: string;
let ledgers: BudgetLedger[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-reconcile-"));
  ledgers = [];
});

afterEach(() => {
  for (const l of ledgers) l.close();
  rmSync(dir, { recursive: true, force: true });
});

function newLedger(capMicro: number | null = CAP): BudgetLedger {
  const ledger = new BudgetLedger({ path: ":memory:", clock: () => CREATED });
  ledgers.push(ledger);
  ledger.openCycle({ accountId: ACCOUNT, cycleId: CYCLE, startsAt: "2026-06-01", endsAt: "2026-07-01", capMicro });
  return ledger;
}

function req(key: string, bound: number): ReserveRequest {
  return {
    accountId: ACCOUNT,
    cycleId: CYCLE,
    idempotencyKey: key,
    payloadHash: `h-${key}`,
    taskId: "t",
    model: "gpt-oss:120b-cloud",
    priceVersionId: "gpt-oss:120b-cloud@1970-01-01",
    boundMicro: bound,
  };
}

/** One settled call of exactly `settled` µ$ and one unknown call of `unknown` µ$ (bound). */
function seed(ledger: BudgetLedger, settled: number, unknown: number): { unknownId?: string } {
  const s = ledger.reserve(req("settled", settled));
  if (s.kind !== "ADMITTED") throw new Error("seed refused");
  ledger.settle(s.reservationId, settled);
  if (unknown === 0) return {};
  const u = ledger.reserve(req("unknown", unknown));
  if (u.kind !== "ADMITTED") throw new Error("seed refused");
  ledger.markUnknown(u.reservationId, "timeout");
  return { unknownId: u.reservationId };
}

function included(balanceUsd: number, allowanceUsd = 46, from = "2026-06-01T00:00:00Z") {
  return {
    balance_usd: balanceUsd,
    allowance_usd: allowanceUsd,
    period: { from, until: "2026-07-01T00:00:00Z" },
  };
}

function balanceOf(includedBalance: unknown, purchasedUsd = 0) {
  return { included: includedBalance, purchased: { balance_usd: purchasedUsd } };
}

function source(balance: unknown, opts: { balanceFails?: boolean } = {}): ProviderAccountSource {
  return {
    balanceAll: async () => {
      if (opts.balanceFails) throw new Error("network down");
      return [{ label: LABEL, balance }] as never;
    },
    usageAll: async () => [{ label: LABEL, usage: { totals: { request_count: 7 } } }] as never,
  };
}

const LATER = new Date("2026-06-02T01:00:00Z");
const SOON = new Date("2026-06-02T00:05:00Z");

describe("reconciliation of unknown holds (N-7)", () => {
  it("releases a hold once the provider's spend shows it was not charged, after the grace period", async () => {
    const ledger = newLedger();
    const { unknownId } = seed(ledger, 3 * DOLLAR, 2 * DOLLAR);
    // Spend 2,999,997 µ$: exactly the settled total less the 3 µ$ rounding allowance for its one settled call.
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(43.000003))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });

    expect(result).toMatchObject({ status: "RECONCILED", providerSpendMicro: 2_999_997, releasedReservationIds: [unknownId] });
    expect(ledger.get(unknownId!)).toMatchObject({ state: "RELEASED" });
    expect(ledger.get(unknownId!)?.releaseProof).toContain("PROVIDER_TOTALS_NO_CHARGE");
  });

  it("does not release a hold younger than the grace period, since its charge may not have posted", async () => {
    const ledger = newLedger();
    const { unknownId } = seed(ledger, 3 * DOLLAR, 2 * DOLLAR);
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(43.000003))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: SOON,
      graceMs: GRACE_MS,
    });

    expect(result).toMatchObject({ status: "AWAITING_GRACE", releasedReservationIds: [] });
    expect(ledger.get(unknownId!)?.state).toBe("UNKNOWN_USAGE");
  });

  it("keeps every hold when provider spend equals the settled total: a charge cannot be ruled out", async () => {
    const ledger = newLedger();
    const { unknownId } = seed(ledger, 3 * DOLLAR, 2 * DOLLAR);
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(43))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });

    expect(result).toMatchObject({ status: "HELD_UNATTRIBUTED", providerSpendMicro: 3 * DOLLAR });
    expect(ledger.get(unknownId!)?.state).toBe("UNKNOWN_USAGE");
    expect(ledger.events(unknownId!).map((e) => e.kind)).toContain("RECONCILED");
  });

  it("flags the cycle overexposed when provider spend exceeds everything the ledger holds, and then blocks paid calls", async () => {
    const ledger = newLedger();
    seed(ledger, 3 * DOLLAR, 2 * DOLLAR);
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(40))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });

    expect(result).toMatchObject({ status: "OVEREXPOSED", providerSpendMicro: 6 * DOLLAR });
    expect(ledger.cycle(ACCOUNT, CYCLE)?.overexposed).toBe(true);
    expect(ledger.cycle(ACCOUNT, CYCLE)?.overexposedReason).toContain("exceeds settled");
    expect(ledger.reserve(req("after", 10_000))).toMatchObject({ kind: "REJECTED", reason: "CYCLE_OVEREXPOSED" });
  });

  it("reconciles with no holds: spend inside the settled total changes nothing", async () => {
    const ledger = newLedger();
    seed(ledger, 1 * DOLLAR, 0);
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(45))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(result).toMatchObject({ status: "RECONCILED", releasedReservationIds: [] });
  });

  it("uses purchased credits as spend once the included allowance is not the source", async () => {
    const ledger = newLedger();
    seed(ledger, 1 * DOLLAR, 0);
    // First reconciliation fixes the purchased baseline at $5. A later reading of $4 means $1 was spent from it.
    const first = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(46), 5)),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(first.status).toBe("RECONCILED");
    expect(ledger.cycle(ACCOUNT, CYCLE)?.purchasedBaselineMicro).toBe(5 * DOLLAR);
    const second = await reconcileAccount({
      ledger,
      source: { balanceAll: async () => [{ label: LABEL, balance: balanceOf(included(46), 4) }] as never, usageAll: async () => [] },
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(second).toMatchObject({ status: "RECONCILED", providerSpendMicro: 1 * DOLLAR });
  });

  it("refuses to infer spend when purchased credits rose mid-cycle (a top-up)", async () => {
    const ledger = newLedger();
    seed(ledger, 1 * DOLLAR, 0);
    const first = { balanceAll: async () => [{ label: LABEL, balance: balanceOf(included(46), 5) }] as never, usageAll: async () => [] };
    const topUp = { balanceAll: async () => [{ label: LABEL, balance: balanceOf(included(46), 6) }] as never, usageAll: async () => [] };
    await reconcileAccount({ ledger, source: first, accountId: ACCOUNT, label: LABEL, cycleId: CYCLE, now: LATER, graceMs: GRACE_MS });
    const result = await reconcileAccount({ ledger, source: topUp, accountId: ACCOUNT, label: LABEL, cycleId: CYCLE, now: LATER, graceMs: GRACE_MS });
    expect(result.status).toBe("INCONSISTENT_BALANCE");
  });

  it("refuses a balance whose remaining amount is outside [0, allowance]", async () => {
    const ledger = newLedger();
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(50, 46))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(result.status).toBe("INCONSISTENT_BALANCE");
  });

  it("does not read a provider period from another cycle as this cycle's spend", async () => {
    const ledger = newLedger();
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(included(40, 46, "2026-05-01T00:00:00Z"))),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(result.status).toBe("PERIOD_MISMATCH");
    expect(ledger.cycle(ACCOUNT, CYCLE)?.overexposed).toBe(false);
    expect(ledger.cycle(ACCOUNT, CYCLE)?.purchasedBaselineMicro).toBeNull();
  });

  it("runs a legacy percentage balance with no USD ceiling and changes no hold", async () => {
    const ledger = newLedger(null);
    const legacy = {
      session: { remaining_percent: 80, resets_at: "2026-06-02T05:00:00Z" },
      weekly: { remaining_percent: 60, resets_at: "2026-06-08T00:00:00Z" },
    };
    const result = await reconcileAccount({
      ledger,
      source: source(balanceOf(legacy)),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(result.status).toBe("PERCENT_MODE");
    // No USD ceiling: a $100 request is admitted where a $46 cycle would refuse it.
    expect(ledger.reserve(req("big", 100 * DOLLAR))).toMatchObject({ kind: "ADMITTED" });
  });

  it("reports UNAVAILABLE and changes nothing when the provider cannot be asked", async () => {
    const ledger = newLedger();
    const { unknownId } = seed(ledger, 3 * DOLLAR, 2 * DOLLAR);
    const result = await reconcileAccount({
      ledger,
      source: source(undefined, { balanceFails: true }),
      accountId: ACCOUNT,
      label: LABEL,
      cycleId: CYCLE,
      now: LATER,
      graceMs: GRACE_MS,
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(ledger.get(unknownId!)?.state).toBe("UNKNOWN_USAGE");
  });

  it("keeps the default rounding allowance unless configured: exact spend releases only with slack 0", async () => {
    const ledger = newLedger();
    const { unknownId } = seed(ledger, 3 * DOLLAR, 2 * DOLLAR);
    const common = { ledger, source: source(balanceOf(included(43))), accountId: ACCOUNT, label: LABEL, cycleId: CYCLE, now: LATER, graceMs: GRACE_MS };

    // Spend equals the settled total exactly. With the default 3 µ$ allowance a charge cannot be ruled out.
    const byDefault = await reconcileAccount(common);
    expect(byDefault.status).toBe("HELD_UNATTRIBUTED");
    expect(ledger.get(unknownId!)?.state).toBe("UNKNOWN_USAGE");

    // Only an operator who has confirmed the provider's billing matches the catalogue sets the allowance to 0.
    const configured = await reconcileAccount({ ...common, roundingSlackPerCallMicro: 0 });
    expect(configured.status).toBe("RECONCILED");
    expect(ledger.get(unknownId!)?.state).toBe("RELEASED");
  });
});
