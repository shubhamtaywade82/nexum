/**
 * Decision Plane telemetry + replay.
 *
 * The integration prompt §20/§21 requires: every DecisionGateway call is
 * observable, with enough structured evidence to answer "which decision
 * was made, why, by which model, with what probabilities, by what policy
 * threshold". Not "System One said yes" — the full DecisionResult.
 *
 * This module provides the recording seam: a {@link DecisionEventRecorder}
 * interface and an {@link InMemoryDecisionEventRecorder} default, plus a
 * {@link RecordingDecisionGateway} that wraps any gateway and records
 * each call (success or failure) for replay/debugging/evaluation.
 *
 * ── Privacy contract ────────────────────────────────────────────────────
 *
 * The recorder preserves the DecisionResult's id/model/mode/decisions and
 * the caller-supplied metadata. It NEVER persists secrets, API keys, or
 * transport-layer credentials — those live on the wire request, which the
 * gateway already separates from this telemetry. Callers MUST NOT put
 * secrets into DecisionRequest.metadata; the gateway does not sanitize
 * user content because user content is not secret material.
 *
 * ── Reliability contract ────────────────────────────────────────────────
 *
 * Telemetry must not break the runtime it observes. The
 * {@link RecordingDecisionGateway} swallows recorder errors so a
 * telemetry-store outage never breaks an agent turn.
 */

import { DecisionError } from "./errors.js";
import type { DecisionGateway } from "./decision-gateway.js";
import type { DecisionPolicy } from "./decision-policy.js";
import type { DecisionRequest, DecisionResult } from "./types.js";

/** A single decision event captured for telemetry/replay. */
export interface DecisionEvent {
  /** The DecisionResult.id (or the request id). */
  id: string;
  /** The gateway engine label ("system-one" / "fake" / ...). */
  engine: string;
  /** Decision model that produced the evidence. */
  model: string;
  /** Decision mode (choice / score / noul). */
  mode: DecisionRequest["mode"];
  /** Number of questions in the request. */
  questionCount: number;
  /** Wall-clock decision latency in ms. */
  latencyMs: number;
  /** true when decide() resolved; false when it threw. */
  success: boolean;
  /** Domains/tiers/choices selected after the policy was applied. */
  selected: string[];
  /** The policy that converted evidence into the selected set. */
  policy: DecisionPolicy;
  /** Why the call fell back (success=false only). */
  fallbackReason?: "transport_failure" | "protocol_error" | "policy_violation" | "unavailable" | "unknown";
  /** Caller-supplied subsystem label (e.g. "tool-selection"). */
  metadata?: Record<string, unknown>;
  /** The full DecisionResult, for replay/debugging. Preserved verbatim. */
  raw?: DecisionResult;
  /** When the event was recorded (epoch ms). */
  timestamp: number;
}

export interface DecisionEventRecorder {
  record(event: DecisionEvent): void;
}

export class InMemoryDecisionEventRecorder implements DecisionEventRecorder {
  private readonly store: DecisionEvent[] = [];

  record(event: DecisionEvent): void {
    this.store.push(event);
  }

  events(): readonly DecisionEvent[] {
    return this.store;
  }

  clear(): void {
    this.store.length = 0;
  }
}

export interface RecordingDecisionGatewayOptions {
  /** Decision policy applied to the result to derive `selected`. */
  policy: DecisionPolicy;
  /** Engine label override; defaults to the inner gateway's engine. */
  engine?: string;
  /** Caller subsystem label for the recorded events. */
  subsystem?: string;
}

function fallbackReasonFor(err: DecisionError): DecisionEvent["fallbackReason"] {
  switch (err.code) {
    case "DECISION_UNAVAILABLE":
      return "unavailable";
    case "DECISION_TRANSPORT_FAILURE":
      return "transport_failure";
    case "DECISION_PROTOCOL_ERROR":
      return "protocol_error";
    case "DECISION_POLICY_VIOLATION":
      return "policy_violation";
    default:
      return "unknown";
  }
}

export class RecordingDecisionGateway implements DecisionGateway {
  readonly engine: string;
  private readonly inner: DecisionGateway;
  private readonly recorder: DecisionEventRecorder;
  private readonly policy: DecisionPolicy;
  private readonly subsystem?: string;
  private readonly engineOverride: string | undefined;

  constructor(inner: DecisionGateway, recorder: DecisionEventRecorder, opts: RecordingDecisionGatewayOptions) {
    this.inner = inner;
    this.recorder = recorder;
    this.policy = opts.policy;
    this.subsystem = opts.subsystem;
    this.engineOverride = opts.engine;
    this.engine = opts.engine ?? inner.engine;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = Date.now();
    try {
      const result = await this.inner.decide(request);
      const selected = this.deriveSelected(result);
      this.safeRecord({
        id: result.id,
        engine: this.engine,
        model: result.model,
        mode: result.mode,
        questionCount: request.questions.length,
        latencyMs: result.latencyMs,
        success: true,
        selected,
        policy: this.policy,
        ...(this.subsystem ? { metadata: { subsystem: this.subsystem } } : {}),
        raw: result,
        timestamp: started,
      });
      return result;
    } catch (err) {
      const latencyMs = Math.max(0, Date.now() - started);
      const reason: DecisionEvent["fallbackReason"] = err instanceof DecisionError ? fallbackReasonFor(err) : "unknown";
      this.safeRecord({
        id: request.id ?? `decision-${started.toString(36)}`,
        engine: this.engine,
        model: request.model,
        mode: request.mode,
        questionCount: request.questions.length,
        latencyMs,
        success: false,
        selected: [],
        policy: this.policy,
        fallbackReason: reason,
        ...(this.subsystem ? { metadata: { subsystem: this.subsystem } } : {}),
        timestamp: started,
      });
      throw err;
    }
  }

  /** Applies the policy to the result to derive the selected domains/tiers. */
  private deriveSelected(result: DecisionResult): string[] {
    // Local import to avoid a top-level cycle: applyDecisionPolicy is
    // already exported from the decision index, but the wrapper is a
    // telemetry component so it takes a pre-applied selected list when
    // the caller supplies it (Wave 7 wiring). For now we derive it here
    // from the policy using the same logic.
    const eligible: Array<{ id: string; prob: number }> = [];
    for (const decision of result.decisions) {
      if (decision.probabilities && Object.keys(decision.probabilities).length > 0) {
        for (const [id, prob] of Object.entries(decision.probabilities)) {
          if (typeof prob === "number" && Number.isFinite(prob) && prob >= this.policy.minimumProbability) {
            eligible.push({ id, prob });
          }
        }
      } else if (decision.selected) {
        eligible.push({ id: decision.selected, prob: 1 });
      }
    }
    eligible.sort((a, b) => b.prob - a.prob);
    return eligible.slice(0, Math.max(0, this.policy.maxDomains)).map((e) => e.id);
  }

  /** Telemetry must never break the runtime — swallow recorder errors. */
  private safeRecord(event: DecisionEvent): void {
    try {
      this.recorder.record(event);
    } catch {
      // Intentionally silent — see the reliability contract above.
    }
  }
}
