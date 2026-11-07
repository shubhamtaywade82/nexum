import { validateTaskRun, hypothesisHash, normalizeHypothesis } from "../../../src/evolution/tasks/task-validator.js";
import { TaskDefinition } from "../../../src/evolution/tasks/types.js";

function makeTask(mode: TaskDefinition["execution"]["mode"] = "diagnose"): TaskDefinition {
  return {
    id: "EVO-001",
    title: "Test",
    category: "learning",
    priority: "P0",
    schemaVersion: 1,
    objective: "test",
    execution: { mode, autonomous: true, allow_code_changes: mode === "implement" },
    inputs: [],
    investigation: ["step"],
    acceptance: ["criterion"],
    report: { required: ["task_identification"] },
    scoring: { impact: 0.5, potential: 0.5, feasibility: 0.5 },
    dependsOn: [],
  };
}

describe("task-validator", () => {
  test("passes a fresh task with a fresh hypothesis", () => {
    const r = validateTaskRun(makeTask(), {
      knownHypothesisHashes: new Set(),
      proposedHypothesis: "fresh",
      backlog: null,
      currentCommit: "abc",
      newEvidenceCount: 0,
      evaluatorIsImplementer: false,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("ok");
  });

  test("blocks duplicate hypotheses (with text normalization)", () => {
    const h1 = hypothesisHash("Fix the BUG");
    const h2 = hypothesisHash("  fix   the bug  ");
    expect(h1).toBe(h2); // normalization is content-based, not text-based
    const r = validateTaskRun(makeTask(), {
      knownHypothesisHashes: new Set([h1]),
      proposedHypothesis: "fix   the bug",
      backlog: null,
      currentCommit: "abc",
      newEvidenceCount: 0,
      evaluatorIsImplementer: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("duplicate_hypothesis");
  });

  test("blocks re-diagnosis when neither commit nor evidence advanced", () => {
    const r = validateTaskRun(makeTask(), {
      knownHypothesisHashes: new Set(),
      proposedHypothesis: "fresh",
      backlog: {
        taskId: "EVO-001",
        state: "investigated",
        lastEvaluatedCommit: "abc",
        lastReportId: "rpt-1",
        relatedExperimentId: null,
        evidenceWindowFrom: null,
        evidenceWindowTo: null,
        nextEvaluationCondition: null,
        updatedAt: 0,
      },
      currentCommit: "abc",
      newEvidenceCount: 0,
      evaluatorIsImplementer: false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no_new_evidence");
  });

  test("allows re-diagnosis when commit advanced (no new evidence)", () => {
    const r = validateTaskRun(makeTask(), {
      knownHypothesisHashes: new Set(),
      proposedHypothesis: "fresh",
      backlog: {
        taskId: "EVO-001",
        state: "investigated",
        lastEvaluatedCommit: "abc",
        lastReportId: "rpt-1",
        relatedExperimentId: null,
        evidenceWindowFrom: null,
        evidenceWindowTo: null,
        nextEvaluationCondition: null,
        updatedAt: 0,
      },
      currentCommit: "def",
      newEvidenceCount: 0,
      evaluatorIsImplementer: false,
    });
    expect(r.ok).toBe(true);
  });

  test("allows re-diagnosis when evidence advanced (same commit)", () => {
    const r = validateTaskRun(makeTask(), {
      knownHypothesisHashes: new Set(),
      proposedHypothesis: "fresh",
      backlog: {
        taskId: "EVO-001",
        state: "investigated",
        lastEvaluatedCommit: "abc",
        lastReportId: "rpt-1",
        relatedExperimentId: null,
        evidenceWindowFrom: null,
        evidenceWindowTo: null,
        nextEvaluationCondition: null,
        updatedAt: 0,
      },
      currentCommit: "abc",
      newEvidenceCount: 5,
      evaluatorIsImplementer: false,
    });
    expect(r.ok).toBe(true);
  });

  test("blocks self-evaluation in implement mode", () => {
    const r = validateTaskRun(makeTask("implement"), {
      knownHypothesisHashes: new Set(),
      proposedHypothesis: "fresh",
      backlog: null,
      currentCommit: "abc",
      newEvidenceCount: 0,
      evaluatorIsImplementer: true,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("self_evaluation_forbidden");
  });

  test("normalizeHypothesis collapses whitespace and lowercases", () => {
    expect(normalizeHypothesis("  Fix   the BUG  ")).toBe("fix the bug");
    expect(normalizeHypothesis("Fix\tthe\nBUG")).toBe("fix the bug");
  });
});
