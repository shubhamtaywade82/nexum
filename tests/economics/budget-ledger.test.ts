import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetLedger,
  LedgerStateError,
  isNoExecutionProof,
  type ReserveRequest,
} from "../../src/economics/ledger/budget-ledger.js";

// Money in micro-dollars: $1 = 1,000,000. The plan's ceiling is $46.
const CAP = 46_000_000;
const DOLLAR = 1_000_000;
const PRICE_VERSION = "gpt-oss:120b-cloud@1970-01-01";
const ACCOUNT = "acct-1";
const CYCLE = "2026-06";

let dir: string;
let fileLedgers: BudgetLedger[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-ledger-"));
  fileLedgers = [];
});

afterEach(() => {
  for (const l of fileLedgers) l.close();
  rmSync(dir, { recursive: true, force: true });
});

function openLedger(path = ":memory:", clock?: () => Date): BudgetLedger {
  const ledger = new BudgetLedger({ path, clock: clock ?? (() => new Date("2026-06-10T12:00:00Z")) });
  ledger.openCycle({ accountId: ACCOUNT, cycleId: CYCLE, startsAt: "2026-06-01", endsAt: "2026-07-01", capMicro: CAP });
  return ledger;
}

function request(over: Partial<ReserveRequest> & { key: string; bound: number }): ReserveRequest {
  const { key, bound, ...rest } = over;
  return {
    accountId: ACCOUNT,
    cycleId: CYCLE,
    idempotencyKey: key,
    payloadHash: `hash-${key}`,
    taskId: "task",
    model: "gpt-oss:120b-cloud",
    priceVersionId: PRICE_VERSION,
    boundMicro: bound,
    ...rest,
  };
}

describe("budget invariant tests (plan section 11.3)", () => {
  it("Test A: five simultaneous $3 reservations against $10 admit at most three and never exceed $9", () => {
    const path = join(dir, "ledger.sqlite");
    const setup = new BudgetLedger({ path });
    fileLedgers.push(setup);
    setup.openCycle({ accountId: ACCOUNT, cycleId: CYCLE, startsAt: "2026-06-01", endsAt: "2026-07-01", capMicro: 10 * DOLLAR });

    // Five connections, each a separate process-style client of the same file. BEGIN IMMEDIATE serialises them.
    const clients = Array.from({ length: 5 }, () => new BudgetLedger({ path }));
    fileLedgers.push(...clients);
    const outcomes = clients.map((client, i) => client.reserve(request({ key: `k${i}`, bound: 3 * DOLLAR })));

    const admitted = outcomes.filter((o) => o.kind === "ADMITTED");
    expect(admitted).toHaveLength(3);
    expect(outcomes.filter((o) => o.kind === "REJECTED")).toHaveLength(2);
    const exposure = setup.exposure(ACCOUNT, CYCLE);
    expect(exposure.totalMicro).toBeLessThanOrEqual(9 * DOLLAR);
    expect(exposure.totalMicro).toBe(9 * DOLLAR);
  });

  it("Test B: with $44 settled and $2 available, $1.50 and $1.00 requests admit exactly one", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const seed = ledger.reserve(request({ key: "seed", bound: 44 * DOLLAR }));
    if (seed.kind !== "ADMITTED") throw new Error("seed refused");
    ledger.settle(seed.reservationId, 44 * DOLLAR);

    const a = ledger.reserve(request({ key: "a", bound: 1_500_000 }));
    const b = ledger.reserve(request({ key: "b", bound: 1_000_000 }));

    expect([a.kind, b.kind].sort()).toEqual(["ADMITTED", "REJECTED"]);
    const rejected = [a, b].find((o) => o.kind === "REJECTED");
    expect(rejected).toMatchObject({ kind: "REJECTED", reason: "BUDGET_EXCEEDED" });
  });

  it("Test C: a settlement over its estimate is recorded truthfully; within headroom it is not flagged", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const big = ledger.reserve(request({ key: "big", bound: 44 * DOLLAR }));
    if (big.kind !== "ADMITTED") throw new Error("setup refused");
    ledger.settle(big.reservationId, 44 * DOLLAR);
    const small = ledger.reserve(request({ key: "small", bound: 1 * DOLLAR }));
    if (small.kind !== "ADMITTED") throw new Error("setup refused");

    const settled = ledger.settle(small.reservationId, 1_200_000);

    // 44 + 1.20 = 45.20 ≤ 46: the extra $0.20 fits within the ceiling.
    expect(settled.overexposedNow).toBe(false);
    expect(ledger.get(small.reservationId)).toMatchObject({ state: "SETTLED", settledMicro: 1_200_000 });
  });

  it("Test C (cont.): a settlement that cannot be covered is recorded as spent, flags the cycle, and blocks new paid calls", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const base = ledger.reserve(request({ key: "base", bound: 45 * DOLLAR }));
    if (base.kind !== "ADMITTED") throw new Error("setup refused");
    ledger.settle(base.reservationId, 45 * DOLLAR);
    const one = ledger.reserve(request({ key: "one", bound: 1 * DOLLAR }));
    if (one.kind !== "ADMITTED") throw new Error("setup refused");

    // Actual $1.20 against a $1 bound with 45 already settled: 46.20 > 46.
    const settled = ledger.settle(one.reservationId, 1_200_000);

    expect(settled.overexposedNow).toBe(true);
    expect(ledger.get(one.reservationId)?.settledMicro).toBe(1_200_000); // true cost kept, not falsified
    expect(ledger.exposure(ACCOUNT, CYCLE).overexposed).toBe(true);
    expect(ledger.reserve(request({ key: "next", bound: 10_000 }))).toMatchObject({
      kind: "REJECTED",
      reason: "CYCLE_OVEREXPOSED",
    });
  });

  it("Test D: an ambiguous timeout keeps the hold, and the same key cannot be sent again", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const first = ledger.reserve(request({ key: "d", bound: 2 * DOLLAR }));
    if (first.kind !== "ADMITTED") throw new Error("setup refused");

    ledger.markUnknown(first.reservationId, "post-dispatch timeout");

    expect(ledger.get(first.reservationId)?.state).toBe("UNKNOWN_USAGE");
    expect(ledger.exposure(ACCOUNT, CYCLE).unknownMicro).toBe(2 * DOLLAR);
    expect(ledger.reserve(request({ key: "d", bound: 2 * DOLLAR }))).toMatchObject({ kind: "IN_FLIGHT" });
    expect(() =>
      ledger.release(first.reservationId, { kind: "HTTP_STATUS", status: 500 as unknown as 429 }),
    ).toThrow(LedgerStateError);
  });

  it("Test E: a cycle rollover keeps old requests in the old cycle and erases no history", () => {
    const path = join(dir, "rollover.sqlite");
    const ledger = new BudgetLedger({ path, clock: () => new Date("2026-05-20T00:00:00Z") });
    fileLedgers.push(ledger);
    ledger.openCycle({ accountId: ACCOUNT, cycleId: "2026-05", startsAt: "2026-05-01", endsAt: "2026-06-01", capMicro: CAP });
    const reserved = ledger.reserve(request({ key: "r", bound: 3 * DOLLAR, cycleId: "2026-05" }));
    const settledRes = ledger.reserve(request({ key: "s", bound: 2 * DOLLAR, cycleId: "2026-05" }));
    const unknownRes = ledger.reserve(request({ key: "u", bound: 4 * DOLLAR, cycleId: "2026-05" }));
    if (settledRes.kind !== "ADMITTED" || unknownRes.kind !== "ADMITTED" || reserved.kind !== "ADMITTED") {
      throw new Error("setup refused");
    }
    ledger.settle(settledRes.reservationId, 2 * DOLLAR);
    ledger.markUnknown(unknownRes.reservationId, "timeout");
    const before = ledger.reservationsOf(ACCOUNT).length;

    ledger.openCycle({ accountId: ACCOUNT, cycleId: "2026-06", startsAt: "2026-06-01", endsAt: "2026-07-01", capMicro: CAP });

    expect(ledger.reservationsOf(ACCOUNT)).toHaveLength(before);
    expect(ledger.get(settledRes.reservationId)).toMatchObject({ cycleId: "2026-05", state: "SETTLED" });
    // The reserved $3 and the unknown $4 carry into June as held money: 7 of 46 is already committed.
    expect(ledger.exposure(ACCOUNT, "2026-06").carryoverMicro).toBe(7 * DOLLAR);
    expect(ledger.reserve(request({ key: "j-over", bound: 40 * DOLLAR, cycleId: "2026-06" }))).toMatchObject({
      kind: "REJECTED",
      reason: "BUDGET_EXCEEDED",
    });
    expect(ledger.reserve(request({ key: "j-fit", bound: 39 * DOLLAR, cycleId: "2026-06" })).kind).toBe("ADMITTED");
  });
});

describe("reservation state machine (N-5, N-6)", () => {
  it("admits at most the cloud concurrency limit across processes sharing the ledger", () => {
    const path = join(dir, "concurrency.sqlite");
    const a = new BudgetLedger({ path, maxCloudConcurrency: 2 });
    const b = new BudgetLedger({ path, maxCloudConcurrency: 2 });
    fileLedgers.push(a, b);
    a.openCycle({ accountId: ACCOUNT, cycleId: CYCLE, startsAt: "2026-06-01", endsAt: "2026-07-01", capMicro: CAP });

    expect(a.reserve(request({ key: "1", bound: DOLLAR })).kind).toBe("ADMITTED");
    expect(b.reserve(request({ key: "2", bound: DOLLAR })).kind).toBe("ADMITTED");
    expect(a.reserve(request({ key: "3", bound: DOLLAR }))).toMatchObject({ kind: "REJECTED", reason: "CLOUD_CONCURRENCY" });
  });

  it("replays a completed request with the same key and payload, and never executes it twice", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const first = ledger.reserve(request({ key: "same", bound: DOLLAR }));
    if (first.kind !== "ADMITTED") throw new Error("setup refused");
    ledger.settle(first.reservationId, 500_000);

    const again = ledger.reserve(request({ key: "same", bound: DOLLAR }));
    expect(again).toMatchObject({ kind: "REPLAY", reservation: { reservationId: first.reservationId, state: "SETTLED" } });
    expect(ledger.reservationsOf(ACCOUNT)).toHaveLength(1);
  });

  it("refuses the same key with a different payload", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    ledger.reserve(request({ key: "k", bound: DOLLAR }));
    expect(ledger.reserve(request({ key: "k", bound: DOLLAR, payloadHash: "other" }))).toMatchObject({
      kind: "PAYLOAD_MISMATCH",
    });
  });

  it("refuses a request into a cycle that was never opened", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    expect(ledger.reserve(request({ key: "x", bound: DOLLAR, cycleId: "2099-01" }))).toMatchObject({
      kind: "REJECTED",
      reason: "CYCLE_NOT_OPEN",
    });
  });

  it("refuses to change the cap of an open cycle", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    expect(() =>
      ledger.openCycle({ accountId: ACCOUNT, cycleId: CYCLE, startsAt: "2026-06-01", endsAt: "2026-07-01", capMicro: 99 * DOLLAR }),
    ).toThrow(LedgerStateError);
  });

  it("releases a hold only with proof the provider did not execute the request", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const r = ledger.reserve(request({ key: "p", bound: DOLLAR }));
    if (r.kind !== "ADMITTED") throw new Error("setup refused");
    expect(() => ledger.release(r.reservationId, { kind: "HTTP_STATUS", status: 500 as unknown as 429 })).toThrow(LedgerStateError);
    expect(ledger.get(r.reservationId)?.state).toBe("RESERVED");

    ledger.release(r.reservationId, { kind: "HTTP_STATUS", status: 429 });
    expect(ledger.get(r.reservationId)).toMatchObject({ state: "RELEASED" });
    expect(ledger.exposure(ACCOUNT, CYCLE).reservedMicro).toBe(0);
  });

  it("cannot settle a released hold", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const r = ledger.reserve(request({ key: "q", bound: DOLLAR }));
    if (r.kind !== "ADMITTED") throw new Error("setup refused");
    ledger.release(r.reservationId, { kind: "PRE_DISPATCH_TRANSPORT", code: "ECONNREFUSED" });
    expect(() => ledger.settle(r.reservationId, 1)).toThrow(LedgerStateError);
  });

  it("records every transition as an event, in order", () => {
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const r = ledger.reserve(request({ key: "e", bound: DOLLAR }));
    if (r.kind !== "ADMITTED") throw new Error("setup refused");
    ledger.markUnknown(r.reservationId, "timeout");
    ledger.settle(r.reservationId, 700_000);
    expect(ledger.events(r.reservationId).map((e) => e.kind)).toEqual(["RESERVED", "UNKNOWN", "SETTLED"]);
  });

  it("makes usage events append-only at the database, not only in code", () => {
    const path = join(dir, "append.sqlite");
    const ledger = openLedger(path);
    fileLedgers.push(ledger);
    const r = ledger.reserve(request({ key: "a", bound: DOLLAR }));
    if (r.kind !== "ADMITTED") throw new Error("setup refused");

    const raw = new Database(path);
    try {
      expect(() => raw.prepare("UPDATE usage_events SET amount_micro = 0").run()).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM usage_events").run()).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });

  it("refuses a database whose schema is newer than this build", () => {
    const path = join(dir, "future.sqlite");
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => new BudgetLedger({ path })).toThrow(LedgerStateError);
  });
});

describe("release proof (N-6)", () => {
  it.each([
    [{ kind: "HTTP_STATUS", status: 429 }, true],
    [{ kind: "HTTP_STATUS", status: 402 }, true],
    [{ kind: "HTTP_STATUS", status: 401 }, true],
    [{ kind: "HTTP_STATUS", status: 500 }, false],
    [{ kind: "HTTP_STATUS", status: 504 }, false],
    [{ kind: "PRE_DISPATCH_TRANSPORT", code: "ECONNREFUSED" }, true],
    [{ kind: "PRE_DISPATCH_TRANSPORT", code: "ETIMEDOUT" }, false],
    [{ kind: "PROVIDER_TOTALS_NO_CHARGE", evidence: "usage total unchanged" }, true],
    [{ kind: "PROVIDER_TOTALS_NO_CHARGE", evidence: "  " }, false],
  ] as const)("accepts or refuses %j", (proof, accepted) => {
    expect(isNoExecutionProof(proof as never)).toBe(accepted);
  });
});

describe("invariant under random sequences (plan section 11.4)", () => {
  it("settled + reserved + unknown never exceed the cap unless the cycle is marked overexposed", () => {
    let seed = 7;
    const next = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % (max + 1);
    };
    const ledger = openLedger();
    fileLedgers.push(ledger);
    const held: string[] = [];
    let counter = 0;

    for (let step = 0; step < 400; step++) {
      const op = next(4);
      if (op === 0) {
        const r = ledger.reserve(request({ key: `r${counter++}`, bound: 100_000 + next(5 * DOLLAR) }));
        if (r.kind === "ADMITTED") held.push(r.reservationId);
      } else if (op === 1 && held.length > 0) {
        const id = held.splice(next(held.length - 1), 1)[0];
        ledger.settle(id, next(6 * DOLLAR));
      } else if (op === 2 && held.length > 0) {
        const id = held[next(held.length - 1)];
        const state = ledger.get(id)?.state;
        if (state === "RESERVED") {
          ledger.release(id, { kind: "HTTP_STATUS", status: 429 });
          held.splice(held.indexOf(id), 1);
        }
      } else if (op === 3 && held.length > 0) {
        const id = held[next(held.length - 1)];
        if (ledger.get(id)?.state === "RESERVED") ledger.markUnknown(id, "timeout");
      }

      const e = ledger.exposure(ACCOUNT, CYCLE);
      expect(e.settledMicro).toBeGreaterThanOrEqual(0);
      expect(e.reservedMicro).toBeGreaterThanOrEqual(0);
      expect(e.unknownMicro).toBeGreaterThanOrEqual(0);
      expect(e.totalMicro).toBe(e.settledMicro + e.reservedMicro + e.unknownMicro + e.carryoverMicro);
      if (!e.overexposed) expect(e.settledMicro + e.reservedMicro + e.unknownMicro).toBeLessThanOrEqual(CAP);
    }
  });
});
