import { ReportGenerator } from "../../../src/evolution/reporting/report-generator.js";
import { TaskDefinition, Report } from "../../../src/evolution/tasks/types.js";

function makeTask(
  requiredSections: TaskDefinition["report"]["required"] = [
    "task_identification",
    "current_implementation",
    "current_behavior",
    "identified_gaps",
    "root_cause_analysis",
    "improvement_proposals",
    "expected_impact",
    "risk_assessment",
    "implementation_plan",
    "verification_plan",
    "recommendation",
    "confidence",
  ],
): TaskDefinition {
  return {
    id: "EVO-001",
    title: "Test Task",
    category: "learning",
    priority: "P0",
    schemaVersion: 1,
    objective: "test",
    execution: { mode: "diagnose", autonomous: true, allow_code_changes: false },
    inputs: [],
    investigation: ["step"],
    acceptance: ["criterion"],
    report: { required: requiredSections },
    scoring: { impact: 0.5, potential: 0.5, feasibility: 0.5 },
    dependsOn: [],
  };
}

function makePartial(): Partial<Report> {
  return {
    current_implementation: { files: ["/some/file.ts"], classes: ["Foo"], methods: ["bar"], entry_points: [] },
    current_behavior: { summary: "x", observed_paths: [] },
    identified_gaps: {
      gaps: [
        { description: "gap1", evidence: ["ep-1", "ep-2", "ep-1"], severity: "high" }, // ep-1 is duplicated
        { description: "gap2", evidence: ["ep-3"], severity: "medium" },
      ],
    },
    root_cause_analysis: { root_causes: [{ gapRef: "gap1", cause: "why", confidence: 0.8 }] },
    improvement_proposals: {
      proposals: [{ title: "fix", description: "d", rootCauseRefs: ["gap1"], estimatedComplexity: "small" }],
    },
    expected_impact: {
      capability_delta: 0.05,
      reliability_delta: 0.04,
      cost_delta: -0.1,
      measurement_basis: "estimate",
    },
    risk_assessment: { regression_risks: ["r"], security_risks: [], mitigation_notes: [] },
    implementation_plan: {
      files_likely_to_change: ["/some/file.ts"],
      components_likely_to_change: [],
      estimated_loc: 10,
    },
    verification_plan: { tests_required: ["t"], benchmarks_required: [], held_out_evaluation: "required" },
    recommendation: { decision: "implement", rationale: "because" },
    confidence: { overall: 0.95, independent_samples: 0, evidence_window: { from: "", to: "" }, limitations: [] },
  };
}

describe("ReportGenerator", () => {
  test("produces a complete report from a valid partial", () => {
    const gen = new ReportGenerator();
    const report = gen.finalize(makeTask(), makePartial(), "abc123");
    expect(report.taskId).toBe("EVO-001");
    expect(report.task_identification.task_id).toBe("EVO-001");
    expect(report.task_identification.evaluated_commit).toBe("abc123");
    expect(report.id).toMatch(/^rpt-/);
  });

  test("de-duplicates episode ids in evidence to compute independent_samples", () => {
    const gen = new ReportGenerator();
    const report = gen.finalize(makeTask(), makePartial(), "abc123");
    // Evidence was ["ep-1", "ep-2", "ep-1", "ep-3"] → 3 unique
    expect(report.confidence.independent_samples).toBe(3);
  });

  test("caps confidence by independent_samples / 10", () => {
    const gen = new ReportGenerator();
    const report = gen.finalize(makeTask(), makePartial(), "abc123");
    // overall was 0.95; samples = 3; ceiling = 0.3 → capped to 0.3
    expect(report.confidence.overall).toBeCloseTo(0.3, 5);
  });

  test("throws when a required section is missing (defaults to empty)", () => {
    const gen = new ReportGenerator();
    const partial = makePartial();
    // current_implementation defaults to all-empty arrays, so it will be
    // detected as missing.
    delete partial.current_implementation;
    expect(() => gen.finalize(makeTask(), partial, "abc123")).toThrow(
      /missing required sections.*current_implementation/,
    );
  });

  test("throws when recommendation=implement but no proposal references a gap", () => {
    const gen = new ReportGenerator();
    const partial = makePartial();
    partial.improvement_proposals = {
      proposals: [{ title: "fix", description: "d", rootCauseRefs: ["nonexistent_gap"], estimatedComplexity: "small" }],
    };
    expect(() => gen.finalize(makeTask(), partial, "abc123")).toThrow(
      /no improvement_proposal references an identified gap/,
    );
  });

  test("no_change recommendation does not require a proposal-gap chain", () => {
    const gen = new ReportGenerator();
    // For this test, drop improvement_proposals from the required list so the
    // no_change path is not blocked by an empty proposals array.
    const task = makeTask([
      "task_identification",
      "current_implementation",
      "current_behavior",
      "identified_gaps",
      "root_cause_analysis",
      "expected_impact",
      "risk_assessment",
      "implementation_plan",
      "verification_plan",
      "recommendation",
      "confidence",
    ]);
    const partial = makePartial();
    partial.recommendation = { decision: "no_change", rationale: "nothing to do" };
    partial.improvement_proposals = { proposals: [] };
    const report = gen.finalize(task, partial, "abc123");
    expect(report.recommendation.decision).toBe("no_change");
  });

  test("deterministic id: same partial + same commit → same id", () => {
    const gen = new ReportGenerator();
    const r1 = gen.finalize(makeTask(), makePartial(), "abc123");
    const r2 = gen.finalize(makeTask(), makePartial(), "abc123");
    expect(r1.id).toBe(r2.id);
  });

  test("different commit → different id", () => {
    const gen = new ReportGenerator();
    const r1 = gen.finalize(makeTask(), makePartial(), "abc123");
    const r2 = gen.finalize(makeTask(), makePartial(), "def456");
    expect(r1.id).not.toBe(r2.id);
  });

  test("refFor produces a lightweight reference", () => {
    const gen = new ReportGenerator();
    const report = gen.finalize(makeTask(), makePartial(), "abc123");
    const ref = gen.refFor(report);
    expect(ref.id).toBe(report.id);
    expect(ref.taskId).toBe("EVO-001");
    expect(ref.decision).toBe("implement");
    expect(ref.independentSamples).toBe(3);
  });
});
