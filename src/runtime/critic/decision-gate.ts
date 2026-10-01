/**
 * DecisionVerificationGate — a cheap bounded decision gate placed BEFORE
 * the expensive CriticService/SelfCorrection path.
 *
 * Architecture (integration prompt §15):
 *
 *   draft
 *     │
 *     ▼
 *   DecisionVerificationGate (one bounded System One call)
 *     │
 *     ├── escalate=false → skip the expensive critic; the deterministic
 *     │                   VerifierService is still required by the caller
 *     │
 *     └── escalate=true  → enter CriticService → SelfCorrection →
 *                          deterministic verification (unchanged)
 *
 * ── What this gate is NOT ────────────────────────────────────────────────
 *
 * The gate does NOT certify correctness. It returns a hint with one bit of
 * information: "should this draft enter the expensive critic?". The
 * deterministic VerifierService is mandatory regardless — the gate is an
 * optimization that decides whether to ALSO run the heavy CriticService.
 *
 * The existing Verifier / CriticService / SelfCorrectionLoop are untouched
 * and remain authoritative. System One cannot, by construction, mark an
 * unsafe output valid — the gate's hint shape carries only
 * `escalate`/`via`/`raw`, no `verified`/`certified`/`approved` field.
 *
 * ── Failure policy ───────────────────────────────────────────────────────
 *
 * On any DecisionError or inconclusive System One answer, the gate
 * escalates by default — never silently accept. The prompt §26 rule is
 * explicit: System One failure on a security-sensitive decision must not
 * become "execute anyway". The safe default is to escalate to the existing
 * verifier/critic.
 */

import {
  DecisionError,
  DecisionGateway,
  DecisionPolicy,
  DecisionResult,
  applyDecisionPolicy,
  defaultDecisionPolicy,
} from "../../models/decision/index.js";

/** The hint returned to the caller. NOT a verification verdict. */
export interface VerificationGateHint {
  /**
   * Whether the caller should enter the expensive CriticService/
   * SelfCorrection path. When false, the caller MUST still run the
   * deterministic VerifierService — that is non-negotiable and outside
   * this gate's responsibility.
   */
  escalate: boolean;
  /**
   * 'decision' — System One returned a clear answer.
   * 'fallback' — System One failed or was inconclusive; the gate
   *              escalated by default (the safe choice).
   */
  via: "decision" | "fallback";
  /** Raw DecisionResult when System One was consulted (for telemetry/replay). */
  raw?: DecisionResult;
}

export interface DecisionVerificationGateOptions {
  decisionGateway?: DecisionGateway;
  decisionModel: string;
  decisionPolicy?: DecisionPolicy;
  /** Maximum chars of the goal+draft the gate forwards to System One. */
  maxContextChars?: number;
}

const GATE_QUESTION_ID = "gate";
const DEFAULT_DECISION_MODEL = "mpuig/system-one-minicpm5-2b-q8";
const DEFAULT_MAX_CONTEXT_CHARS = 2400;

export class DecisionVerificationGate {
  private readonly decisionGateway: DecisionGateway | undefined;
  private readonly decisionModel: string;
  private readonly decisionPolicy: DecisionPolicy;
  private readonly maxContextChars: number;

  constructor(opts: DecisionVerificationGateOptions) {
    this.decisionGateway = opts.decisionGateway;
    this.decisionModel = opts.decisionModel ?? DEFAULT_DECISION_MODEL;
    this.decisionPolicy = opts.decisionPolicy ?? defaultDecisionPolicy;
    this.maxContextChars = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  }

  /**
   * Asks System One a single bounded question: should this draft enter the
   * expensive critic? Never throws — any failure surfaces as
   * `escalate=true, via='fallback'`, so a System One outage never breaks
   * the agent runtime.
   */
  async shouldEscalate(task: { goal: string; input?: string }): Promise<VerificationGateHint> {
    const goal = (task.goal ?? "").slice(0, this.maxContextChars / 2);
    const draft = (task.input ?? "").slice(0, this.maxContextChars / 2);
    const context = `Task goal: ${goal}\nDraft answer: ${draft}`;

    if (!this.decisionGateway) {
      return { escalate: true, via: "fallback" };
    }

    let result: DecisionResult;
    try {
      result = await this.decisionGateway.decide({
        id: `verification-gate-${Date.now().toString(36)}`,
        model: this.decisionModel,
        mode: "noul",
        context,
        questions: [
          {
            id: GATE_QUESTION_ID,
            prompt:
              "Does this draft answer appear to need expensive critique, or is it acceptable as-is? " +
              "Return 'none of the above' if there is no real signal either way.",
            choices: [
              { id: "accept", description: "the draft is acceptable as-is" },
              { id: "escalate", description: "the draft needs critique" },
            ],
          },
        ],
        metadata: { subsystem: "verification-gate" },
      });
    } catch (err) {
      // Any DecisionError → escalate by default. The gate NEVER silently
      // accepts on a System One outage.
      if (err instanceof DecisionError) return { escalate: true, via: "fallback" };
      throw err;
    }

    const selected = applyDecisionPolicy(result, this.decisionPolicy);
    if (selected.length === 0) {
      // No clear winner — escalate by default (the safe choice).
      return { escalate: true, via: "fallback", raw: result };
    }

    const top = selected[0];
    if (top === "accept") {
      return { escalate: false, via: "decision", raw: result };
    }
    // 'escalate' (the only other valid choice) OR an unexpected id that
    // passed the policy but is neither 'accept' nor 'escalate'. The
    // gateway has already bounded the choice set, but be defensive.
    return { escalate: true, via: "decision", raw: result };
  }
}
