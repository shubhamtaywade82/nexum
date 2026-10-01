import { FakeDecisionGateway } from "../../../src/models/decision/fake-gateway.js";
import { DecisionPolicyError, DecisionProtocolError } from "../../../src/models/decision/errors.js";
import type { DecisionRequest, DecisionResult } from "../../../src/models/decision/types.js";

// FakeDecisionGateway is the test/injected form of DecisionGateway used by
// every consumer that does not want to talk to a real Ollama System One
// endpoint. It also serves as the reference for how a real gateway must
// behave: it owns no model state, surfaces typed decision errors, and
// records enough metadata to be observable (Wave 7 telemetry will hook here).

function choiceRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: "d1",
    model: "mpuig/system-one-minicpm5-2b-q8",
    mode: "choice",
    context: "User asked: 'read config.json and patch a typo'.",
    questions: [
      {
        id: "domain",
        prompt: "Which domain best matches this request?",
        choices: [
          { id: "filesystem", description: "read/write/patch files" },
          { id: "shell", description: "run shell commands" },
          { id: "git", description: "git operations" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("FakeDecisionGateway", () => {
  it("decides a choice request using the scripted answer map", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: { selected: "filesystem", probabilities: { filesystem: 0.92, shell: 0.05, git: 0.03 } },
      },
    });

    const result = await fake.decide(choiceRequest());

    expect(result.model).toBe("mpuig/system-one-minicpm5-2b-q8");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].questionId).toBe("domain");
    expect(result.decisions[0].selected).toBe("filesystem");
    expect(result.decisions[0].probabilities?.filesystem).toBe(0.92);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a decision id matching the request id when supplied", async () => {
    const fake = new FakeDecisionGateway({ decisions: { domain: { selected: "filesystem" } } });
    const result = await fake.decide(choiceRequest({ id: "decision-abc" }));
    expect(result.id).toBe("decision-abc");
  });

  it("synthesizes a decision id when none was supplied", async () => {
    const fake = new FakeDecisionGateway({ decisions: { domain: { selected: "filesystem" } } });
    const req = choiceRequest();
    delete req.id;
    const result = await fake.decide(req);
    expect(result.id).toMatch(/^decision-/);
  });

  it("throws DecisionProtocolError when no scripted answer exists for a question", async () => {
    const fake = new FakeDecisionGateway({ decisions: {} });
    await expect(fake.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a scripted selected id is not in the question choices", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "super_search_repo" } },
    });
    await expect(fake.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("records each call on the optional onDecide hook for telemetry replay", async () => {
    const calls: DecisionRequest[] = [];
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      onDecide: (req) => calls.push(req),
    });
    await fake.decide(choiceRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("d1");
  });

  it("can be programmed to reject with a typed decision error for failure-injection tests", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      failWith: new DecisionPolicyError("threshold not met", "domain"),
    });
    await expect(fake.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionPolicyError);
  });

  it("records scripted raw payload so callers can preserve model evidence", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem", raw: { model_logprob: -0.08 } } },
    });
    const result = await fake.decide(choiceRequest());
    expect(result.decisions[0].raw).toEqual({ model_logprob: -0.08 });
  });

  it("returns a DecisionResult typed value, not a raw object", async () => {
    const fake = new FakeDecisionGateway({ decisions: { domain: { selected: "filesystem" } } });
    const result: DecisionResult = await fake.decide(choiceRequest());
    expect(Array.isArray(result.decisions)).toBe(true);
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("latencyMs");
  });
});
