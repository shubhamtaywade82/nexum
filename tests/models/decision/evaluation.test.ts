import {
  DecisionEvaluationFixture,
  DecisionEvaluationResult,
  DecisionEvaluationSummary,
  evaluateDecisionGateway,
} from "../../../src/models/decision/evaluation.js";
import { FakeDecisionGateway } from "../../../src/models/decision/fake-gateway.js";
import type { DecisionPolicy } from "../../../src/models/decision/decision-policy.js";
import { TOOL_DOMAIN_FIXTURES, NO_ACTION_FIXTURES } from "../../../src/models/decision/evaluation-fixtures.js";

// ── Evaluation harness ─────────────────────────────────────────────────────
// The harness runs a list of (request, expected) fixtures against a
// decision gateway, computes per-fixture pass/fail and aggregate metrics
// (accuracy, false-positive rate, false-negative rate, average latency,
// fallback rate). It does NOT add arbitrary confidence-score claims — the
// metrics are computed from the fixture pass/fail, not from the model's
// probabilities (which are inputs to policy, not guarantees of correctness).

const POLICY: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };

describe("evaluateDecisionGateway — aggregate metrics", () => {
  it("computes 100% accuracy when every fixture's expected outcome matches the gateway's actual outcome", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: { selected: "filesystem", probabilities: { filesystem: 0.9, shell: 0.05, git: 0.05 } },
      },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "fs-1",
        category: "tool-domain-classification",
        description: "filesystem request",
        request: {
          id: "fs-1",
          model: "m",
          mode: "choice",
          context: "read a file",
          questions: [
            {
              id: "domain",
              prompt: "x",
              choices: [
                { id: "filesystem", description: "fs" },
                { id: "shell", description: "sh" },
                { id: "git", description: "git" },
              ],
            },
          ],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const summary: DecisionEvaluationSummary = await evaluateDecisionGateway(fake, fixtures, POLICY);

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.accuracy).toBe(1);
    expect(summary.falsePositiveRate).toBe(0);
    expect(summary.falseNegativeRate).toBe(0);
    expect(summary.fallbackRate).toBe(0);
  });

  it("computes 0% accuracy when the gateway's selected set differs from expected", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: { selected: "shell", probabilities: { shell: 0.95, filesystem: 0.05 } },
      },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "fs-1",
        category: "tool-domain-classification",
        description: "expected filesystem, got shell",
        request: {
          id: "fs-1",
          model: "m",
          mode: "choice",
          context: "read a file",
          questions: [
            {
              id: "domain",
              prompt: "x",
              choices: [
                { id: "filesystem", description: "fs" },
                { id: "shell", description: "sh" },
              ],
            },
          ],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const summary = await evaluateDecisionGateway(fake, fixtures, POLICY);
    expect(summary.passed).toBe(0);
    expect(summary.accuracy).toBe(0);
  });

  it("counts fallback (gateway failure) per-fixture and aggregates as fallbackRate", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      // Force every call to fail so the harness records fallbacks.
      failWith: new (class extends Error {
        constructor() {
          super("simulated outage");
          this.name = "DecisionTransportError";
        }
      })() as never,
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "f-1",
        category: "tool-domain-classification",
        description: "outage fixture",
        request: {
          id: "f-1",
          model: "m",
          mode: "choice",
          context: "x",
          questions: [{ id: "domain", prompt: "x", choices: [{ id: "fs", description: "fs" }] }],
        },
        expectedSelected: ["filesystem"],
      },
      {
        id: "f-2",
        category: "tool-domain-classification",
        description: "outage fixture 2",
        request: {
          id: "f-2",
          model: "m",
          mode: "choice",
          context: "y",
          questions: [{ id: "domain", prompt: "y", choices: [{ id: "fs", description: "fs" }] }],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const summary = await evaluateDecisionGateway(fake, fixtures, POLICY);
    expect(summary.total).toBe(2);
    expect(summary.fallbacks).toBe(2);
    expect(summary.fallbackRate).toBe(1);
    // Fallback fixtures are not "passed" — the gateway did not produce the
    // expected evidence.
    expect(summary.passed).toBe(0);
    expect(summary.accuracy).toBe(0);
  });

  it("averages latency across fixtures (latency is reported, not used to grade)", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "l-1",
        category: "tool-domain-classification",
        description: "latency A",
        request: {
          id: "l-1",
          model: "m",
          mode: "choice",
          context: "x",
          questions: [{ id: "domain", prompt: "x", choices: [{ id: "filesystem", description: "fs" }] }],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const summary = await evaluateDecisionGateway(fake, fixtures, POLICY);
    expect(summary.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof summary.avgLatencyMs).toBe("number");
  });

  it("does not add arbitrary confidence-score claims — only counts pass/fail", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem", probabilities: { filesystem: 0.55, shell: 0.45 } } },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "c-1",
        category: "tool-domain-classification",
        description: "low-margin win still counts as a pass when selected matches expected",
        request: {
          id: "c-1",
          model: "m",
          mode: "choice",
          context: "x",
          questions: [
            {
              id: "domain",
              prompt: "x",
              choices: [
                { id: "filesystem", description: "fs" },
                { id: "shell", description: "sh" },
              ],
            },
          ],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const summary = await evaluateDecisionGateway(fake, fixtures, POLICY);
    // The model's 0.55 vs 0.45 margin is NOT a confidence score we report.
    // Pass/fail is decided by whether the policy-derived selected set
    // matches the fixture's expectedSelected. Probabilities are inputs to
    // policy, not guarantees of correctness.
    expect(summary.passed).toBe(1);
    expect(summary.accuracy).toBe(1);
    expect(summary).not.toHaveProperty("confidence");
  });
});

describe("evaluateDecisionGateway — false-positive and false-negative rates", () => {
  it("counts a false positive when the gateway selects an unexpected domain that the fixture expected NOT to select", async () => {
    // NO_ACTION fixture: expected empty. Gateway selects 'filesystem'.
    // The harness counts this as a false positive (selected something
    // that should have been absent).
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: { selected: "filesystem", probabilities: { filesystem: 0.9 } },
      },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "no-1",
        category: "no-action",
        description: "hello world — no tools expected",
        request: {
          id: "no-1",
          model: "m",
          mode: "noul",
          context: "hello world",
          questions: [
            {
              id: "domain",
              prompt: "x",
              choices: [{ id: "filesystem", description: "fs" }],
            },
          ],
        },
        expectedSelected: [],
      },
    ];

    const summary = await evaluateDecisionGateway(fake, fixtures, POLICY);
    expect(summary.passed).toBe(0);
    expect(summary.falsePositiveRate).toBe(1);
    expect(summary.falseNegativeRate).toBe(0);
  });

  it("counts a false negative when the gateway returns no selection but the fixture expected one", async () => {
    // System One returns no domain above threshold (probabilities low);
    // the fixture expected 'filesystem'. False negative — missed a real
    // signal.
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: { probabilities: { filesystem: 0.1, shell: 0.1 } },
      },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "fn-1",
        category: "tool-domain-classification",
        description: "expected filesystem but got nothing",
        request: {
          id: "fn-1",
          model: "m",
          mode: "choice",
          context: "read a file",
          questions: [
            {
              id: "domain",
              prompt: "x",
              choices: [
                { id: "filesystem", description: "fs" },
                { id: "shell", description: "sh" },
              ],
            },
          ],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const summary = await evaluateDecisionGateway(fake, fixtures, POLICY);
    expect(summary.passed).toBe(0);
    expect(summary.falseNegativeRate).toBe(1);
    expect(summary.falsePositiveRate).toBe(0);
  });
});

describe("DecisionEvaluationResult — per-fixture detail", () => {
  it("carries expected, actual, passed, latencyMs, and fallback flag per fixture", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
    });
    const fixtures: DecisionEvaluationFixture[] = [
      {
        id: "d-1",
        category: "tool-domain-classification",
        description: "x",
        request: {
          id: "d-1",
          model: "m",
          mode: "choice",
          context: "x",
          questions: [
            {
              id: "domain",
              prompt: "x",
              choices: [{ id: "filesystem", description: "fs" }],
            },
          ],
        },
        expectedSelected: ["filesystem"],
      },
    ];

    const results: DecisionEvaluationResult[] = [];
    for await (const r of evaluateDecisionGatewayDetailed(fake, fixtures, POLICY)) {
      results.push(r);
    }
    expect(results).toHaveLength(1);
    expect(results[0].fixtureId).toBe("d-1");
    expect(results[0].expected).toEqual(["filesystem"]);
    expect(results[0].actual).toEqual(["filesystem"]);
    expect(results[0].passed).toBe(true);
    expect(results[0].fallback).toBe(false);
    expect(typeof results[0].latencyMs).toBe("number");
  });
});

// Helper: iterate per-fixture results. The harness exposes this through the
// summary's perFixture field; the test above re-derives for clarity.
async function* evaluateDecisionGatewayDetailed(
  gw: {
    decide(
      req: import("../../../src/models/decision/types.js").DecisionRequest,
    ): Promise<import("../../../src/models/decision/types.js").DecisionResult>;
  },
  fixtures: DecisionEvaluationFixture[],
  policy: DecisionPolicy,
): AsyncGenerator<DecisionEvaluationResult> {
  const summary = await evaluateDecisionGateway(gw, fixtures, policy);
  for (const r of summary.perFixture) yield r;
}

// ── Fixtures catalog ───────────────────────────────────────────────────────

describe("Built-in evaluation fixtures", () => {
  it("TOOL_DOMAIN_FIXTURES covers the prompt's tool-domain classification cases", () => {
    expect(TOOL_DOMAIN_FIXTURES.length).toBeGreaterThan(0);
    const ids = TOOL_DOMAIN_FIXTURES.map((f) => f.id);
    expect(ids).toContain("tool-domain-filesystem");
    expect(ids).toContain("tool-domain-shell");
    expect(ids).toContain("tool-domain-git");
  });

  it("NO_ACTION_FIXTURES covers conceptual / greeting prompts where NO_TOOLS is the correct answer", () => {
    expect(NO_ACTION_FIXTURES.length).toBeGreaterThan(0);
    const contexts = NO_ACTION_FIXTURES.map((f) => f.request.context);
    expect(contexts.some((c) => /hello|hi\b/i.test(c))).toBe(true);
    expect(contexts.some((c) => /what is/i.test(c))).toBe(true);
    // Every NO_ACTION fixture expects an empty selected set.
    for (const f of NO_ACTION_FIXTURES) expect(f.expectedSelected).toEqual([]);
  });
});
