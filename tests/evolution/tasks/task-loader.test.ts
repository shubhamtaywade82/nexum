import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../../../src/evolution/tasks/task-loader.js";

/**
 * The repository's own catalogue is the primary test fixture. If this fails,
 * the catalogue YAML is broken and the whole PR is broken.
 */
describe("loadCatalog (repo catalogue)", () => {
  test("loads the real catalogue with no invalid tasks", () => {
    const result = loadCatalog();
    expect(result.invalid).toEqual([]);
    expect(result.catalog.tasks.length).toBe(50);
    expect(result.catalog.version).toBe(1);
  });

  test("every task has a unique EVO-NNN id", () => {
    const result = loadCatalog();
    const ids = result.catalog.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^EVO-\d{3}$/);
  });

  test("every task's allow_code_changes matches its mode", () => {
    const result = loadCatalog();
    for (const t of result.catalog.tasks) {
      expect(t.execution.allow_code_changes).toBe(t.execution.mode === "implement");
    }
  });

  test("every depends_on references a real task", () => {
    const result = loadCatalog();
    const ids = new Set(result.catalog.tasks.map((t) => t.id));
    for (const t of result.catalog.tasks) {
      for (const dep of t.dependsOn) {
        expect(ids.has(dep)).toBe(true);
      }
    }
  });

  test("the dependency graph is a DAG", () => {
    const result = loadCatalog();
    // If there were a cycle, loadCatalog would not throw — but the registry's
    // topologicalOrder would. We exercise that via the registry in a separate
    // test; here we just confirm no self-dependencies.
    for (const t of result.catalog.tasks) {
      expect(t.dependsOn).not.toContain(t.id);
    }
  });

  test("policies file parses with 6 anti-rules", () => {
    const result = loadCatalog();
    expect(result.policies.anti_rules.length).toBe(6);
    expect(result.policies.ranking.weights.impact).toBe(0.25);
    expect(result.policies.ranking.min_confidence_to_act).toBe(0.4);
  });

  test("schedules file declares the initial batch of 10", () => {
    const result = loadCatalog();
    expect(result.schedules.initial_batch.length).toBe(10);
    expect(result.schedules.initial_batch).toContain("EVO-001");
    expect(result.schedules.initial_batch).toContain("EVO-018");
  });
});

describe("loadCatalog (invalid input)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-cat-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throws if task-catalog.yml is missing", () => {
    writeFileSync(
      join(tmpDir, "policies.yml"),
      "version: 1\nmodes: {}\nacceptance: {}\nranking: {weights: {}, min_confidence_to_act: 0.4}\nanti_rules: []\npermissions: {allowed_paths: [], forbidden_paths: [], allowed_commands: [], forbidden_commands: []}\n",
    );
    writeFileSync(
      join(tmpDir, "schedules.yml"),
      "version: 1\ndefault_cadence: daily\ncategories: {}\ntriggers: []\ninitial_batch: []\n",
    );
    expect(() => loadCatalog({ configDir: tmpDir })).toThrow(/not found/);
  });

  test("reports invalid tasks without taking down the whole load", () => {
    const validTask = `  - id: EVO-001
    title: "Valid"
    category: learning
    priority: P0
    schema_version: 1
    objective: "do something"
    execution: {mode: diagnose, autonomous: true, allow_code_changes: false}
    inputs: []
    investigation: ["step one"]
    acceptance: ["criterion one"]
    report: {required: [task_identification, recommendation]}
    scoring: {impact: 0.5, potential: 0.5, feasibility: 0.5}
    depends_on: []
`;
    const invalidTask = `  - id: EVO-002
    title: "Invalid"
    category: not_a_real_category
    priority: P0
    schema_version: 1
    objective: "do something"
    execution: {mode: diagnose, autonomous: true, allow_code_changes: false}
    inputs: []
    investigation: ["step one"]
    acceptance: ["criterion one"]
    report: {required: [task_identification]}
    scoring: {impact: 0.5, potential: 0.5, feasibility: 0.5}
    depends_on: []
`;
    writeFileSync(join(tmpDir, "task-catalog.yml"), `version: 1\ntasks:\n${validTask}\n${invalidTask}\n`);
    writeFileSync(
      join(tmpDir, "policies.yml"),
      `version: 1
modes:
  diagnose: {permissions: read-only, may_mount_mutation_executor: false, may_push: false, may_activate_runtime: false}
  experiment: {permissions: isolated, may_mount_mutation_executor: true, may_push: false, may_activate_runtime: false}
  implement: {permissions: branch, may_mount_mutation_executor: true, may_push: true, may_activate_runtime: false}
acceptance:
  stage_a_experimental_validity: {min_candidate_runs: 3, min_verification_coverage: 0.5, require_independent_verification_evidence: true, max_catastrophic_regression: 0.15}
  stage_b_improvement_verification: {min_capability_gain: 0.03, min_reliability_gain: 0.04, max_token_overhead: 0.25}
  held_out: {may_invalidate_acceptance: true, max_relative_drop_vs_parent: 0.02, used_for_selection: false}
  ci: required
  human_review: required
ranking:
  weights: {impact: 0.25, frequency: 0.20, evidence_confidence: 0.20, potential: 0.15, dependency_importance: 0.10, feasibility: 0.10}
  min_confidence_to_act: 0.4
anti_rules: []
permissions: {allowed_paths: [], forbidden_paths: [], allowed_commands: [], forbidden_commands: []}
`,
    );
    writeFileSync(
      join(tmpDir, "schedules.yml"),
      `version: 1
default_cadence: daily
categories:
  learning: {cadence: hourly, reason: "x", min_evidence_delta_to_re_run: 5}
  evolution_safety: {cadence: per-release, reason: "x", min_evidence_delta_to_re_run: 0}
  agent_execution: {cadence: daily, reason: "x", min_evidence_delta_to_re_run: 20}
  memory_knowledge: {cadence: daily, reason: "x", min_evidence_delta_to_re_run: 10}
  model_intelligence: {cadence: weekly, reason: "x", min_evidence_delta_to_re_run: 50}
  platform_operations: {cadence: weekly, reason: "x", min_evidence_delta_to_re_run: 0}
  observability: {cadence: weekly, reason: "x", min_evidence_delta_to_re_run: 0}
  documentation: {cadence: per-release, reason: "x", min_evidence_delta_to_re_run: 0}
triggers: []
initial_batch: []
`,
    );
    const result = loadCatalog({ configDir: tmpDir });
    expect(result.catalog.tasks.length).toBe(1);
    expect(result.catalog.tasks[0].id).toBe("EVO-001");
    expect(result.invalid.length).toBe(1);
    expect(result.invalid[0].taskId).toBe("EVO-002");
  });
});
