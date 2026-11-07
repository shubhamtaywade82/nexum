import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportStore } from "../../../src/evolution/reporting/report-store.js";
import { Report } from "../../../src/evolution/tasks/types.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "rpt-test1",
    taskId: "EVO-001",
    taskTitle: "Test Task",
    taskSchemaVersion: 1,
    evaluationDate: Date.parse("2026-11-06T00:00:00Z"),
    evaluatedCommit: "abc123",
    task_identification: {
      task_id: "EVO-001",
      title: "Test Task",
      evaluation_date: "2026-11-06T00:00:00.000Z",
      evaluated_commit: "abc123",
      schema_version: 1,
    },
    current_implementation: { files: ["/some/file.ts"], classes: ["Foo"], methods: ["bar"], entry_points: [] },
    current_behavior: { summary: "x", observed_paths: [] },
    identified_gaps: { gaps: [{ description: "gap1", evidence: ["ep-1"], severity: "high" }] },
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
    confidence: {
      overall: 0.7,
      independent_samples: 5,
      evidence_window: { from: "2026-10-06T00:00:00.000Z", to: "2026-11-06T00:00:00.000Z" },
      limitations: [],
    },
    ...overrides,
  };
}

describe("ReportStore", () => {
  let tmp: string;
  let store: ReportStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nexum-reports-"));
    store = new ReportStore(join(tmp, "reports.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("save and load roundtrip", () => {
    const r = makeReport();
    store.save(r);
    const loaded = store.load("rpt-test1");
    expect(loaded).not.toBeNull();
    expect(loaded?.taskId).toBe("EVO-001");
    expect(loaded?.recommendation.decision).toBe("implement");
  });

  test("idempotent re-save is a no-op", () => {
    const r = makeReport();
    store.save(r);
    expect(() => store.save(r)).not.toThrow();
  });

  test("re-save with different body throws", () => {
    store.save(makeReport());
    const r2 = makeReport({ recommendation: { decision: "no_change", rationale: "different" } });
    r2.id = "rpt-test1"; // same id, different body
    expect(() => store.save(r2)).toThrow(/already exists with a different body/);
  });

  test("latestForTask returns the most recent", () => {
    const r1 = makeReport({ id: "rpt-1", evaluationDate: 1000 });
    const r2 = makeReport({ id: "rpt-2", evaluationDate: 2000 });
    store.save(r1);
    store.save(r2);
    const latest = store.latestForTask("EVO-001");
    expect(latest?.id).toBe("rpt-2");
  });

  test("listForTask returns oldest-first", () => {
    store.save(makeReport({ id: "rpt-2", evaluationDate: 2000 }));
    store.save(makeReport({ id: "rpt-1", evaluationDate: 1000 }));
    const list = store.listForTask("EVO-001");
    expect(list.map((r) => r.id)).toEqual(["rpt-1", "rpt-2"]);
  });

  test("listRefs returns lightweight references", () => {
    store.save(makeReport());
    const refs = store.listRefs();
    expect(refs.length).toBe(1);
    expect(refs[0].taskId).toBe("EVO-001");
    expect(refs[0].decision).toBe("implement");
    expect(refs[0].confidence).toBe(0.7);
  });
});
