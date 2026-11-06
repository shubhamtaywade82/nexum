import { TaskPrioritizer } from "../../../src/evolution/tasks/task-prioritizer.js";
import { TaskRegistry } from "../../../src/evolution/tasks/task-registry.js";
import { PoliciesFile, TaskDefinition } from "../../../src/evolution/tasks/types.js";

function makeTask(id: string, scoring: { impact: number; potential: number; feasibility: number }): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    category: "learning",
    priority: "P0",
    schemaVersion: 1,
    objective: "test",
    execution: { mode: "diagnose", autonomous: true, allow_code_changes: false },
    inputs: [],
    investigation: ["step"],
    acceptance: ["criterion"],
    report: { required: ["task_identification"] },
    scoring,
    dependsOn: [],
  };
}

const policies: PoliciesFile = {
  version: 1,
  modes: {
    diagnose: {
      permissions: "read-only",
      may_mount_mutation_executor: false,
      may_push: false,
      may_activate_runtime: false,
    },
    experiment: {
      permissions: "isolated",
      may_mount_mutation_executor: true,
      may_push: false,
      may_activate_runtime: false,
    },
    implement: {
      permissions: "branch",
      may_mount_mutation_executor: true,
      may_push: true,
      may_activate_runtime: false,
    },
  },
  acceptance: {
    stage_a_experimental_validity: {
      min_candidate_runs: 3,
      min_verification_coverage: 0.5,
      require_independent_verification_evidence: true,
      max_catastrophic_regression: 0.15,
    },
    stage_b_improvement_verification: {
      min_capability_gain: 0.03,
      min_reliability_gain: 0.04,
      max_token_overhead: 0.25,
    },
    held_out: { may_invalidate_acceptance: true, max_relative_drop_vs_parent: 0.02, used_for_selection: false },
    ci: "required",
    human_review: "required",
  },
  ranking: {
    weights: {
      impact: 0.25,
      frequency: 0.2,
      evidence_confidence: 0.2,
      potential: 0.15,
      dependency_importance: 0.1,
      feasibility: 0.1,
    },
    min_confidence_to_act: 0.4,
  },
  anti_rules: [],
  permissions: { allowed_paths: [], forbidden_paths: [], allowed_commands: [], forbidden_commands: [] },
};

describe("TaskPrioritizer", () => {
  test("ranks higher-impact task above lower-impact task when other factors equal", () => {
    const tasks = [
      makeTask("EVO-LOW", { impact: 0.5, potential: 0.5, feasibility: 0.5 }),
      makeTask("EVO-HIGH", { impact: 1.0, potential: 0.5, feasibility: 0.5 }),
    ];
    const registry = new TaskRegistry(tasks);
    const p = new TaskPrioritizer(policies, registry);
    const out = p.rank(tasks.map((task) => ({ task, observedFrequency: 0, evidenceConfidence: 0 })));
    expect(out[0].task.id).toBe("EVO-HIGH");
    expect(out[1].task.id).toBe("EVO-LOW");
  });

  test("routes low-evidence-confidence tasks to investigate_further (not execute)", () => {
    const task = makeTask("EVO-001", { impact: 1.0, potential: 1.0, feasibility: 1.0 });
    const registry = new TaskRegistry([task]);
    const p = new TaskPrioritizer(policies, registry);
    const out = p.rank([{ task, observedFrequency: 0, evidenceConfidence: 0.2 }]);
    expect(out[0].route).toBe("investigate_further");
    expect(out[0].belowConfidenceFloor).toBe(true);
  });

  test("allows execution when evidenceConfidence is 0 (fresh task)", () => {
    const task = makeTask("EVO-001", { impact: 1.0, potential: 1.0, feasibility: 1.0 });
    const registry = new TaskRegistry([task]);
    const p = new TaskPrioritizer(policies, registry);
    const out = p.rank([{ task, observedFrequency: 0, evidenceConfidence: 0 }]);
    expect(out[0].route).toBe("execute");
    expect(out[0].belowConfidenceFloor).toBe(false);
  });

  test("execute-routed tasks always come before investigate_further tasks", () => {
    const tasks = [
      makeTask("EVO-A", { impact: 0.1, potential: 0.1, feasibility: 0.1 }), // low impact, no evidence → execute
      makeTask("EVO-B", { impact: 1.0, potential: 1.0, feasibility: 1.0 }), // high impact, low evidence → investigate
    ];
    const registry = new TaskRegistry(tasks);
    const p = new TaskPrioritizer(policies, registry);
    const out = p.rank([
      { task: tasks[0], observedFrequency: 0, evidenceConfidence: 0 },
      { task: tasks[1], observedFrequency: 0, evidenceConfidence: 0.2 },
    ]);
    expect(out[0].route).toBe("execute");
    expect(out[1].route).toBe("investigate_further");
  });

  test("contributions sum to the rank", () => {
    const task = makeTask("EVO-001", { impact: 0.8, potential: 0.6, feasibility: 0.4 });
    const registry = new TaskRegistry([task]);
    const p = new TaskPrioritizer(policies, registry);
    const out = p.rank([{ task, observedFrequency: 0.5, evidenceConfidence: 0.7 }]);
    const c = out[0].contributions;
    const sum = c.impact + c.frequency + c.evidence_confidence + c.potential + c.dependency_importance + c.feasibility;
    expect(out[0].rank).toBeCloseTo(sum, 10);
  });
});
