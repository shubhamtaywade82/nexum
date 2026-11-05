import {
  applyDecisionPolicy,
  defaultDecisionPolicy,
  DecisionPolicy,
} from "../../../src/models/decision/decision-policy.js";
import type { DecisionResult } from "../../../src/models/decision/types.js";

function choiceResult(probabilities: Record<string, number>, model = "m"): DecisionResult {
  return {
    id: "d1",
    model,
    mode: "choice",
    decisions: [{ questionId: "domain", probabilities }],
    latencyMs: 12,
  };
}

describe("applyDecisionPolicy", () => {
  it("selects all domains whose probability meets the minimum threshold, ordered by probability desc", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };
    const result = choiceResult({ filesystem: 0.9, shell: 0.4, git: 0.7 });
    const selected = applyDecisionPolicy(result, policy);
    expect(selected).toEqual(["filesystem", "git"]);
  });

  it("returns an empty list when every probability is below the threshold (NO_TOOLS)", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };
    const result = choiceResult({ filesystem: 0.1, shell: 0.2, git: 0.3 });
    expect(applyDecisionPolicy(result, policy)).toEqual([]);
  });

  it("bounds the selected domain set to maxDomains", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.0, maxDomains: 2 };
    const result = choiceResult({ a: 0.1, b: 0.9, c: 0.8, d: 0.7, e: 0.6 });
    const selected = applyDecisionPolicy(result, policy);
    expect(selected).toHaveLength(2);
    expect(selected).toEqual(["b", "c"]);
  });

  it("uses the deterministic selected field for non-probabilistic choice decisions", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };
    const result: DecisionResult = {
      id: "d1",
      model: "m",
      mode: "choice",
      decisions: [{ questionId: "domain", selected: "filesystem" }],
      latencyMs: 1,
    };
    expect(applyDecisionPolicy(result, policy)).toEqual(["filesystem"]);
  });

  it("ignores probabilities below the minimum even if a selected field is present", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };
    const result: DecisionResult = {
      id: "d1",
      model: "m",
      mode: "choice",
      decisions: [{ questionId: "domain", selected: "filesystem", probabilities: { filesystem: 0.2 } }],
      latencyMs: 1,
    };
    // Both `selected` and probabilities present: probability wins as evidence,
    // and the threshold filters it out — selected alone is never sufficient
    // when probabilities exist (they are the stronger, machine-readable signal).
    expect(applyDecisionPolicy(result, policy)).toEqual([]);
  });

  it("returns [] when the result has no decisions", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };
    const result: DecisionResult = {
      id: "d1",
      model: "m",
      mode: "choice",
      decisions: [],
      latencyMs: 1,
    };
    expect(applyDecisionPolicy(result, policy)).toEqual([]);
  });

  it("does not mutate the input result", () => {
    const policy: DecisionPolicy = { minimumProbability: 0.0, maxDomains: 5 };
    const result = choiceResult({ a: 0.4, b: 0.9 });
    const snapshot = JSON.stringify(result);
    applyDecisionPolicy(result, policy);
    expect(JSON.stringify(result)).toBe(snapshot);
  });
});

describe("defaultDecisionPolicy", () => {
  it("exposes conservative defaults that can be tuned by tests/benchmarks", () => {
    // Default values are NOT a guess at optimal behavior — they are
    // conservative starting points the Wave 7 evaluation harness is expected
    // to retune with real System One probability distributions. The shape of
    // the policy is what's locked here, not the magic numbers.
    expect(defaultDecisionPolicy).toEqual({
      minimumProbability: expect.any(Number),
      maxDomains: expect.any(Number),
    });
    expect(defaultDecisionPolicy.minimumProbability).toBeGreaterThan(0);
    expect(defaultDecisionPolicy.minimumProbability).toBeLessThanOrEqual(1);
    expect(defaultDecisionPolicy.maxDomains).toBeGreaterThanOrEqual(1);
  });
});
