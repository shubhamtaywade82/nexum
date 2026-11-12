import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { BudgetLedger } from "../../src/economics/ledger/budget-ledger.js";
import { LedgerCloudAdmission } from "../../src/economics/cloud-admission.js";
import { DEFAULT_PRICE_CATALOG } from "../../src/models/profiles/pricing-catalog.js";

const DOLLAR = 1_000_000;
let ledger: BudgetLedger | undefined;
afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

function setup(now: () => Date) {
  ledger = new BudgetLedger({ path: ":memory:", clock: now });
  const admission = new LedgerCloudAdmission({
    ledger,
    prices: DEFAULT_PRICE_CATALOG,
    accountId: "acct",
    monthlyCapMicro: 46 * DOLLAR,
    clock: now,
  });
  return admission;
}

function source(balanceUsd: number, purchased = 0) {
  return {
    balanceAll: jest.fn(async () => [
      {
        label: "only",
        balance: {
          included: {
            balance_usd: balanceUsd,
            allowance_usd: 46,
            period: { from: "2026-06-01T00:00:00Z", until: "2026-07-01T00:00:00Z" },
          },
          purchased: { balance_usd: purchased },
        },
      },
    ]) as never,
    usageAll: jest.fn(async () => []) as never,
  };
}

describe("admission reconciles its own cycle (N-7)", () => {
  it("makes no provider call when no unknown outcome is waiting", async () => {
    const admission = setup(() => new Date("2026-06-10T12:00:00Z"));
    const src = source(46);
    expect(admission.hasUnknownHolds()).toBe(false);
    expect(await admission.reconcile(src)).toBeUndefined();
    expect(src.balanceAll).not.toHaveBeenCalled();
  });

  it("releases a held call once the grace period has passed and the provider shows no charge", async () => {
    let now = new Date("2026-06-10T12:00:00Z");
    const admission = setup(() => now);
    const lease = admission.admit({
      purpose: "t",
      taskId: "t",
      model: "gpt-oss:120b-cloud",
      messages: [{ role: "user", content: "hi" }],
    });
    if (lease.kind !== "ADMITTED") throw new Error("setup refused");
    admission.markUnknown(lease.lease, "timed out after dispatch");
    expect(admission.hasUnknownHolds()).toBe(true);

    // Within the grace period the hold stays, even though the provider shows no charge.
    const early = await admission.reconcile(source(46));
    expect(early?.status).toBe("AWAITING_GRACE");

    now = new Date("2026-06-10T13:00:00Z");
    const later = await admission.reconcile(source(46));
    expect(later?.status).toBe("RECONCILED");
    expect(later?.releasedReservationIds).toEqual([lease.lease.reservationId]);
    expect(admission.hasUnknownHolds()).toBe(false);
  });

  it("reports the provider's failure and changes nothing", async () => {
    const admission = setup(() => new Date("2026-06-10T12:00:00Z"));
    const lease = admission.admit({
      purpose: "t",
      taskId: "t",
      model: "gpt-oss:120b-cloud",
      messages: [{ role: "user", content: "hi" }],
    });
    if (lease.kind !== "ADMITTED") throw new Error("setup refused");
    admission.markUnknown(lease.lease, "timeout");
    const failing = {
      balanceAll: async () => {
        throw new Error("offline");
      },
      usageAll: async () => [],
    } as never;
    expect((await admission.reconcile(failing))?.status).toBe("UNAVAILABLE");
    expect(admission.hasUnknownHolds()).toBe(true);
  });

  it("finds the one account of a single-account source without a label", async () => {
    const admission = setup(() => new Date("2026-06-10T12:00:00Z"));
    const lease = admission.admit({
      purpose: "t",
      taskId: "t",
      model: "gpt-oss:120b-cloud",
      messages: [{ role: "user", content: "hi" }],
    });
    if (lease.kind !== "ADMITTED") throw new Error("setup refused");
    admission.markUnknown(lease.lease, "timeout");
    // Inside the grace period: the single account is found and the hold waits. It is not reported unavailable.
    expect((await admission.reconcile(source(46)))?.status).toBe("AWAITING_GRACE");
  });
});
