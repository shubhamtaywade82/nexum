/**
 * DecisionRoutingHintResolver — System One as an ambiguity resolver for
 * the existing HeuristicRouter, NOT a replacement.
 *
 * Architecture (integration prompt §14):
 *
 *   deterministic heuristic (HeuristicRouter.classify)
 *      │
 *      ├── obvious (local|cloud) → deterministic decision (via='heuristic')
 *      │
 *      └── ambiguous ('unknown')
 *            │
 *            ▼
 *       System One (one bounded question: local | cloud, noul mode)
 *            │
 *            ▼
 *       decision policy (threshold + maxDomains)
 *            │
 *            ├── local|cloud above threshold → via='decision'
 *            │
 *            └── no clear winner / System One failure → via='fallback'
 *
 * The resolver returns a `RoutingHint` — a small structured object. It is
 * NOT a Router and does NOT call Provider.chat. The existing Router still
 * owns model routing; this is an OPTIONAL hint source the agent runtime
 * may consult when the heuristic returns 'unknown'.
 *
 * ── Why 'noul' mode ──────────────────────────────────────────────────────
 *
 * System One's 'noul' mode permits "none of the above" as a legitimate
 * answer. When the model has no real signal that the request needs a
 * stronger tier, returning 'unknown' (via 'fallback') is the honest
 * answer — never a forced guess. The existing Router/agent-runtime then
 * proceeds with its existing 'unknown' behavior (SelfConsistency, etc.).
 *
 * ── Backward compatibility ──────────────────────────────────────────────
 *
 * The resolver is opt-in: a caller that does not construct it gets the
 * existing deterministic heuristic behavior unchanged.
 */

import {
  DecisionError,
  DecisionGateway,
  DecisionPolicy,
  DecisionResult,
  applyDecisionPolicy,
  defaultDecisionPolicy,
} from "../decision/index.js";
import { HeuristicRouter, HeuristicResult } from "./heuristic-router.js";

/** Bounded tier choice the resolver asks System One about. */
export type RoutingTier = "local" | "cloud";

/** The hint returned to the caller. NOT a routing action. */
export interface RoutingHint {
  /** Final tier decision. 'unknown' when both the heuristic and System
   *  One were unable to resolve the ambiguity. */
  decision: RoutingTier | "unknown";
  /** Where the decision came from: 'heuristic' (deterministic, no System
   *  One call), 'decision' (System One resolved the ambiguity), 'fallback'
   *  (System One was consulted but did not resolve — preserves 'unknown'). */
  via: "heuristic" | "decision" | "fallback";
  /** Raw DecisionResult when System One was consulted (for telemetry/replay). */
  raw?: DecisionResult;
}

export interface DecisionRoutingHintResolverOptions {
  heuristicRouter: HeuristicRouter;
  /** The Decision Plane gateway; undefined disables System One (always
   *  falls through to 'unknown' on ambiguous prompts). */
  decisionGateway?: DecisionGateway;
  /** Dedicated decision model (independent of the primary generation model). */
  decisionModel: string;
  /** Decision policy applied to the System One probabilities. */
  decisionPolicy?: DecisionPolicy;
}

const ROUTING_QUESTION_ID = "tier";
const DEFAULT_DECISION_MODEL = "mpuig/system-one-minicpm5-2b-q8";

export class DecisionRoutingHintResolver {
  private readonly heuristicRouter: HeuristicRouter;
  private readonly decisionGateway: DecisionGateway | undefined;
  private readonly decisionModel: string;
  private readonly decisionPolicy: DecisionPolicy;

  constructor(opts: DecisionRoutingHintResolverOptions) {
    this.heuristicRouter = opts.heuristicRouter;
    this.decisionGateway = opts.decisionGateway;
    this.decisionModel = opts.decisionModel ?? DEFAULT_DECISION_MODEL;
    this.decisionPolicy = opts.decisionPolicy ?? defaultDecisionPolicy;
  }

  async resolve(prompt: string): Promise<RoutingHint> {
    // Stage 1: deterministic heuristic. The existing HeuristicRouter is the
    // first authority — its 'local'/'cloud' decisions are honored
    // outright and System One is NOT consulted.
    const heuristic: HeuristicResult = this.heuristicRouter.classify(prompt);
    if (heuristic.decision === "local" || heuristic.decision === "cloud") {
      return { decision: heuristic.decision, via: "heuristic" };
    }

    // Stage 2: ambiguous. If no gateway, return 'unknown' via 'fallback'
    // (the caller's existing 'unknown' behavior applies unchanged).
    if (!this.decisionGateway) {
      return { decision: "unknown", via: "fallback" };
    }

    let result: DecisionResult;
    try {
      result = await this.decisionGateway.decide({
        id: `routing-hint-${Date.now().toString(36)}`,
        model: this.decisionModel,
        mode: "noul",
        context: prompt.slice(0, 2000),
        questions: [
          {
            id: ROUTING_QUESTION_ID,
            prompt:
              "Does this request require a stronger cloud model, or can a small local model answer it? " +
              "Return 'none of the above' if there is no real signal either way.",
            choices: [
              { id: "local", description: "small local model can answer this" },
              { id: "cloud", description: "needs a stronger cloud model" },
            ],
          },
        ],
        metadata: { subsystem: "routing-hint" },
      });
    } catch (err) {
      // Any DecisionError → fall back to 'unknown'. System One is an
      // optimization, not the final authority.
      if (err instanceof DecisionError) return { decision: "unknown", via: "fallback" };
      throw err;
    }

    const selected = applyDecisionPolicy(result, this.decisionPolicy);
    if (selected.length === 0) {
      // No tier cleared the threshold — System One's "I don't know"
      // surfaces as 'unknown' via 'fallback'.
      return { decision: "unknown", via: "fallback", raw: result };
    }

    // The first selected id is the highest-probability tier. Both 'local'
    // and 'cloud' are valid System One choices (bounded by the choices
    // array); any other id is rejected by the gateway before this point.
    const top = selected[0];
    if (top !== "local" && top !== "cloud") {
      return { decision: "unknown", via: "fallback", raw: result };
    }

    return { decision: top, via: "decision", raw: result };
  }
}
