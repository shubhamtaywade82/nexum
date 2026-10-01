/**
 * Nexum Decision Plane — domain contract.
 *
 * This module defines the *Nexum-level* types for a bounded decision request.
 * It is intentionally distinct from the upstream SDK's wire types for the
 * System One endpoint (`/v1/systemone`):
 *
 *   - The SDK speaks `Record<string, unknown>` at its boundary today (see
 *     `NativeApi.systemOne` in ollama-sdk). Nexum owns a typed contract so
 *     callers do not have to read SDK internals to know what a decision is.
 *   - The Nexum contract is independent of the exact System One wire shape
 *     so a future SDK release that finalizes the request/response schema
 *     can be wired in by replacing one adapter method (see
 *     `SystemOneDecisionGateway`).
 *
 * The contract preserves machine-readable evidence (probabilities, scores,
 * raw payload) rather than collapsing everything to prose. Policy — not the
 * gateway — converts evidence into operational decisions.
 */

import { DecisionProtocolError } from "./errors.js";

/**
 * Decision mode. Mirrors System One's operational taxonomy:
 *
 *  - `choice`: pick exactly one id from an explicitly bounded set of choices.
 *  - `score`: produce a numeric score (typically 0..1) per question — no
 *    predefined alternatives.
 *  - `noul`: "no-overlap-of-universe" — pick zero or one id from a set, with
 *    an implicit "none of the above" outcome. Used for gating decisions
 *    where the model is allowed to say "no candidate fits".
 */
export type DecisionMode = "choice" | "score" | "noul";

/**
 * A single bounded question. Multiple questions are batched into one
 * {@link DecisionRequest} so the gateway can issue a single System One call
 * covering all of them — do not split one decision into N network requests.
 */
export interface DecisionQuestion {
  id: string;
  prompt: string;
  /**
   * Explicitly bounded alternatives. Required for `choice`/`noul` modes;
   * optional for `score` (where the model emits a scalar per question
   * without selecting from a list).
   *
   * System One must never return a selected id that is not in this set.
   * The gateway rejects out-of-band ids as a {@link DecisionProtocolError}.
   */
  choices?: Array<{ id: string; description: string }>;
}

/**
 * Optional metadata for telemetry. Never contains secrets — the gateway
 * must scrub any value before forwarding it to the upstream model.
 */
export interface DecisionMetadata {
  /** Caller-supplied correlation id (e.g. the agent run id). */
  correlationId?: string;
  /** Caller-supplied subsystem label (e.g. "tool-selection"). */
  subsystem?: string;
  /** Free-form caller notes; kept opaque by the gateway. */
  [key: string]: unknown;
}

/**
 * A bounded decision request. This is a Nexum domain object; the
 * {@link SystemOneDecisionGateway} adapts it to the SDK's wire protocol.
 *
 * The full serialized request MUST stay within System One's 64 KiB
 * server-enforced limit (see `contracts/overlays/systemone.yaml` in the
 * upstream SDK). {@link validateDecisionRequest} enforces this client-side
 * so the gateway never sends a request the server will reject.
 */
export interface DecisionRequest {
  /** Caller-supplied id. If omitted, the gateway synthesizes one. */
  id?: string;
  model: string;
  mode: DecisionMode;
  /**
   * Compact shared context for ALL questions in this request. Must be
   * small — do NOT dump the repository, the full conversation, large tool
   * descriptions, or source files here. This is a bounded-decision context,
   * not a generative prompt.
   */
  context: string;
  questions: DecisionQuestion[];
  /** Abort signal propagated to the upstream SDK call. */
  signal?: AbortSignal;
  metadata?: DecisionMetadata;
}

/**
 * One question's parsed decision. Carries the model evidence that Nexum
 * policy will use; nothing here is treated as calibrated confidence.
 */
export interface DecisionAnswer {
  questionId: string;
  /** Selected choice id (must appear in the question's `choices`). */
  selected?: string;
  /** Numeric score (0..1) — populated for `score` mode. */
  score?: number;
  /** Per-choice probability mass — populated for `choice`/`noul` modes
   *  when the underlying System One response includes them. */
  probabilities?: Record<string, number>;
  /** The raw wire payload for this question, preserved for telemetry/replay. */
  raw?: unknown;
}

/**
 * The parsed result of a {@link DecisionRequest}. Contains enough structured
 * evidence for deterministic policy evaluation — never reduced to a single
 * "System One said yes" string.
 */
export interface DecisionResult {
  id: string;
  model: string;
  mode: DecisionMode;
  decisions: DecisionAnswer[];
  /** Wall-clock decision latency in milliseconds. */
  latencyMs: number;
  /** Optional caller metadata echoed back, never secrets. */
  metadata?: DecisionMetadata;
}

// ── Validation ─────────────────────────────────────────────────────────────

/** System One server-enforced hard limit (see `systemone.yaml` `maxRequestBytes`). */
export const SYSTEM_ONE_MAX_REQUEST_BYTES = 64 * 1024;

function isStringNonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Validates a single {@link DecisionQuestion}. Throws a
 * {@link DecisionProtocolError} with a precise message on any contract
 * violation so callers can distinguish a malformed request from a model
 * or transport failure.
 */
export function validateDecisionQuestion(q: DecisionQuestion): void {
  if (!q || typeof q !== "object") throw new DecisionProtocolError("question must be an object");
  if (!isStringNonEmpty(q.id)) throw new DecisionProtocolError("question id must be a non-empty string");
  if (!isStringNonEmpty(q.prompt))
    throw new DecisionProtocolError(`question "${q.id}" prompt must be a non-empty string`);
  if (q.choices !== undefined) {
    if (!Array.isArray(q.choices)) {
      throw new DecisionProtocolError(`question "${q.id}" choices must be an array if present`);
    }
    const seen = new Set<string>();
    for (const c of q.choices) {
      if (!c || typeof c !== "object") {
        throw new DecisionProtocolError(`question "${q.id}" has a malformed choice entry`);
      }
      if (!isStringNonEmpty(c.id)) {
        throw new DecisionProtocolError(`question "${q.id}" has a choice with an empty id`);
      }
      if (!isStringNonEmpty(c.description)) {
        throw new DecisionProtocolError(`question "${q.id}" choice "${c.id}" description must be a non-empty string`);
      }
      if (seen.has(c.id)) {
        throw new DecisionProtocolError(`question "${q.id}" has a duplicate choice id "${c.id}"`);
      }
      seen.add(c.id);
    }
  }
}

/**
 * Validates a {@link DecisionRequest}, including the 64 KiB serialized
 * size limit. Throws a {@link DecisionProtocolError} on any violation.
 */
export function validateDecisionRequest(req: DecisionRequest): void {
  if (!req || typeof req !== "object") throw new DecisionProtocolError("decision request must be an object");
  if (!isStringNonEmpty(req.model))
    throw new DecisionProtocolError("decision request model must be a non-empty string");
  if (req.mode !== "choice" && req.mode !== "score" && req.mode !== "noul") {
    throw new DecisionProtocolError(`decision request mode "${String(req.mode)}" is not one of choice|score|noul`);
  }
  if (!isStringNonEmpty(req.context)) {
    throw new DecisionProtocolError("decision request context must be a non-empty string");
  }
  if (!Array.isArray(req.questions) || req.questions.length === 0) {
    throw new DecisionProtocolError("decision request must contain at least one question");
  }
  for (const q of req.questions) validateDecisionQuestion(q);

  // Cheap fast-fail first: if the context alone exceeds the limit, the
  // caller has a much bigger problem than the question envelope and a
  // precise message is the only way they'll know which knob to turn.
  const contextBytes = Buffer.byteLength(req.context, "utf8");
  if (contextBytes > SYSTEM_ONE_MAX_REQUEST_BYTES) {
    throw new DecisionProtocolError(`decision context is ${contextBytes} bytes, exceeds the System One 64 KiB limit`);
  }

  // Then the conservative full-request bound: the gateway may compact/travel
  // the request before sending, so the wire bytes can differ — but JSON
  // serializing the typed request is an honest upper bound and the only one
  // we can compute without coupling to the SDK's exact wire shape.
  const serialized = estimateRequestBytes(req);
  if (serialized > SYSTEM_ONE_MAX_REQUEST_BYTES) {
    throw new DecisionProtocolError(
      `serialized decision request is ${serialized} bytes, exceeds the System One 64 KiB limit`,
    );
  }
}

/** Conservative byte estimate of the wire request the gateway will send. */
export function estimateRequestBytes(req: DecisionRequest): number {
  // JSON.stringify is a reasonable upper bound for the actual body bytes
  // (the gateway may further trim/compact, but never grow). The context
  // alone is the dominant term and is checked first as the cheap fast-fail.
  return Buffer.byteLength(JSON.stringify(req), "utf8");
}
