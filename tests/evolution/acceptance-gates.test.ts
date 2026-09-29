import { AcceptanceController } from "../../src/evolution/acceptance/acceptance-controller.js";
import { GeneralizationGate, ExecutorEvaluationCell } from "../../src/evolution/generalization/generalization-gate.js";
import { EvolutionMetricsTracker, promotionPrecisionVerdict } from "../../src/evolution/metrics.js";
import { MutationScopePolicy } from "../../src/evolution/mutation/mutation-scope.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";

function target(over: Partial<ImprovementTarget> = {}): ImprovementTarget {
  return {
    id: "target-test",
    capability: "tool_utilization",
    desiredOutcome: "Tool error rate drops",
    observableSymptoms: ["tool_selection: high error rate"],
    measurableMetrics: ["reliability.toolErrorRate"],
    affectedComponents: ["tools", "context", "routing"],
    confidence: 0.9,
    evaluationPlan: {
      successCriterion: "Tool error rate drops under frozen executor",
      steps: [{ suite: "tool-calling", split: "visible", minRuns: 3 }],
      executorModels: ["qwen"],
    },
    sourceFailureClasses: ["tool_selection"],
    createdAt: Date.now(),
    ...over,
  };
}

function cell(over: Partial<ExecutorEvaluationCell>): ExecutorEvaluationCell {
  return {
    harnessId: "H0",
    executorModel: "qwen",
    split: "held_out",
    taskSuccessRate: 0.8,
    verificationPassRate: 0.8,
    runs: 5,
    ...over,
  };
}

describe("AcceptanceController", () => {
  it("walks candidate → validated → eligible → delivered → accepted → active", () => {
    const a = new AcceptanceController();
    expect(a.current()).toBe("candidate");
    expect(a.validate({ twoStagePassed: true }).ok).toBe(true);
    expect(a.generalize({ generalizationPassed: true }).ok).toBe(true);
    expect(a.current()).toBe("eligible");
    expect(a.deliver().ok).toBe(true);
    expect(a.current()).toBe("delivered");
    expect(a.accept(true, true).ok).toBe(true);
    expect(a.current()).toBe("accepted");
    expect(a.activate().ok).toBe(true);
    expect(a.current()).toBe("active");
  });

  it("refuses to validate without two-stage evidence (no declared promotion)", () => {
    const a = new AcceptanceController();
    const res = a.validate({ twoStagePassed: false });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("Two-stage");
    // Evaluation ran but the gate failed: the candidate stays in EVALUATING.
    expect(a.current()).toBe("evaluating");
  });

  it("refuses activation without CI and review approval", () => {
    const a = new AcceptanceController();
    a.validate({ twoStagePassed: true });
    a.generalize({ generalizationPassed: true });
    a.deliver();
    expect(a.accept(false, false).ok).toBe(false);
    expect(a.current()).toBe("delivered");
    // CI pass advances through the explicit CI stages, then stops at review.
    expect(a.accept(true, false).ok).toBe(false);
    expect(a.current()).toBe("review_pending");
    expect(a.accept(true, true).ok).toBe(true);
  });

  it("refuses stage skipping", () => {
    const a = new AcceptanceController();
    expect(a.deliver().ok).toBe(false);
    expect(a.activate().ok).toBe(false);
  });

  it("records the audit trail through the underlying machine", () => {
    const a = new AcceptanceController();
    a.validate({ twoStagePassed: true });
    a.generalize({ generalizationPassed: true });
    const timeline = a
      .getMachine()
      .toTimeline()
      .map((t) => t.state);
    expect(timeline).toEqual(["EVALUATING", "VALIDATED", "GENERALIZED", "ELIGIBLE"]);
  });
});

describe("GeneralizationGate (fixed-executor protocol)", () => {
  const gate = new GeneralizationGate();

  it("passes when the candidate holds or improves held-out under the frozen executor", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.85 }),
      ],
      "H0",
      "H1",
    );
    expect(verdict.generalized).toBe(true);
    expect(verdict.heldOutDeltas["qwen"]).toBeCloseTo(0.05);
  });

  it("fails on held-out regression under the primary executor", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.7 }),
      ],
      "H0",
      "H1",
    );
    expect(verdict.generalized).toBe(false);
    expect(verdict.violations[0]).toContain("Held-out regression");
  });

  it("fails when a transfer executor collapses (executor sensitivity check)", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.9 }),
        cell({ harnessId: "H0", executorModel: "gemini", split: "transfer", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "gemini", split: "transfer", taskSuccessRate: 0.6 }),
      ],
      "H0",
      "H1",
      ["gemini"],
    );
    expect(verdict.generalized).toBe(false);
    expect(verdict.violations.some((v) => v.includes("Transfer regression under gemini"))).toBe(true);
  });

  it("fails when transfer executor cells are missing entirely", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.85 }),
      ],
      "H0",
      "H1",
      ["gemini"],
    );
    expect(verdict.generalized).toBe(false);
    expect(verdict.violations.some((v) => v.includes("Missing transfer evaluation cells"))).toBe(true);
  });

  it("computes executor sensitivity as the spread of held-out deltas", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.9 }),
        cell({ harnessId: "H0", executorModel: "gemini", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "gemini", split: "held_out", taskSuccessRate: 0.82 }),
      ],
      "H0",
      "H1",
    );
    // qwen delta +0.10, gemini delta +0.02 → spread 0.08
    expect(verdict.executorSensitivity).toBeCloseTo(0.08);
  });

  it("reports executor sensitivity as unmeasured with a single executor", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.8 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", taskSuccessRate: 0.9 }),
      ],
      "H0",
      "H1",
    );
    expect(verdict.executorSensitivity).toBeNull();
    expect(verdict.rationale).toContain("needs ≥2 executors");
  });

  it("rejects cells with insufficient runs", () => {
    const verdict = gate.evaluate(
      [
        cell({ harnessId: "H0", executorModel: "qwen", split: "held_out", runs: 1 }),
        cell({ harnessId: "H1", executorModel: "qwen", split: "held_out", runs: 5 }),
      ],
      "H0",
      "H1",
    );
    expect(verdict.generalized).toBe(false);
    expect(verdict.violations[0]).toContain("Insufficient runs");
  });
});

describe("EvolutionMetricsTracker (first-class loop metrics)", () => {
  it("reports unmeasured quantities as null and averages only measured values", () => {
    const t = new EvolutionMetricsTracker();
    t.record(switchRecord({ visibleGain: 0.1, transferGain: null, executorSensitivity: null }));
    t.record(switchRecord({ visibleGain: null, transferGain: 0.04, executorSensitivity: null }));
    const report = t.report();
    expect(report.meanVisibleGain).toBeCloseTo(0.1);
    expect(report.meanTransferGain).toBeCloseTo(0.04);
    expect(report.meanExecutorSensitivity).toBeNull();
  });

  it("computes experience correlation only from recorded experience confidence", () => {
    const t = new EvolutionMetricsTracker();
    for (let i = 0; i < 4; i++) t.record(switchRecord({ heldOutGain: i / 10, promoted: i % 2 === 0 }));
    expect(t.report().experienceImprovementCorrelation).toBeNull();

    const withExperience = new EvolutionMetricsTracker();
    withExperience.record(switchRecord({ experienceConfidence: 0.9, promoted: true }));
    withExperience.record(switchRecord({ experienceConfidence: 0.8, promoted: true }));
    withExperience.record(switchRecord({ experienceConfidence: 0.2, promoted: false }));
    withExperience.record(switchRecord({ experienceConfidence: null, promoted: false }));
    expect(withExperience.report().experienceImprovementCorrelation).toBeGreaterThan(0.9);
  });

  it("computes promotion precision = genuinely better on held-out / promoted", () => {
    const t = new EvolutionMetricsTracker();
    t.record(switchRecord({ versionId: "H1", promoted: true, genuinelyBetterOnHeldOut: true }));
    t.record(switchRecord({ versionId: "H2", promoted: true, genuinelyBetterOnHeldOut: false }));
    t.record(switchRecord({ versionId: "H3", promoted: true, genuinelyBetterOnHeldOut: true }));
    t.record(switchRecord({ versionId: "H4", promoted: false, genuinelyBetterOnHeldOut: "unknown" }));
    const report = t.report();
    expect(report.promotedCount).toBe(3);
    expect(report.promotionPrecision).toBeCloseTo(2 / 3);
    expect(report.falsePromotionRate).toBeCloseTo(1 / 3);
    expect(report.promotionPrecisionVerdict).toContain("moderate");
  });

  it("computes retention, regression, and rollback rates", () => {
    const t = new EvolutionMetricsTracker();
    t.record(switchRecord({ versionId: "H1", promoted: true, accepted: true, retainedBySuccessor: true }));
    t.record(
      switchRecord({ versionId: "H2", promoted: true, accepted: true, retainedBySuccessor: false, rolledBack: true }),
    );
    const report = t.report();
    expect(report.retentionRate).toBeCloseTo(0.5);
    expect(report.regressionRate).toBeCloseTo(0.5);
    expect(report.rollbackRate).toBeCloseTo(0.5);
  });

  it("aggregates mean gains and executor sensitivity", () => {
    const t = new EvolutionMetricsTracker();
    t.record(switchRecord({ visibleGain: 0.1, heldOutGain: 0.05, transferGain: 0.02, executorSensitivity: 0.08 }));
    t.record(switchRecord({ visibleGain: 0.2, heldOutGain: 0.15, transferGain: 0.06, executorSensitivity: 0.02 }));
    const report = t.report();
    expect(report.meanVisibleGain).toBeCloseTo(0.15);
    expect(report.meanHeldOutGain).toBeCloseTo(0.1);
    expect(report.meanTransferGain).toBeCloseTo(0.04);
    expect(report.meanExecutorSensitivity).toBeCloseTo(0.05);
  });

  it("returns null precision when nothing was decided (honest unknowns)", () => {
    const t = new EvolutionMetricsTracker();
    const report = t.report();
    expect(report.promotionPrecision).toBeNull();
    expect(report.promotionPrecisionVerdict).toContain("Insufficient");
  });

  it("bands promotion precision verdicts", () => {
    expect(promotionPrecisionVerdict(0.9)).toContain("trustworthy");
    expect(promotionPrecisionVerdict(0.1)).toContain("critical");
    expect(promotionPrecisionVerdict(null)).toContain("Insufficient");
  });
});

describe("MutationScopePolicy (single → compound escalation)", () => {
  it("defaults to single-component scope for causal attribution", () => {
    const policy = new MutationScopePolicy();
    const scope = policy.decideScope(target(), "tools");
    expect(scope.kind).toBe("single_component");
    expect(scope.components).toEqual(["tools"]);
  });

  it("escalates to compound scope after repeated single-component failures", () => {
    const policy = new MutationScopePolicy({ escalationThreshold: 2 });
    policy.recordAttempt({
      capability: "tool_utilization",
      component: "tools",
      movedTarget: false,
      experimentId: "e1",
      at: 1,
    });
    // 1 failure → still single component.
    expect(policy.decideScope(target(), "tools").kind).toBe("single_component");
    policy.recordAttempt({
      capability: "tool_utilization",
      component: "tools",
      movedTarget: false,
      experimentId: "e2",
      at: 2,
    });
    // 2 consecutive failures → escalation allowed.
    const scope = policy.decideScope(target(), "tools");
    expect(scope.kind).toBe("compound");
    expect(scope.components).toContain("tools");
    expect(scope.components).toContain("context");
    expect(scope.components.length).toBeLessThanOrEqual(4);
    expect(scope.escalatedAfterAttempts).toBe(2);
  });

  it("resets the escalation counter when a single-component experiment moves the target", () => {
    const policy = new MutationScopePolicy({ escalationThreshold: 2 });
    policy.recordAttempt({
      capability: "tool_utilization",
      component: "tools",
      movedTarget: false,
      experimentId: "e1",
      at: 1,
    });
    policy.recordAttempt({
      capability: "tool_utilization",
      component: "tools",
      movedTarget: true,
      experimentId: "e2",
      at: 2,
    });
    expect(policy.consecutiveFailures("tool_utilization")).toBe(0);
    expect(policy.decideScope(target(), "tools").kind).toBe("single_component");
  });

  it("tracks escalation per capability independently", () => {
    const policy = new MutationScopePolicy({ escalationThreshold: 1 });
    policy.recordAttempt({
      capability: "tool_utilization",
      component: "tools",
      movedTarget: false,
      experimentId: "e1",
      at: 1,
    });
    expect(policy.decideScope(target(), "tools").kind).toBe("compound");
    expect(policy.decideScope(target({ capability: "context_quality" }), "context").kind).toBe("single_component");
  });

  it("bounds compound scope to maxCompoundComponents", () => {
    const policy = new MutationScopePolicy({ escalationThreshold: 1, maxCompoundComponents: 2 });
    policy.recordAttempt({
      capability: "tool_utilization",
      component: "tools",
      movedTarget: false,
      experimentId: "e1",
      at: 1,
    });
    const scope = policy.decideScope(target(), "tools");
    expect(scope.components.length).toBe(2);
  });
});

function switchRecord(over: Partial<Parameters<EvolutionMetricsTracker["record"]>[0]>) {
  return {
    versionId: "H1",
    parentVersionId: "H0",
    visibleGain: 0.05,
    heldOutGain: 0.03,
    transferGain: 0.02,
    promoted: false,
    genuinelyBetterOnHeldOut: "unknown" as const,
    accepted: false,
    rolledBack: false,
    retainedBySuccessor: "unknown" as const,
    executorModels: ["qwen"],
    executorSensitivity: 0,
    ...over,
  };
}
