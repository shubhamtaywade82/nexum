/**
 * The admission port for cloud calls. The dispatcher takes one reservation per cloud call through this port: before
 * the request is sent (`admit`), after the response arrives (`settle`), or when the outcome is known to be "not
 * executed" (`releaseUnexecuted`) or not known (`markUnknown`).
 *
 * The port lives in the models layer so the dispatcher does not depend on the ledger. The implementation that
 * backs it with the durable ledger is in src/economics (LedgerCloudAdmission).
 */

import type { ChatMessage, ChatResponse } from "../adapters/provider.js";

export interface CloudAdmissionRequest {
  /** Why the call happens, e.g. "chat.primary". Recorded with the reservation. */
  readonly purpose: string;
  readonly taskId: string;
  /** The model the request will be sent to. */
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** Tool schemas sent with the request. They count toward the input bound. */
  readonly tools?: unknown;
  /** The output allowance the caller asked for (`options.num_predict`). Omitted: the admission's default. */
  readonly maxOutputTokens?: number;
  /**
   * The caller's idempotency key. With it, a second admission under the same key does not run the call again: it is
   * refused as IN_FLIGHT, ALREADY_COMPLETED or PAYLOAD_MISMATCH. Omitted: a fresh key, so the call always runs.
   */
  readonly idempotencyKey?: string;
}

/** A reservation the dispatcher holds for one call. The output cap is sent to the provider as `num_predict`. */
export interface CloudLease {
  readonly reservationId: string;
  readonly model: string;
  readonly boundMicro: number;
  readonly maxOutputTokens: number;
}

export type CloudAdmissionDecision =
  | { readonly kind: "ADMITTED"; readonly lease: CloudLease }
  | { readonly kind: "REFUSED"; readonly code: string; readonly reason: string };

/** Evidence that a request never ran on the provider. Only these release a reservation. */
export type UnexecutedReason =
  | { readonly kind: "HTTP_STATUS"; readonly status: 402 | 429 }
  | { readonly kind: "PRE_DISPATCH_TRANSPORT"; readonly code: string };

export interface CloudAdmission {
  /**
   * Reserves the worst case of one call, or refuses it. Throws for a model with no price in force: an unpriced
   * cloud call is never sent.
   */
  admit(req: CloudAdmissionRequest): CloudAdmissionDecision;
  /** Settles to the provider's reported cost. A response without counters settles at the bound, never at zero. */
  settle(lease: CloudLease, response: ChatResponse): void;
  releaseUnexecuted(lease: CloudLease, reason: UnexecutedReason): void;
  markUnknown(lease: CloudLease, reason: string): void;
}
