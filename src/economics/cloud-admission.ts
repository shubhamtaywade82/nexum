/**
 * LedgerCloudAdmission — the CloudAdmission port backed by the durable budget ledger.
 *
 * `admit` prices the worst case of one call (input bound at the input rate plus the output cap at the output rate),
 * then reserves it in the ledger under the current calendar-month cycle. A reservation records the price version it
 * was taken at, and settlement uses that same version, so a later price change never re-prices an earlier call.
 *
 * The input bound is a byte count: each token is at least one UTF-8 byte of content, so the bytes of the serialized
 * request bound its content tokens. Chat-template tokens are not content, so each message and the request as a whole
 * get a fixed allowance on top (BASE_OVERHEAD_TOKENS, PER_MESSAGE_OVERHEAD_TOKENS). That allowance is an assumption,
 * and `settle` records any call whose provider-reported prompt count exceeds the bound.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  CloudAdmission,
  CloudAdmissionDecision,
  CloudAdmissionRequest,
  CloudLease,
  UnexecutedReason,
} from "../models/gateway/cloud-admission.js";
import type { ChatMessage, ChatResponse } from "../models/adapters/provider.js";
import { readUsage } from "../models/usage-reading.js";
import { priceVersionId, type PriceCatalog, type PriceVersion } from "../models/profiles/pricing-catalog.js";
import { reservationBoundMicroUsd } from "./cost.js";
import { priceReading } from "./usage-cost.js";
import { BudgetLedger, isNoExecutionProof, type NoExecutionProof } from "./ledger/budget-ledger.js";

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** A request above this output cap is refused. Callers must ask for less. */
export const MAX_OUTPUT_TOKENS_CEILING = 8192;
export const BASE_OVERHEAD_TOKENS = 64;
export const PER_MESSAGE_OVERHEAD_TOKENS = 64;

/** Upper bound on the input tokens of one request, from its serialized size (see the module comment). */
export function inputTokenBound(messages: readonly ChatMessage[], tools: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools: tools ?? null }), "utf8");
  return bytes + BASE_OVERHEAD_TOKENS + PER_MESSAGE_OVERHEAD_TOKENS * messages.length;
}

export interface LedgerCloudAdmissionOptions {
  ledger: BudgetLedger;
  prices: PriceCatalog;
  accountId: string;
  /** Monthly USD ceiling in micro-dollars. null: this account has no USD ceiling (percent-mode balance). */
  monthlyCapMicro: number | null;
  defaultMaxOutputTokens?: number;
  maxOutputTokens?: number;
  clock?: () => Date;
}

interface InFlight {
  readonly price: PriceVersion;
  readonly inputBoundTokens: number;
}

function monthKey(now: Date): { cycleId: string; startsAt: string; endsAt: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    cycleId: `${year}-${pad(month)}`,
    startsAt: `${year}-${pad(month)}-01`,
    endsAt: `${next.y}-${pad(next.m)}-01`,
  };
}

export class LedgerCloudAdmission implements CloudAdmission {
  private readonly ledger: BudgetLedger;
  private readonly prices: PriceCatalog;
  private readonly accountId: string;
  private readonly monthlyCapMicro: number | null;
  private readonly defaultMaxOutputTokens: number;
  private readonly maxOutputTokens: number;
  private readonly clock: () => Date;
  /** Prices and input bounds of reservations that have not settled. Bounded by the cloud concurrency cap. */
  private readonly inFlight = new Map<string, InFlight>();

  constructor(opts: LedgerCloudAdmissionOptions) {
    this.ledger = opts.ledger;
    this.prices = opts.prices;
    this.accountId = opts.accountId;
    this.monthlyCapMicro = opts.monthlyCapMicro;
    this.defaultMaxOutputTokens = opts.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.maxOutputTokens = opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CEILING;
    this.clock = opts.clock ?? (() => new Date());
  }

  admit(req: CloudAdmissionRequest): CloudAdmissionDecision {
    const now = this.clock();
    // Throws UnpricedModelError: an unpriced cloud call is refused before anything is sent.
    const price = this.prices.requirePrice(req.model, now);
    const outputCap = req.maxOutputTokens ?? this.defaultMaxOutputTokens;
    if (!Number.isSafeInteger(outputCap) || outputCap < 1) {
      return {
        kind: "REFUSED",
        code: "INVALID_OUTPUT_CAP",
        reason: `output cap ${String(outputCap)} is not a positive integer`,
      };
    }
    if (outputCap > this.maxOutputTokens) {
      return {
        kind: "REFUSED",
        code: "OUTPUT_CAP_EXCEEDED",
        reason: `output cap ${outputCap} exceeds the ${this.maxOutputTokens}-token ceiling`,
      };
    }

    const cycle = monthKey(now);
    this.ledger.openCycle({
      accountId: this.accountId,
      cycleId: cycle.cycleId,
      startsAt: cycle.startsAt,
      endsAt: cycle.endsAt,
      capMicro: this.monthlyCapMicro,
    });

    const inputBoundTokens = inputTokenBound(req.messages, req.tools);
    const boundMicro = reservationBoundMicroUsd(inputBoundTokens, outputCap, price);
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          model: req.model,
          purpose: req.purpose,
          messages: req.messages,
          tools: req.tools ?? null,
          outputCap,
        }),
      )
      .digest("hex");
    const outcome = this.ledger.reserve({
      accountId: this.accountId,
      cycleId: cycle.cycleId,
      idempotencyKey: req.idempotencyKey ?? randomUUID(),
      payloadHash,
      taskId: req.taskId,
      model: req.model,
      priceVersionId: priceVersionId(price),
      boundMicro,
    });

    if (outcome.kind === "ADMITTED") {
      this.inFlight.set(outcome.reservationId, { price, inputBoundTokens });
      return {
        kind: "ADMITTED",
        lease: { reservationId: outcome.reservationId, model: req.model, boundMicro, maxOutputTokens: outputCap },
      };
    }
    if (outcome.kind === "REJECTED") {
      return {
        kind: "REFUSED",
        code: outcome.reason,
        reason: describeRejection(outcome.reason, boundMicro, outcome.exposure),
      };
    }
    if (outcome.kind === "IN_FLIGHT") {
      return { kind: "REFUSED", code: "IN_FLIGHT", reason: "a call with this idempotency key is still in flight" };
    }
    if (outcome.kind === "REPLAY") {
      return {
        kind: "REFUSED",
        code: "ALREADY_COMPLETED",
        reason: "a call with this idempotency key already completed",
      };
    }
    if (outcome.kind === "PAYLOAD_MISMATCH") {
      return {
        kind: "REFUSED",
        code: "PAYLOAD_MISMATCH",
        reason: "this idempotency key was used for a different request",
      };
    }
    return { kind: "REFUSED", code: "LEDGER_INCONSISTENT", reason: "unexpected ledger outcome" };
  }

  settle(lease: CloudLease, response: ChatResponse): void {
    const flight = this.takeInFlight(lease);
    const reading = readUsage(response);
    const priced = priceReading(reading, flight.price);
    // No counters: the cost is unknown, so the reservation settles at its bound. Never zero.
    const amount = priced ? priced.costMicroUsd : lease.boundMicro;
    const overBound = reading.promptTokens !== undefined && reading.promptTokens > flight.inputBoundTokens;
    const detail = [
      priced ? `basis=${priced.basis}` : "basis=BOUND_NO_USAGE",
      overBound ? `INPUT_OVER_BOUND prompt=${reading.promptTokens} bound=${flight.inputBoundTokens}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join("; ");
    this.ledger.settle(lease.reservationId, amount, detail);
  }

  releaseUnexecuted(lease: CloudLease, reason: UnexecutedReason): void {
    this.takeInFlight(lease);
    const proof = reason as NoExecutionProof;
    if (!isNoExecutionProof(proof)) {
      this.ledger.markUnknown(lease.reservationId, "release proof rejected by the ledger");
      return;
    }
    this.ledger.release(lease.reservationId, proof);
  }

  markUnknown(lease: CloudLease, reason: string): void {
    this.takeInFlight(lease);
    this.ledger.markUnknown(lease.reservationId, reason);
  }

  private takeInFlight(lease: CloudLease): InFlight {
    const flight = this.inFlight.get(lease.reservationId);
    if (!flight) throw new Error(`no in-flight reservation ${lease.reservationId} for this admission`);
    this.inFlight.delete(lease.reservationId);
    return flight;
  }
}

function describeRejection(
  reason: string,
  boundMicro: number,
  exposure: { capMicro: number | null; totalMicro: number } | undefined,
): string {
  switch (reason) {
    case "BUDGET_EXCEEDED":
      return `cloud call refused: worst case ${boundMicro} µ$ does not fit under the cycle cap (committed ${exposure?.totalMicro ?? "?"} of ${exposure?.capMicro ?? "?"} µ$)`;
    case "CYCLE_OVEREXPOSED":
      return "cloud call refused: this cycle is overexposed and needs review before paid calls resume";
    case "CLOUD_CONCURRENCY":
      return "cloud call refused: the shared cloud concurrency cap is in use by other reservations";
    case "CYCLE_NOT_OPEN":
      return "cloud call refused: the billing cycle is not open";
    default:
      return `cloud call refused: ${reason}`;
  }
}
