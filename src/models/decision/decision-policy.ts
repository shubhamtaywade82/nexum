/**
 * Decision policy — converts structured model evidence (probabilities /
 * scores / selected ids) into a deterministic operational action.
 *
 * Policy is the only place thresholds are allowed. The hard rule (see the
 * integration prompt §12) is: do NOT hard-code arbitrary thresholds
 * throughout the codebase. Every decision consumer reads its threshold from
 * a {@link DecisionPolicy} object that the caller owns and can override.
 *
 * The default values in {@link defaultDecisionPolicy} are conservative
 * starting points, NOT a guess at optimal behavior. Wave 7's evaluation
 * harness is responsible for tuning them against real System One
 * probability distributions and recording the trade-off explicitly.
 */

import type { DecisionAnswer, DecisionResult } from "./types.js";

export interface DecisionPolicy {
  /**
   * Minimum per-choice probability required for a domain to be considered
   * eligible. Applied to the `probabilities` map of a choice/noul decision;
   * ignored for `score` mode (the question's score is the value the caller
   * compares to its own threshold).
   */
  minimumProbability: number;
  /**
   * Maximum number of domains/choices the policy will keep, regardless of
   * how many clear the threshold. Bounds the active-tool set so a
   * probabilistic-leaning model cannot manufacture "every tool is needed".
   */
  maxDomains: number;
}

/**
 * Conservative defaults. Not "optimal" — they are the values the Wave 7
 * evaluation harness is expected to retune. Documenting the trade-off here
 * keeps the magic numbers honest.
 */
export const defaultDecisionPolicy: DecisionPolicy = {
  // 0.5 — a majority threshold. Below this, the model is more uncertain
  // than not, and the caller should treat the domain as ineligible.
  minimumProbability: 0.5,
  // 4 — bounds the active-tool set without making System One manufacture
  // work. A 2B-parameter decision model rarely has useful evidence for
  // more than a handful of domains per request.
  maxDomains: 4,
};

/**
 * Apply the policy to a single-question choice/noul {@link DecisionResult}
 * and return the deterministic list of selected domain ids, ordered by
 * descending probability.
 *
 * Rules:
 *   1. If `probabilities` are present on the decision, use them — a
 *      `selected` id alone is treated as a weaker signal and ignored when
 *      probabilities are available. The model's structured evidence is the
 *      authoritative input; a free `selected` string is not.
 *   2. Otherwise (probabilities absent), fall back to the `selected` id
 *      iff one is present.
 *   3. Filter out probabilities below {@link DecisionPolicy.minimumProbability}.
 *   4. Sort the survivors by descending probability.
 *   5. Truncate to {@link DecisionPolicy.maxDomains}.
 *
 * Returns `[]` when no domain clears the threshold — NO_ACTION is a
 * first-class valid outcome (see §13 of the integration prompt).
 */
export function applyDecisionPolicy(result: DecisionResult, policy: DecisionPolicy = defaultDecisionPolicy): string[] {
  if (!result.decisions || result.decisions.length === 0) return [];

  const eligible: Array<{ id: string; prob: number }> = [];
  for (const decision of result.decisions as DecisionAnswer[]) {
    if (decision.probabilities && Object.keys(decision.probabilities).length > 0) {
      for (const [id, prob] of Object.entries(decision.probabilities)) {
        if (typeof prob === "number" && Number.isFinite(prob) && prob >= policy.minimumProbability) {
          eligible.push({ id, prob });
        }
      }
    } else if (decision.selected) {
      // No probabilities — treat the selected id as probability 1.0 so it
      // always clears a finite threshold (we are taking the model at its
      // word, with no extra evidence to weigh).
      eligible.push({ id: decision.selected, prob: 1 });
    }
  }

  // Stable sort by descending probability; ties keep insertion order so the
  // policy is deterministic regardless of object key enumeration order.
  eligible.sort((a, b) => b.prob - a.prob);

  return eligible.slice(0, Math.max(0, policy.maxDomains)).map((e) => e.id);
}
