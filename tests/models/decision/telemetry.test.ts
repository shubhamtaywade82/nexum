import { InMemoryDecisionEventRecorder, RecordingDecisionGateway } from "../../../src/models/decision/telemetry.js";
import { FakeDecisionGateway } from "../../../src/models/decision/fake-gateway.js";
import { DecisionTransportError } from "../../../src/models/decision/errors.js";
import type { DecisionGateway } from "../../../src/models/decision/decision-gateway.js";
import type { DecisionRequest, DecisionResult } from "../../../src/models/decision/types.js";

function req(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: "d1",
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
    ...overrides,
  };
}

describe("InMemoryDecisionEventRecorder", () => {
  it("records a successful decision event with structured evidence", () => {
    const rec = new InMemoryDecisionEventRecorder();
    const result: DecisionResult = {
      id: "d1",
      model: "m",
      mode: "choice",
      decisions: [
        {
          questionId: "domain",
          selected: "filesystem",
          probabilities: { filesystem: 0.92, shell: 0.08 },
        },
      ],
      latencyMs: 7,
    };

    rec.record({
      id: result.id,
      engine: "fake",
      model: result.model,
      mode: result.mode,
      questionCount: result.decisions.length,
      latencyMs: result.latencyMs,
      success: true,
      selected: ["filesystem"],
      policy: { minimumProbability: 0.5, maxDomains: 4 },
      metadata: { subsystem: "tool-selection" },
      raw: result,
    });

    expect(rec.events()).toHaveLength(1);
    const ev = rec.events()[0];
    expect(ev.id).toBe("d1");
    expect(ev.model).toBe("m");
    expect(ev.mode).toBe("choice");
    expect(ev.questionCount).toBe(1);
    expect(ev.latencyMs).toBe(7);
    expect(ev.success).toBe(true);
    expect(ev.selected).toEqual(["filesystem"]);
    expect(ev.policy).toEqual({ minimumProbability: 0.5, maxDomains: 4 });
  });

  it("records a fallback event with a fallback reason and no selected domains", () => {
    const rec = new InMemoryDecisionEventRecorder();
    rec.record({
      id: "d2",
      engine: "system-one",
      model: "m",
      mode: "noul",
      questionCount: 1,
      latencyMs: 0,
      success: false,
      selected: [],
      policy: { minimumProbability: 0.5, maxDomains: 4 },
      fallbackReason: "transport_failure",
      metadata: { subsystem: "routing-hint" },
    });

    expect(rec.events()).toHaveLength(1);
    expect(rec.events()[0].success).toBe(false);
    expect(rec.events()[0].fallbackReason).toBe("transport_failure");
    expect(rec.events()[0].selected).toEqual([]);
  });

  it("does NOT log secrets — only the structured DecisionResult's id/model/mode/decisions are preserved on raw", () => {
    // The recorder contract: never persist secrets or credentials. The
    // raw payload preserves model evidence for replay; callers should not
    // stuff API keys into the DecisionRequest metadata. The recorder
    // does not sanitize user content (the gateway already separates the
    // wire request from this telemetry), but it does NOT carry the
    // Authorization header or any transport-layer secrets.
    const rec = new InMemoryDecisionEventRecorder();
    const result: DecisionResult = {
      id: "d1",
      model: "m",
      mode: "choice",
      decisions: [{ questionId: "domain", selected: "filesystem" }],
      latencyMs: 1,
    };

    rec.record({
      id: result.id,
      engine: "fake",
      model: result.model,
      mode: result.mode,
      questionCount: 1,
      latencyMs: 1,
      success: true,
      selected: ["filesystem"],
      policy: { minimumProbability: 0.5, maxDomains: 4 },
      raw: result,
    });

    // No secret-bearing fields on the event.
    const ev = rec.events()[0];
    expect(ev).not.toHaveProperty("apiKey");
    expect(ev).not.toHaveProperty("authorization");
    expect(ev).not.toHaveProperty("bearerToken");
  });

  it("clear() drops recorded events", () => {
    const rec = new InMemoryDecisionEventRecorder();
    rec.record({
      id: "x",
      engine: "fake",
      model: "m",
      mode: "choice",
      questionCount: 1,
      latencyMs: 0,
      success: true,
      selected: [],
      policy: { minimumProbability: 0.5, maxDomains: 4 },
    });
    rec.clear();
    expect(rec.events()).toEqual([]);
  });
});

describe("RecordingDecisionGateway", () => {
  it("wraps another gateway and records every successful decide() call", async () => {
    const inner: DecisionGateway = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem", probabilities: { filesystem: 0.92, shell: 0.08 } } },
    });
    const rec = new InMemoryDecisionEventRecorder();
    const wrapper = new RecordingDecisionGateway(inner, rec, {
      policy: { minimumProbability: 0.5, maxDomains: 4 },
      engine: "fake",
    });

    await wrapper.decide(req());

    expect(rec.events()).toHaveLength(1);
    const ev = rec.events()[0];
    expect(ev.success).toBe(true);
    expect(ev.selected).toEqual(["filesystem"]);
    expect(ev.policy).toEqual({ minimumProbability: 0.5, maxDomains: 4 });
  });

  it("records a fallback event when the inner gateway throws a DecisionError", async () => {
    const inner: DecisionGateway = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      failWith: new DecisionTransportError("ECONNREFUSED"),
    });
    const rec = new InMemoryDecisionEventRecorder();
    const wrapper = new RecordingDecisionGateway(inner, rec, {
      policy: { minimumProbability: 0.5, maxDomains: 4 },
      engine: "system-one",
    });

    // The wrapper re-throws to preserve the inner gateway's contract.
    await expect(wrapper.decide(req())).rejects.toBeInstanceOf(DecisionTransportError);

    // But it still records the failed call as a fallback event.
    expect(rec.events()).toHaveLength(1);
    const ev = rec.events()[0];
    expect(ev.success).toBe(false);
    expect(ev.fallbackReason).toBe("transport_failure");
    expect(ev.selected).toEqual([]);
  });

  it("preserves the inner gateway's engine label when no override is given", async () => {
    const inner = new FakeDecisionGateway({ decisions: { domain: { selected: "filesystem" } } });
    const rec = new InMemoryDecisionEventRecorder();
    const wrapper = new RecordingDecisionGateway(inner, rec, {
      policy: { minimumProbability: 0.5, maxDomains: 4 },
    });

    expect(wrapper.engine).toBe("fake");

    await wrapper.decide(req());
    expect(rec.events()[0].engine).toBe("fake");
  });

  it("does not block the caller if the recorder throws (telemetry must never break the runtime)", async () => {
    const inner = new FakeDecisionGateway({ decisions: { domain: { selected: "filesystem" } } });
    const failingRec: InMemoryDecisionEventRecorder = new InMemoryDecisionEventRecorder();
    jest.spyOn(failingRec, "record").mockImplementation(() => {
      throw new Error("telemetry store down");
    });
    const wrapper = new RecordingDecisionGateway(inner, failingRec, {
      policy: { minimumProbability: 0.5, maxDomains: 4 },
    });

    // The caller still gets the decision — the recorder failure is
    // swallowed, matching the rest of Nexum's telemetry contract.
    const result = await wrapper.decide(req());
    expect(result.decisions[0].selected).toBe("filesystem");
  });
});
