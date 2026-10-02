/**
 * FakeDecisionGateway — the test/injection form of {@link DecisionGateway}.
 *
 * Used by:
 *   - every unit/integration test that exercises decision consumers without
 *     a real Ollama System One endpoint
 *   - the `enableDecision=false` configuration path (callers can plug a
 *     disabled/never-called fake rather than special-casing every consumer)
 *   - Wave 4+ consumers (DynamicToolSelector, routing, verification) that
 *     take a {@link DecisionGateway} via dependency injection
 *
 * Behavior is fully deterministic and observable: it scripts answers by
 * question id, validates that the scripted `selected` id is one of the
 * question's declared choices (mirroring the real gateway's protocol
 * check), and records every call through an optional `onDecide` hook for
 * telemetry replay assertions.
 */

import { DecisionProtocolError, type DecisionError } from "./errors.js";
import type { DecisionGateway } from "./decision-gateway.js";
import type { DecisionAnswer, DecisionRequest, DecisionResult } from "./types.js";

/** Scripted answer for a single question id. */
export interface FakeDecisionAnswer {
  selected?: string;
  score?: number;
  probabilities?: Record<string, number>;
  /** Preserved verbatim on the parsed {@link DecisionAnswer.raw} field. */
  raw?: unknown;
}

export interface FakeDecisionGatewayOptions {
  /**
   * Map from question id → scripted answer. Missing question ids cause the
   * gateway to throw {@link DecisionProtocolError}, matching the real
   * gateway's behavior when the model omits a requested question.
   */
  decisions: Record<string, FakeDecisionAnswer>;
  /**
   * If set, every `decide()` call rejects with this error. Used to test
   * consumer fallback behavior on System One outages.
   */
  failWith?: DecisionError;
  /** Per-call observer hook (telemetry / replay assertions). */
  onDecide?: (request: DecisionRequest, result: DecisionResult) => void;
}

export class FakeDecisionGateway implements DecisionGateway {
  readonly engine = "fake";
  private readonly opts: FakeDecisionGatewayOptions;

  constructor(opts: FakeDecisionGatewayOptions) {
    this.opts = opts;
  }
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (this.opts.failWith) throw this.opts.failWith;

    const started = Date.now();
    const answers: DecisionAnswer[] = [];

    for (const q of request.questions) {
      const scripted = this.opts.decisions[q.id];
      if (!scripted) {
        throw new DecisionProtocolError(`no scripted answer for question "${q.id}"`);
      }
      // The real gateway rejects out-of-band selected ids. The fake enforces
      // the same contract so consumers can be tested against the same
      // boundary the production adapter will impose.
      if (scripted.selected && q.choices && !q.choices.some((c) => c.id === scripted.selected)) {
        throw new DecisionProtocolError(
          `scripted selected "${scripted.selected}" is not a choice for question "${q.id}"`,
        );
      }
      answers.push({
        questionId: q.id,
        ...(scripted.selected !== undefined ? { selected: scripted.selected } : {}),
        ...(scripted.score !== undefined ? { score: scripted.score } : {}),
        ...(scripted.probabilities !== undefined ? { probabilities: scripted.probabilities } : {}),
        ...(scripted.raw !== undefined ? { raw: scripted.raw } : {}),
      });
    }

    const id = request.id ?? `decision-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result: DecisionResult = {
      id,
      model: request.model,
      mode: request.mode,
      decisions: answers,
      latencyMs: Math.max(0, Date.now() - started),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    this.opts.onDecide?.(request, result);
    return result;
  }
}
