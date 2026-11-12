/**
 * BudgetLedger — the durable record of what cloud inference may still cost, shared by every Nexum process of one
 * user (the CLI, the host, a benchmark run).
 *
 * Each cloud call is one reservation. A reservation is taken at its worst-case bound before the request is sent,
 * and is settled to the provider's reported cost afterwards. The state machine is:
 *
 *   RESERVED ──settle──────────────► SETTLED            (cost known, from the provider's counters)
 *   RESERVED ──release (proof)─────► RELEASED           (provably not executed: 401/402/429, pre-dispatch failure)
 *   RESERVED ──markUnknown─────────► UNKNOWN_USAGE      (may have executed; the hold stays)
 *   UNKNOWN_USAGE ──settle─────────► SETTLED            (reconciled against provider totals)
 *   UNKNOWN_USAGE ──release (proof)► RELEASED           (reconciled: provider totals show no charge)
 *
 * Invariant, per account and cycle: settled + reserved + unknown ≤ cap. A settlement that exceeds the bound pushes
 * the total past the cap; the true cost is recorded anyway, the cycle is marked OVEREXPOSED, and no further
 * reservation is admitted until the account is reviewed. Spend is never edited to keep the invariant.
 *
 * Admission (`reserve`) runs in one `BEGIN IMMEDIATE` transaction, so two processes cannot both see the same headroom.
 * Usage events are append-only, enforced by triggers.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AgentRuntimeError } from "../../models/errors.js";
import { LEDGER_SCHEMA_VERSION, LEDGER_SCHEMA_SQL } from "./schema.js";

export type ReservationState = "RESERVED" | "SETTLED" | "RELEASED" | "UNKNOWN_USAGE";

/** Proof that a request was not executed by the provider. Only these may release a hold. */
export type NoExecutionProof =
  | { readonly kind: "HTTP_STATUS"; readonly status: 401 | 402 | 429 }
  | { readonly kind: "PRE_DISPATCH_TRANSPORT"; readonly code: string }
  | { readonly kind: "PROVIDER_TOTALS_NO_CHARGE"; readonly evidence: string };

export interface CycleRecord {
  readonly accountId: string;
  readonly cycleId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** null: no USD ceiling for this cycle (percent-mode balance). */
  readonly capMicro: number | null;
  readonly overexposed: boolean;
  readonly overexposedReason: string | null;
  readonly purchasedBaselineMicro: number | null;
}

export interface ReservationRecord {
  readonly reservationId: string;
  readonly accountId: string;
  readonly cycleId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly taskId: string;
  readonly model: string;
  readonly priceVersionId: string;
  readonly boundMicro: number;
  readonly settledMicro: number | null;
  readonly state: ReservationState;
  readonly releaseProof: string | null;
  readonly createdAt: string;
}

export interface Exposure {
  /** The cycle's cap, or null for an account with no USD ceiling (percent-mode balance). */
  readonly capMicro: number | null;
  readonly settledMicro: number;
  readonly reservedMicro: number;
  readonly unknownMicro: number;
  /** Holds carried from earlier cycles of the same account: reserved and unknown only, settled stays with its cycle. */
  readonly carryoverMicro: number;
  readonly totalMicro: number;
  readonly overexposed: boolean;
}

export interface ReserveRequest {
  readonly accountId: string;
  readonly cycleId: string;
  readonly idempotencyKey: string;
  /** Hash of the canonical request. The same key with a different payload is refused, never replayed. */
  readonly payloadHash: string;
  readonly taskId: string;
  readonly model: string;
  readonly priceVersionId: string;
  readonly boundMicro: number;
}

export type RejectReason = "BUDGET_EXCEEDED" | "CYCLE_OVEREXPOSED" | "CLOUD_CONCURRENCY" | "CYCLE_NOT_OPEN";

export type ReserveOutcome =
  | { readonly kind: "ADMITTED"; readonly reservationId: string; readonly exposure: Exposure }
  /** Same key, same payload, already completed: return the stored result, do not execute again. */
  | { readonly kind: "REPLAY"; readonly reservation: ReservationRecord }
  /** Same key while the first attempt is reserved or unknown: the caller must wait, not retry. */
  | { readonly kind: "IN_FLIGHT"; readonly reservation: ReservationRecord }
  /** Same key, different payload: a client bug. */
  | { readonly kind: "PAYLOAD_MISMATCH"; readonly reservation: ReservationRecord }
  | { readonly kind: "REJECTED"; readonly reason: RejectReason; readonly exposure?: Exposure };

export interface SettleOutcome {
  readonly reservation: ReservationRecord;
  readonly exposure: Exposure;
  /** True when this settlement moved the cycle past its cap. */
  readonly overexposedNow: boolean;
}

export class LedgerStateError extends AgentRuntimeError {
  constructor(message: string) {
    super(message, "LEDGER_STATE");
  }
}

export interface BudgetLedgerOptions {
  /** SQLite file path, or ":memory:" for tests. The parent directory is created. */
  path: string;
  /** Clock source; injected in tests. */
  clock?: () => Date;
  /** Cloud calls allowed in RESERVED state across every process sharing this ledger (N-9). */
  maxCloudConcurrency?: number;
}

const NO_EXECUTION_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** Whether a release proof is one the ledger accepts as evidence that nothing ran on the provider. */
export function isNoExecutionProof(proof: NoExecutionProof): boolean {
  if (proof.kind === "HTTP_STATUS") return proof.status === 401 || proof.status === 402 || proof.status === 429;
  if (proof.kind === "PRE_DISPATCH_TRANSPORT") return NO_EXECUTION_TRANSPORT_CODES.has(proof.code);
  return proof.kind === "PROVIDER_TOTALS_NO_CHARGE" && proof.evidence.trim() !== "";
}

interface ReservationRow {
  reservation_id: string;
  account_id: string;
  cycle_id: string;
  idempotency_key: string;
  payload_hash: string;
  task_id: string;
  model: string;
  price_version_id: string;
  bound_micro: number;
  settled_micro: number | null;
  state: ReservationState;
  release_proof: string | null;
  created_at: string;
}

interface CycleRow {
  account_id: string;
  cycle_id: string;
  starts_at: string;
  ends_at: string;
  cap_micro: number | null;
  overexposed: number;
  overexposed_reason: string | null;
  purchased_baseline_micro: number | null;
}

function toReservation(row: ReservationRow): ReservationRecord {
  return {
    reservationId: row.reservation_id,
    accountId: row.account_id,
    cycleId: row.cycle_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    taskId: row.task_id,
    model: row.model,
    priceVersionId: row.price_version_id,
    boundMicro: row.bound_micro,
    settledMicro: row.settled_micro,
    state: row.state,
    releaseProof: row.release_proof,
    createdAt: row.created_at,
  };
}

function toCycle(row: CycleRow): CycleRecord {
  return {
    accountId: row.account_id,
    cycleId: row.cycle_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capMicro: row.cap_micro,
    overexposed: row.overexposed === 1,
    overexposedReason: row.overexposed_reason,
    purchasedBaselineMicro: row.purchased_baseline_micro,
  };
}

function assertMicro(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LedgerStateError(`${name} must be a non-negative safe integer micro-dollar amount, got ${String(value)}`);
  }
}

export class BudgetLedger {
  private readonly db: Database.Database;
  private readonly clock: () => Date;
  private readonly maxCloudConcurrency: number;
  private readonly stmts: ReturnType<BudgetLedger["prepareStatements"]>;

  constructor(opts: BudgetLedgerOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.maxCloudConcurrency = opts.maxCloudConcurrency ?? 3;
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 });
    this.db = new Database(opts.path);
    if (opts.path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.stmts = this.prepareStatements();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > LEDGER_SCHEMA_VERSION) {
      throw new LedgerStateError(`ledger schema ${version} is newer than this build (${LEDGER_SCHEMA_VERSION})`);
    }
    if (version === LEDGER_SCHEMA_VERSION) return;
    this.db.transaction(() => {
      this.db.exec(LEDGER_SCHEMA_SQL);
      this.db.pragma(`user_version = ${LEDGER_SCHEMA_VERSION}`);
    }).immediate();
  }

  private prepareStatements() {
    return {
      cycle: this.db.prepare(
        "SELECT * FROM cycles WHERE account_id = ? AND cycle_id = ?",
      ),
      cyclesOfAccount: this.db.prepare("SELECT * FROM cycles WHERE account_id = ?"),
      reservationByKey: this.db.prepare(
        "SELECT * FROM reservations WHERE account_id = ? AND idempotency_key = ?",
      ),
      reservationById: this.db.prepare("SELECT * FROM reservations WHERE reservation_id = ?"),
      insertReservation: this.db.prepare(
        `INSERT INTO reservations (reservation_id, account_id, cycle_id, idempotency_key, payload_hash, task_id, model,
           tier, price_version_id, bound_micro, settled_micro, state, release_proof, created_at, updated_at)
         VALUES (@reservation_id, @account_id, @cycle_id, @idempotency_key, @payload_hash, @task_id, @model,
           'cloud', @price_version_id, @bound_micro, NULL, 'RESERVED', NULL, @at, @at)`,
      ),
      exposureRows: this.db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'SETTLED' THEN settled_micro ELSE 0 END), 0) AS settled,
           COALESCE(SUM(CASE WHEN state = 'RESERVED' THEN bound_micro ELSE 0 END), 0) AS reserved,
           COALESCE(SUM(CASE WHEN state = 'UNKNOWN_USAGE' THEN bound_micro ELSE 0 END), 0) AS unknown
         FROM reservations WHERE account_id = @account_id AND cycle_id = @cycle_id`,
      ),
      carryoverRows: this.db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'RESERVED' THEN bound_micro ELSE 0 END), 0) AS reserved,
           COALESCE(SUM(CASE WHEN state = 'UNKNOWN_USAGE' THEN bound_micro ELSE 0 END), 0) AS unknown
         FROM reservations WHERE account_id = @account_id AND cycle_id <> @cycle_id`,
      ),
      overexposedAny: this.db.prepare("SELECT COUNT(*) AS n FROM cycles WHERE account_id = ? AND overexposed = 1"),
      activeCloud: this.db.prepare(
        "SELECT COUNT(*) AS n FROM reservations WHERE account_id = ? AND state = 'RESERVED'",
      ),
      setState: this.db.prepare(
        `UPDATE reservations SET state = @state, settled_micro = @settled, release_proof = @proof, updated_at = @at
         WHERE reservation_id = @id`,
      ),
      event: this.db.prepare(
        "INSERT INTO usage_events (reservation_id, kind, amount_micro, detail, at) VALUES (@id, @kind, @amount, @detail, @at)",
      ),
      markOverexposed: this.db.prepare(
        `UPDATE cycles SET overexposed = 1, overexposed_reason = COALESCE(overexposed_reason, @reason)
         WHERE account_id = @account_id AND cycle_id = @cycle_id`,
      ),
      setPurchasedBaseline: this.db.prepare(
        `UPDATE cycles SET purchased_baseline_micro = @micro
         WHERE account_id = @account_id AND cycle_id = @cycle_id AND purchased_baseline_micro IS NULL`,
      ),
      reservationsOfAccount: this.db.prepare(
        "SELECT * FROM reservations WHERE account_id = ? ORDER BY created_at, reservation_id",
      ),
      eventsOf: this.db.prepare("SELECT kind, amount_micro, detail, at FROM usage_events WHERE reservation_id = ? ORDER BY event_id"),
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /** Opens a billing cycle. Idempotent for the same cap; a different cap for an existing cycle is refused. */
  openCycle(input: {
    accountId: string;
    cycleId: string;
    startsAt: string;
    endsAt: string;
    /** null: this cycle has no USD ceiling (percent-mode balance). Admission then applies no headroom check. */
    capMicro: number | null;
  }): CycleRecord {
    if (input.capMicro !== null) assertMicro("capMicro", input.capMicro);
    return this.db.transaction(() => {
      const existing = this.stmts.cycle.get(input.accountId, input.cycleId) as CycleRow | undefined;
      if (existing) {
        if (existing.cap_micro !== input.capMicro) {
          throw new LedgerStateError(
            `cycle ${input.cycleId} already exists with cap ${existing.cap_micro}; refusing to change it to ${input.capMicro}`,
          );
        }
        return toCycle(existing);
      }
      this.db
        .prepare(
          `INSERT INTO cycles (account_id, cycle_id, starts_at, ends_at, cap_micro, overexposed, purchased_baseline_micro)
           VALUES (?, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(input.accountId, input.cycleId, input.startsAt, input.endsAt, input.capMicro);
      return toCycle(this.stmts.cycle.get(input.accountId, input.cycleId) as CycleRow);
    }).immediate();
  }

  cycle(accountId: string, cycleId: string): CycleRecord | undefined {
    const row = this.stmts.cycle.get(accountId, cycleId) as CycleRow | undefined;
    return row ? toCycle(row) : undefined;
  }

  /** Records the account's purchased-credit balance at the start of a cycle, once. Used by reconciliation. */
  setPurchasedBaseline(accountId: string, cycleId: string, micro: number): void {
    assertMicro("purchased baseline", micro);
    this.stmts.setPurchasedBaseline.run({ account_id: accountId, cycle_id: cycleId, micro });
  }

  exposure(accountId: string, cycleId: string): Exposure {
    const cycle = this.cycle(accountId, cycleId);
    if (!cycle) throw new LedgerStateError(`cycle ${cycleId} is not open for account ${accountId}`);
    return this.exposureUnsafe(accountId, cycleId, cycle.capMicro);
  }

  /**
   * Marks a cycle overexposed with a reason, blocking new paid admissions. Used by reconciliation when provider spend
   * exceeds everything the ledger can attribute, and by settlement. The flag is never cleared automatically.
   */
  flagOverexposed(accountId: string, cycleId: string, reason: string): void {
    this.db.transaction(() => {
      if (!this.cycle(accountId, cycleId)) throw new LedgerStateError(`cycle ${cycleId} is not open for ${accountId}`);
      this.stmts.markOverexposed.run({ account_id: accountId, cycle_id: cycleId, reason });
    }).immediate();
  }

  private exposureUnsafe(accountId: string, cycleId: string, capMicro: number | null): Exposure {
    const own = this.stmts.exposureRows.get({ account_id: accountId, cycle_id: cycleId }) as {
      settled: number;
      reserved: number;
      unknown: number;
    };
    const carry = this.stmts.carryoverRows.get({ account_id: accountId, cycle_id: cycleId }) as {
      reserved: number;
      unknown: number;
    };
    const overexposed = (this.stmts.overexposedAny.get(accountId) as { n: number }).n > 0;
    const carryoverMicro = carry.reserved + carry.unknown;
    return {
      capMicro,
      settledMicro: own.settled,
      reservedMicro: own.reserved,
      unknownMicro: own.unknown,
      carryoverMicro,
      totalMicro: own.settled + own.reserved + own.unknown + carryoverMicro,
      overexposed,
    };
  }

  /**
   * Admission. The idempotency lookup, the headroom check and the insert happen in one immediate transaction.
   * Carried holds (reserved or unknown from earlier cycles) count against the current cycle: the money has not
   * been reconciled, so it is not treated as gone.
   */
  reserve(req: ReserveRequest): ReserveOutcome {
    assertMicro("boundMicro", req.boundMicro);
    return this.db.transaction((): ReserveOutcome => {
      const prior = this.stmts.reservationByKey.get(req.accountId, req.idempotencyKey) as ReservationRow | undefined;
      if (prior) {
        const record = toReservation(prior);
        if (prior.payload_hash !== req.payloadHash) return { kind: "PAYLOAD_MISMATCH", reservation: record };
        if (record.state === "RESERVED" || record.state === "UNKNOWN_USAGE") {
          return { kind: "IN_FLIGHT", reservation: record };
        }
        return { kind: "REPLAY", reservation: record };
      }

      const cycle = this.cycle(req.accountId, req.cycleId);
      if (!cycle) return { kind: "REJECTED", reason: "CYCLE_NOT_OPEN" };

      const exposure = this.exposureUnsafe(req.accountId, req.cycleId, cycle.capMicro);
      if (exposure.overexposed) return { kind: "REJECTED", reason: "CYCLE_OVEREXPOSED", exposure };

      const active = (this.stmts.activeCloud.get(req.accountId) as { n: number }).n;
      if (active >= this.maxCloudConcurrency) return { kind: "REJECTED", reason: "CLOUD_CONCURRENCY", exposure };

      if (cycle.capMicro !== null && exposure.totalMicro + req.boundMicro > cycle.capMicro) {
        return { kind: "REJECTED", reason: "BUDGET_EXCEEDED", exposure };
      }

      const reservationId = randomUUID();
      const at = this.now();
      this.stmts.insertReservation.run({
        reservation_id: reservationId,
        account_id: req.accountId,
        cycle_id: req.cycleId,
        idempotency_key: req.idempotencyKey,
        payload_hash: req.payloadHash,
        task_id: req.taskId,
        model: req.model,
        price_version_id: req.priceVersionId,
        bound_micro: req.boundMicro,
        at,
      });
      this.stmts.event.run({ id: reservationId, kind: "RESERVED", amount: req.boundMicro, detail: null, at });
      const after: Exposure = {
        ...exposure,
        reservedMicro: exposure.reservedMicro + req.boundMicro,
        totalMicro: exposure.totalMicro + req.boundMicro,
      };
      return { kind: "ADMITTED", reservationId, exposure: after };
    }).immediate();
  }

  get(reservationId: string): ReservationRecord | undefined {
    const row = this.stmts.reservationById.get(reservationId) as ReservationRow | undefined;
    return row ? toReservation(row) : undefined;
  }

  reservationsOf(accountId: string): ReservationRecord[] {
    return (this.stmts.reservationsOfAccount.all(accountId) as ReservationRow[]).map(toReservation);
  }

  events(reservationId: string): Array<{ kind: string; amountMicro: number | null; detail: string | null; at: string }> {
    return (this.stmts.eventsOf.all(reservationId) as Array<{ kind: string; amount_micro: number | null; detail: string | null; at: string }>).map(
      (e) => ({ kind: e.kind, amountMicro: e.amount_micro, detail: e.detail, at: e.at }),
    );
  }

  /** Settles a reservation to the provider's reported cost. Allowed from RESERVED and from UNKNOWN_USAGE. */
  settle(reservationId: string, actualMicro: number, detail: string | null = null): SettleOutcome {
    assertMicro("actualMicro", actualMicro);
    return this.db.transaction((): SettleOutcome => {
      const record = this.requireState(reservationId, ["RESERVED", "UNKNOWN_USAGE"], "settle");
      const at = this.now();
      this.stmts.setState.run({ id: reservationId, state: "SETTLED", settled: actualMicro, proof: null, at });
      this.stmts.event.run({ id: reservationId, kind: "SETTLED", amount: actualMicro, detail, at });

      const cycle = this.cycle(record.accountId, record.cycleId);
      if (!cycle) throw new LedgerStateError(`reservation ${reservationId} has no cycle`);
      const exposure = this.exposureUnsafe(record.accountId, record.cycleId, cycle.capMicro);
      let overexposedNow = false;
      if (cycle.capMicro !== null && exposure.totalMicro > cycle.capMicro && !cycle.overexposed) {
        overexposedNow = true;
        const reason = `settled ${actualMicro} against bound ${record.boundMicro}; total ${exposure.totalMicro} > cap ${cycle.capMicro}`;
        this.stmts.markOverexposed.run({ account_id: record.accountId, cycle_id: record.cycleId, reason });
        this.stmts.event.run({
          id: reservationId,
          kind: "OVEREXPOSED",
          amount: exposure.totalMicro - cycle.capMicro,
          detail: reason,
          at,
        });
      }
      return {
        reservation: this.get(reservationId)!,
        exposure: { ...exposure, overexposed: exposure.overexposed || overexposedNow },
        overexposedNow,
      };
    }).immediate();
  }

  /** Releases a hold with proof that nothing ran on the provider. Refused without proof. */
  release(reservationId: string, proof: NoExecutionProof): ReservationRecord {
    if (!isNoExecutionProof(proof)) {
      throw new LedgerStateError("a hold can only be released with proof that the provider did not execute the request");
    }
    return this.db.transaction((): ReservationRecord => {
      this.requireState(reservationId, ["RESERVED", "UNKNOWN_USAGE"], "release");
      const at = this.now();
      const serialized = JSON.stringify(proof);
      this.stmts.setState.run({ id: reservationId, state: "RELEASED", settled: null, proof: serialized, at });
      this.stmts.event.run({ id: reservationId, kind: "RELEASED", amount: null, detail: serialized, at });
      return this.get(reservationId)!;
    }).immediate();
  }

  /**
   * Marks a hold whose outcome is unknown: the request may have run. The hold stays, and the same key cannot be
   * sent again as a paid call until reconciliation resolves it.
   */
  markUnknown(reservationId: string, reason: string): ReservationRecord {
    return this.db.transaction((): ReservationRecord => {
      this.requireState(reservationId, ["RESERVED"], "markUnknown");
      const at = this.now();
      this.stmts.setState.run({ id: reservationId, state: "UNKNOWN_USAGE", settled: null, proof: null, at });
      this.stmts.event.run({ id: reservationId, kind: "UNKNOWN", amount: null, detail: reason, at });
      return this.get(reservationId)!;
    }).immediate();
  }

  /** Records an event against a reservation without changing its state (reconciliation evidence). */
  note(reservationId: string, kind: "RECONCILED", detail: string, amountMicro: number | null = null): void {
    this.db.transaction(() => {
      this.requireState(reservationId, ["RESERVED", "UNKNOWN_USAGE", "SETTLED", "RELEASED"], "note");
      this.stmts.event.run({ id: reservationId, kind, amount: amountMicro, detail, at: this.now() });
    }).immediate();
  }

  /** Number of settled reservations in a cycle. Reconciliation uses it to bound per-call rounding. */
  settledCount(accountId: string, cycleId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM reservations WHERE account_id = ? AND cycle_id = ? AND state = 'SETTLED'")
      .get(accountId, cycleId) as { n: number };
    return row.n;
  }

  /** Unknown holds of one cycle, oldest first. Used by reconciliation. */
  unknownHolds(accountId: string, cycleId: string): ReservationRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM reservations WHERE account_id = ? AND cycle_id = ? AND state = 'UNKNOWN_USAGE' ORDER BY created_at")
        .all(accountId, cycleId) as ReservationRow[]
    ).map(toReservation);
  }

  private requireState(reservationId: string, allowed: ReservationState[], op: string): ReservationRecord {
    const row = this.stmts.reservationById.get(reservationId) as ReservationRow | undefined;
    if (!row) throw new LedgerStateError(`no reservation ${reservationId}`);
    if (!allowed.includes(row.state)) {
      throw new LedgerStateError(`cannot ${op} reservation ${reservationId} in state ${row.state}`);
    }
    return toReservation(row);
  }
}
