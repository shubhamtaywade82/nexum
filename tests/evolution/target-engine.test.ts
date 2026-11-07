import { TargetEngine, capabilityAreaFor } from "../../src/evolution/targets/target-engine.js";
import { HarnessDiagnosis } from "../../src/evolution/types.js";

function diagnosis(partial: Partial<HarnessDiagnosis>): HarnessDiagnosis {
  return {
    failureClass: "tool_selection",
    component: "tools",
    evidence: [],
    confidence: 0.9,
    rootCause: "High tool error rate",
    proposedFix: "Prune tool schemas",
    expectedImpact: { capability: 0.06, reliability: 0.1, cost: -0.02 },
    ...partial,
  };
}

describe("TargetEngine", () => {
  const engine = new TargetEngine();

  it("forms a target that aggregates diagnoses by CAPABILITY, not by component", () => {
    const diagnoses = [
      diagnosis({ failureClass: "tool_selection", component: "tools", confidence: 0.9 }),
      diagnosis({ failureClass: "tool_argument_error", component: "tools", confidence: 0.85 }),
    ];
    const target = engine.formTarget(diagnoses);
    expect(target).not.toBeNull();
    expect(target!.capability).toBe("tool_utilization");
    expect(target!.desiredOutcome).toContain("Tool error rate drops");
    expect(target!.measurableMetrics).toContain("reliability.toolErrorRate");
  });

  it("answers 'what capability is failing?' with cross-component candidates (Aspire)", () => {
    // Symptom lives in tools, but the true cause could be context, routing, etc.
    const diagnoses = [diagnosis({ failureClass: "tool_selection", component: "tools", confidence: 0.95 })];
    const target = engine.formTarget(diagnoses)!;
    expect(target.affectedComponents).toContain("tools");
    // Cross-component candidates must be included for escalation paths.
    expect(target.affectedComponents).toContain("context");
    expect(target.affectedComponents).toContain("routing");
  });

  it("maps verification failures to verification_rigor with falseSuccessRate metric", () => {
    const diagnoses = [
      diagnosis({ failureClass: "premature_completion", component: "verification", confidence: 0.95 }),
      diagnosis({ failureClass: "verification_gap", component: "verification", confidence: 0.85 }),
    ];
    const target = engine.formTarget(diagnoses)!;
    expect(target.capability).toBe("verification_rigor");
    expect(target.measurableMetrics).toContain("reliability.falseSuccessRate");
  });

  it("includes an evaluation plan with visible AND held-out splits and a frozen executor", () => {
    const target = engine.formTarget([diagnosis({ confidence: 0.9 })])!;
    const splits = target.evaluationPlan.steps.map((s) => s.split);
    expect(splits).toContain("visible");
    expect(splits).toContain("held_out");
    expect(target.evaluationPlan.executorModels.length).toBeGreaterThan(0);
    expect(target.evaluationPlan.successCriterion).toContain("frozen executor");
  });

  it("returns null when evidence is too weak (prevents vague-target churn)", () => {
    const weak = [diagnosis({ confidence: 0.2 })];
    expect(engine.formTarget(weak)).toBeNull();
    expect(engine.formTarget([])).toBeNull();
  });

  it("corroborates across episodes: many medium-confidence diagnoses beat one loud one", () => {
    const manyMedium = [0.7, 0.7, 0.7, 0.7].map((c) =>
      diagnosis({ failureClass: "context_overflow", component: "context", confidence: c }),
    );
    const target = engine.formTarget([...manyMedium, diagnosis({ failureClass: "routing_failure", confidence: 0.9 })])!;
    expect(target.capability).toBe("context_quality");
  });

  it("does not let sub-threshold low-confidence diagnoses drown out eligible high-confidence targets", () => {
    // 20 diagnoses with mean confidence 0.30 (score 0.3 * sqrt(20) = 1.34) for "unknown"
    const manyWeak = Array.from({ length: 20 }, () =>
      diagnosis({ failureClass: "unknown", component: "orchestration", confidence: 0.3 }),
    );
    // 2 high-confidence diagnoses for tool_selection (score 0.85 * sqrt(2) = 1.20)
    const twoStrong = [
      diagnosis({ failureClass: "tool_selection", component: "tools", confidence: 0.85 }),
      diagnosis({ failureClass: "tool_selection", component: "tools", confidence: 0.85 }),
    ];
    const target = engine.formTarget([...manyWeak, ...twoStrong]);
    expect(target).not.toBeNull();
    expect(target!.capability).toBe("tool_utilization");
    expect(target!.confidence).toBe(0.85);
  });

  it("capabilityAreaFor maps the full failure taxonomy", () => {
    expect(capabilityAreaFor("loop_failure")).toBe("execution_stability");
    expect(capabilityAreaFor("state_loss")).toBe("state_continuity");
    expect(capabilityAreaFor("routing_failure")).toBe("routing_efficiency");
    expect(capabilityAreaFor("context_overflow")).toBe("context_quality");
    expect(capabilityAreaFor("unknown")).toBe("task_completion");
  });
});
