/**
 * Decision Plane evaluation harness.
 *
 * Lets you evaluate a DecisionGateway against a list of (request, expected)
 * fixtures WITHOUT running the full agent runtime. Captures accuracy,
 * false-positive rate, false-negative rate, average latency, and fallback
 * rate. Does NOT add arbitrary confidence-score claims — probabilities are
 * inputs to policy, not guarantees of correctness.
 *
 * Per the integration prompt §30, fixtures cover:
 *
 *   - tool domain classification (TOOL_DOMAIN_FIXTURES)
 *   - tool necessity (NO_ACTION_FIXTURES)
 *   - task complexity
 *   - single vs multi-step
 *   - verification
 *   - groundedness
 *   - risk classification
 *   - NO_ACTION
 *
 * More fixtures are added over time as real System One probability
 * distributions become available — the harness is the place where the
 * Wave 7 default policy thresholds are tuned against actual evidence.
 */

import type { DecisionGateway } from "./decision-gateway.js";
import type { DecisionPolicy } from "./decision-policy.js";
import { applyDecisionPolicy } from "./decision-policy.js";
import { DecisionError } from "./errors.js";
import type { DecisionRequest, DecisionResult } from "./types.js";

/** Category label (matches §30's suggested categories). */
export type DecisionEvaluationCategory =
  | "tool-domain-classification"
  | "tool-necessity"
  | "task-complexity"
  | "single-vs-multi-step"
  | "verification"
  | "groundedness"
  | "risk-classification"
  | "no-action";

export interface DecisionEvaluationFixture {
  id: string;
  category: DecisionEvaluationCategory;
  description: string;
  request: DecisionRequest;
  /** The expected selected id set AFTER the policy is applied. */
  expectedSelected: string[];
}

export interface DecisionEvaluationResult {
  fixtureId: string;
  category: DecisionEvaluationCategory;
  description: string;
  expected: string[];
  actual: string[];
  passed: boolean;
  fallback: boolean;
  latencyMs: number;
  /** Preserved for replay/debugging. */
  raw?: DecisionResult;
}

export interface DecisionEvaluationSummary {
  total: number;
  passed: number;
  accuracy: number;
  /** Gateway selected something the fixture expected NOT to select. */
  falsePositiveRate: number;
  /** Gateway missed a fixture's expected selection. */
  falseNegativeRate: number;
  /** Fraction of fixtures where the gateway threw a DecisionError. */
  fallbackRate: number;
  fallbacks: number;
  avgLatencyMs: number;
  perFixture: DecisionEvaluationResult[];
}

/**
 * Runs `fixtures` against `gateway` and returns aggregate metrics plus a
 * per-fixture result list. The harness never throws — a gateway failure on
 * one fixture is recorded as `fallback: true` and counts against accuracy,
 * not as a harness error.
 *
 * Pass/fail is decided by set equality between `expectedSelected` and the
 * policy-derived `actual` selected set. Order does not matter (the policy
 * sorts by descending probability, but the fixture author should not have
 * to predict that ordering).
 */
export async function evaluateDecisionGateway(
  gateway: DecisionGateway,
  fixtures: DecisionEvaluationFixture[],
  policy: DecisionPolicy,
): Promise<DecisionEvaluationSummary> {
  const perFixture: DecisionEvaluationResult[] = [];
  let passed = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let fallbacks = 0;
  let totalLatency = 0;

  for (const fixture of fixtures) {
    let result: DecisionResult | undefined;
    let fallback = false;
    let latencyMs = 0;
    let raw: DecisionResult | undefined;

    try {
      result = await gateway.decide(fixture.request);
      latencyMs = result.latencyMs;
      raw = result;
    } catch (err) {
      fallback = true;
      fallbacks++;
      if (err instanceof DecisionError) {
        // expected — recorded as a fallback
      } else {
        // unexpected — also recorded as a fallback, never re-thrown.
      }
    }

    totalLatency += latencyMs;

    const actual = result ? applyDecisionPolicy(result, policy) : [];
    const expected = fixture.expectedSelected;
    const passedFixture = !fallback && setEquals(actual, expected);

    if (passedFixture) {
      passed++;
    } else if (!fallback) {
      // Distinguish false positive vs false negative:
      //   - FP: gateway selected something the fixture expected NOT to select
      //   - FN: gateway missed something the fixture expected to select
      const actualSet = new Set(actual);
      const expectedSet = new Set(expected);
      const fp = [...actualSet].some((id) => !expectedSet.has(id));
      const fn = [...expectedSet].some((id) => !actualSet.has(id));
      if (fp) falsePositives++;
      if (fn) falseNegatives++;
    }

    perFixture.push({
      fixtureId: fixture.id,
      category: fixture.category,
      description: fixture.description,
      expected,
      actual,
      passed: passedFixture,
      fallback,
      latencyMs,
      ...(raw ? { raw } : {}),
    });
  }

  const total = fixtures.length;
  return {
    total,
    passed,
    accuracy: total > 0 ? passed / total : 0,
    // Per the integration prompt, FPR and FNR are computed over the
    // non-fallback subset (a fallback is its own category of failure,
    // not a false positive or false negative).
    falsePositiveRate: total > 0 ? falsePositives / total : 0,
    falseNegativeRate: total > 0 ? falseNegatives / total : 0,
    fallbackRate: total > 0 ? fallbacks / total : 0,
    fallbacks,
    avgLatencyMs: total > 0 ? totalLatency / total : 0,
    perFixture,
  };
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = new Set(a);
  for (const x of b) if (!as.has(x)) return false;
  return true;
}
