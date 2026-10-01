import { DecisionVerificationGate, VerificationGateHint } from "../../src/runtime/critic/decision-gate.js";
import { FakeDecisionGateway } from "../../src/models/decision/fake-gateway.js";
import { DecisionTransportError } from "../../src/models/decision/errors.js";
import type { DecisionPolicy } from "../../src/models/decision/decision-policy.js";

describe("DecisionVerificationGate — cheap decision gate before expensive critic", () => {
  it("escalates when System One says the answer is questionable with high probability", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        gate: { selected: "escalate", probabilities: { escalate: 0.85, accept: 0.15 } },
      },
    });
    const gate = new DecisionVerificationGate({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const hint = await gate.shouldEscalate({
      goal: "Fix the bug",
      draft: "I added a TODO marker here because I wasn't sure.",
    });

    expect(hint.escalate).toBe(true);
    expect(hint.via).toBe("decision");
  });

  it("does NOT escalate when System One says the answer is acceptable with high probability", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        gate: { selected: "accept", probabilities: { escalate: 0.1, accept: 0.92 } },
      },
    });
    const gate = new DecisionVerificationGate({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const hint = await gate.shouldEscalate({
      goal: "Fix the bug",
      draft: "I added a null check before the field access, matching the existing pattern.",
    });

    expect(hint.escalate).toBe(false);
    expect(hint.via).toBe("decision");
  });

  it("preserves the raw DecisionResult on the hint for telemetry/replay", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        gate: { selected: "escalate", probabilities: { escalate: 0.7, accept: 0.3 }, raw: { x: 1 } },
      },
    });
    const gate = new DecisionVerificationGate({ decisionGateway: fake, decisionModel: "m" });

    const hint = await gate.shouldEscalate({ goal: "x", draft: "y" });
    expect(hint.raw?.decisions[0].raw).toEqual({ x: 1 });
  });
});

describe("DecisionVerificationGate — fallback on System One failure", () => {
  it("escalates by default when System One throws (never silently accept on a failure)", async () => {
    // The prompt §26 failure policy: System One unavailable → escalate to
    // existing verifier/critic. The gate MUST NOT convert a System One
    // failure into "accept and skip verification" for a security-sensitive
    // decision. The safe default is to escalate.
    const fake = new FakeDecisionGateway({
      decisions: { gate: { selected: "accept" } },
      failWith: new DecisionTransportError("ECONNREFUSED"),
    });
    const gate = new DecisionVerificationGate({ decisionGateway: fake, decisionModel: "m" });

    const hint = await gate.shouldEscalate({ goal: "x", draft: "y" });
    expect(hint.escalate).toBe(true);
    expect(hint.via).toBe("fallback");
  });

  it("escalates by default when no decisionGateway is configured", async () => {
    const gate = new DecisionVerificationGate({ decisionModel: "m" });
    const hint = await gate.shouldEscalate({ goal: "x", draft: "y" });
    expect(hint.escalate).toBe(true);
    expect(hint.via).toBe("fallback");
  });

  it("escalates by default when System One returns no clear winner (noul 'I don't know')", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        gate: { selected: null, probabilities: { escalate: 0.4, accept: 0.4 } },
      },
    });
    const gate = new DecisionVerificationGate({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const hint = await gate.shouldEscalate({ goal: "x", draft: "y" });
    expect(hint.escalate).toBe(true);
    expect(hint.via).toBe("fallback");
  });
});

describe("DecisionVerificationGate — security invariants", () => {
  it("does not skip the deterministic verifier: 'escalate=false' is a hint to skip the EXPENSIVE critic, not verification", async () => {
    // The gate's contract (see the type definition) is that escalate=false
    // means "do not enter expensive CriticService/SelfCorrection". The
    // deterministic VerifierService is still required by the caller — this
    // gate cannot mark output safe by itself. This test locks the contract.
    const fake = new FakeDecisionGateway({
      decisions: { gate: { selected: "accept", probabilities: { accept: 0.95, escalate: 0.05 } } },
    });
    const gate = new DecisionVerificationGate({ decisionGateway: fake, decisionModel: "m" });

    const hint: VerificationGateHint = await gate.shouldEscalate({ goal: "x", draft: "y" });

    expect(hint.escalate).toBe(false);
    // The hint carries only escalate/via/raw — there is no "verified" or
    // "certified" field, because the gate cannot certify correctness.
    expect(Object.keys(hint).sort()).toEqual(["escalate", "raw", "via"].sort());
  });

  it("System One failure does not crash the agent runtime — the gate catches and returns a fallback hint", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { gate: { selected: "accept" } },
      failWith: new DecisionTransportError("system one unreachable"),
    });
    const gate = new DecisionVerificationGate({ decisionGateway: fake, decisionModel: "m" });

    // The gate must NEVER throw to its caller — a System One outage must
    // not break the agent. It returns a fallback hint instead.
    const hint = await gate.shouldEscalate({ goal: "x", draft: "y" });
    expect(hint.escalate).toBe(true);
    expect(hint.via).toBe("fallback");
  });
});

describe("DecisionVerificationGate — bounded choice shape", () => {
  it("uses a bounded choice question with exactly two options (escalate | accept)", async () => {
    const seen: Array<{ questions: Array<{ id: string; choices?: Array<{ id: string }> }> }> = [];
    const fake = new FakeDecisionGateway({
      decisions: { gate: { selected: "accept" } },
      onDecide: (req) => seen.push(req),
    });
    const gate = new DecisionVerificationGate({ decisionGateway: fake, decisionModel: "m" });

    await gate.shouldEscalate({ goal: "Fix the bug", draft: "Added a null check." });

    expect(seen).toHaveLength(1);
    const q = seen[0].questions[0];
    expect(q.id).toBe("gate");
    const choices = q.choices ?? [];
    expect(choices.map((c) => c.id).sort()).toEqual(["accept", "escalate"]);
  });

  it("uses mode 'noul' so System One may legitimately answer neither", async () => {
    const seen: Array<{ mode: string }> = [];
    const fake = new FakeDecisionGateway({
      decisions: { gate: { selected: "accept" } },
      onDecide: (req) => seen.push(req),
    });
    const gate = new DecisionVerificationGate({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 } as DecisionPolicy,
    });

    await gate.shouldEscalate({ goal: "x", draft: "y" });
    expect(seen[0].mode).toBe("noul");
  });

  it("keeps the decision context compact (goal + draft, truncated)", async () => {
    let seenContext: string | undefined;
    const fake = new FakeDecisionGateway({
      decisions: { gate: { selected: "accept" } },
      onDecide: (req) => {
        seenContext = req.context;
      },
    });
    const gate = new DecisionVerificationGate({ decisionGateway: fake, decisionModel: "m" });

    await gate.shouldEscalate({
      goal: "x".repeat(5000),
      draft: "y".repeat(5000),
    });

    // Compact: not the full 10000 chars; truncated well below the 64 KiB
    // System One limit and the prompt-size that would dominate latency.
    expect(seenContext!.length).toBeLessThan(3000);
  });
});
