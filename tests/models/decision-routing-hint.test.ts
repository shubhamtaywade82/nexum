import { DecisionRoutingHintResolver, RoutingHint } from "../../src/models/router/decision-routing-hint.js";
import { HeuristicRouter } from "../../src/models/router/heuristic-router.js";
import { FakeDecisionGateway } from "../../src/models/decision/fake-gateway.js";
import { DecisionTransportError } from "../../src/models/decision/errors.js";

describe("DecisionRoutingHintResolver — heuristic stage", () => {
  it("returns the heuristic decision directly when it is 'local' (no System One call)", async () => {
    let called = 0;
    const fake = new FakeDecisionGateway({
      decisions: { tier: { selected: "local" } },
      onDecide: () => called++,
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });

    const hint = await resolver.resolve("generate a TypeScript interface for the user record");

    expect(hint.decision).toBe("local");
    expect(hint.via).toBe("heuristic");
    expect(called).toBe(0);
  });

  it("returns the heuristic decision directly when it is 'cloud'", async () => {
    let called = 0;
    const fake = new FakeDecisionGateway({
      decisions: { tier: { selected: "cloud" } },
      onDecide: () => called++,
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });

    // "why" is a CLOUD trigger in the existing heuristic.
    const hint = await resolver.resolve("why does this code deadlock on shutdown");

    expect(hint.decision).toBe("cloud");
    expect(hint.via).toBe("heuristic");
    expect(called).toBe(0);
  });
});

describe("DecisionRoutingHintResolver — ambiguous prompt reaches System One", () => {
  it("asks System One when the heuristic returns 'unknown' and resolves to a bounded tier", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { tier: { selected: "cloud", probabilities: { local: 0.2, cloud: 0.85 } } },
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });

    // No heuristic trigger matches; a short, simple prompt falls to "unknown".
    const hint = await resolver.resolve("summarize the workflow");

    expect(hint.decision).toBe("cloud");
    expect(hint.via).toBe("decision");
  });

  it("preserves the System One raw result on the hint for telemetry/replay", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        tier: { selected: "local", probabilities: { local: 0.7, cloud: 0.3 }, raw: { x: 1 } },
      },
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });

    const hint = await resolver.resolve("summarize the workflow");
    expect(hint.raw?.decisions[0].raw).toEqual({ x: 1 });
  });
});

describe("DecisionRoutingHintResolver — fallback on System One failure", () => {
  it("returns 'unknown' via 'fallback' when System One throws a transport error", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { tier: { selected: "local" } },
      failWith: new DecisionTransportError("ECONNREFUSED"),
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });

    const hint = await resolver.resolve("summarize the workflow");
    expect(hint.decision).toBe("unknown");
    expect(hint.via).toBe("fallback");
  });

  it("returns 'unknown' via 'fallback' when System One's probabilities are all below threshold", async () => {
    // The decision policy converts a low-probability answer to "no
    // selection"; the resolver treats that as "still ambiguous" and
    // returns 'unknown' via 'fallback', which is the honest answer: the
    // bounded decision did not resolve the ambiguity.
    const fake = new FakeDecisionGateway({
      decisions: { tier: { probabilities: { local: 0.1, cloud: 0.2 } } },
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const hint = await resolver.resolve("summarize the workflow");
    expect(hint.decision).toBe("unknown");
    expect(hint.via).toBe("fallback");
  });

  it("returns 'unknown' via 'fallback' when no decisionGateway is configured", async () => {
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionModel: "m",
    });

    const hint = await resolver.resolve("summarize the workflow");
    expect(hint.decision).toBe("unknown");
    expect(hint.via).toBe("fallback");
  });
});

describe("DecisionRoutingHintResolver — contract invariants", () => {
  it("does not replace the existing Router: it returns a hint the caller chooses to consult", async () => {
    // The resolver's return type is `RoutingHint`, not a ChatResponse or
    // Provider swap. The existing Router still owns model routing; this
    // is an OPTIONAL hint source. The test exists to lock that contract
    // against a future regression that "helpfully" replaces the router.
    const fake = new FakeDecisionGateway({ decisions: { tier: { selected: "local" } } });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });
    const hint: RoutingHint = await resolver.resolve("summarize the workflow");
    expect(hint).not.toHaveProperty("messages");
    expect(hint).not.toHaveProperty("provider");
    expect(hint).not.toHaveProperty("model");
    // The hint is a small structured object, not a routing action.
    expect(Object.keys(hint).sort()).toEqual(["decision", "raw", "via"].sort());
  });

  it("uses a bounded choice question with exactly two tiers (local | cloud)", async () => {
    const seen: Array<{ questions: Array<{ id: string; choices?: Array<{ id: string }> }> }> = [];
    const fake = new FakeDecisionGateway({
      decisions: { tier: { selected: "local" } },
      onDecide: (req) => seen.push(req),
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
    });

    await resolver.resolve("summarize the workflow");

    expect(seen).toHaveLength(1);
    const q = seen[0].questions[0];
    expect(q.id).toBe("tier");
    const choices = q.choices ?? [];
    expect(choices.map((c) => c.id).sort()).toEqual(["cloud", "local"]);
  });

  it("uses mode 'noul' so System One may legitimately answer neither tier (returns 'unknown' via fallback)", async () => {
    const seen: Array<{ mode: string }> = [];
    const fake = new FakeDecisionGateway({
      decisions: {
        // System One picks neither — noul mode permits a "none of the above".
        tier: { selected: null, probabilities: { local: 0.05, cloud: 0.05 } },
      },
      onDecide: (req) => seen.push(req),
    });
    const resolver = new DecisionRoutingHintResolver({
      heuristicRouter: new HeuristicRouter(),
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const hint = await resolver.resolve("summarize the workflow");

    expect(seen[0].mode).toBe("noul");
    // Neither tier cleared the threshold — System One's "I don't know"
    // surfaces as 'unknown' via 'fallback', not as a forced guess.
    expect(hint.decision).toBe("unknown");
    expect(hint.via).toBe("fallback");
  });
});
