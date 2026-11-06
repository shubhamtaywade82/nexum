/**
 * Type definitions for the Evolution Task Catalogue.
 *
 * These types are the canonical TypeScript view of the YAML catalogue in
 * config/evolution/task-catalog.yml and the policies in policies.yml,
 * evaluation.yml, and schedules.yml.
 *
 * Architecture: docs/evolution/architecture.md
 * Policy:       docs/evolution/evolution-policy.md
 */

/** Catalogue category. Maps 1:1 to a directory under src/evolution/. */
export type TaskCategory =
  | "learning"
  | "evolution_safety"
  | "agent_execution"
  | "memory_knowledge"
  | "model_intelligence"
  | "platform_operations"
  | "observability"
  | "documentation";

/** Priority bucket. P0 tasks are evaluated first. */
export type TaskPriority = "P0" | "P1" | "P2";

/** Execution mode. Mode determines permissions, not the task itself. */
export type ExecutionMode = "diagnose" | "experiment" | "implement";

/** Standard report sections (see config/evolution/evaluation.yml). */
export type ReportSection =
  | "task_identification"
  | "current_implementation"
  | "current_behavior"
  | "identified_gaps"
  | "root_cause_analysis"
  | "improvement_proposals"
  | "expected_impact"
  | "risk_assessment"
  | "implementation_plan"
  | "verification_plan"
  | "recommendation"
  | "confidence";

/** Manual scoring fields used by the prioritizer. Each is in [0, 1]. */
export interface TaskScoring {
  impact: number;
  potential: number;
  feasibility: number;
}

/** Execution permissions declared per task. */
export interface TaskExecution {
  mode: ExecutionMode;
  autonomous: boolean;
  allow_code_changes: boolean;
}

/** A single task definition, parsed from YAML. */
export interface TaskDefinition {
  id: string;
  title: string;
  category: TaskCategory;
  priority: TaskPriority;
  /** Schema version of this task definition. Bumped when the contract changes. */
  schemaVersion: number;
  objective: string;
  execution: TaskExecution;
  inputs: string[];
  investigation: string[];
  acceptance: string[];
  report: {
    required: ReportSection[];
  };
  scoring: TaskScoring;
  dependsOn: string[];
}

/** Top-level catalogue file. */
export interface TaskCatalogFile {
  version: number;
  tasks: TaskDefinition[];
}

/** Backlog state for a task. See docs/evolution/evolution-policy.md §5. */
export type BacklogState = "pending" | "investigated" | "in_progress" | "completed" | "rejected_deferred";

/** A backlog entry, persisted in task-catalogue.db. */
export interface BacklogEntry {
  taskId: string;
  state: BacklogState;
  lastEvaluatedCommit: string | null;
  lastReportId: string | null;
  relatedExperimentId: string | null;
  evidenceWindowFrom: number | null; // epoch ms
  evidenceWindowTo: number | null; // epoch ms
  nextEvaluationCondition: string | null;
  updatedAt: number; // epoch ms
}

/** A pointer to a stored report. The full report is in report-store.db. */
export interface ReportRef {
  id: string;
  taskId: string;
  taskSchemaVersion: number;
  createdAt: number;
  evaluatedCommit: string;
  decision: Recommendation;
  confidence: number;
  independentSamples: number;
}

/** Recommendation enum. `no_change` is a successful report. */
export type Recommendation = "implement" | "defer" | "investigate_further" | "no_change";

/** Severity for a gap. */
export type GapSeverity = "low" | "medium" | "high" | "critical";

/** A single identified gap, with evidence. */
export interface IdentifiedGap {
  description: string;
  evidence: string[];
  severity: GapSeverity;
}

/** A root-cause entry, referencing a gap by index or description. */
export interface RootCause {
  gapRef: string;
  cause: string;
  confidence: number;
}

/** An improvement proposal, referencing root causes. */
export interface ImprovementProposal {
  title: string;
  description: string;
  rootCauseRefs: string[];
  estimatedComplexity: "small" | "medium" | "large";
}

/** A complete report following the contract in evaluation.yml. */
export interface Report {
  id: string;
  taskId: string;
  taskTitle: string;
  taskSchemaVersion: number;
  evaluationDate: number; // epoch ms
  evaluatedCommit: string;

  task_identification: {
    task_id: string;
    title: string;
    evaluation_date: string; // ISO 8601
    evaluated_commit: string;
    schema_version: number;
  };
  current_implementation: {
    files: string[];
    classes: string[];
    methods: string[];
    entry_points: string[];
  };
  current_behavior: {
    summary: string;
    observed_paths: string[];
  };
  identified_gaps: {
    gaps: IdentifiedGap[];
  };
  root_cause_analysis: {
    root_causes: RootCause[];
  };
  improvement_proposals: {
    proposals: ImprovementProposal[];
  };
  expected_impact: {
    capability_delta: number;
    reliability_delta: number;
    cost_delta: number;
    measurement_basis: string;
  };
  risk_assessment: {
    regression_risks: string[];
    security_risks: string[];
    mitigation_notes: string[];
  };
  implementation_plan: {
    files_likely_to_change: string[];
    components_likely_to_change: string[];
    estimated_loc: number;
  };
  verification_plan: {
    tests_required: string[];
    benchmarks_required: string[];
    held_out_evaluation: "required" | "optional" | "not_applicable";
  };
  recommendation: {
    decision: Recommendation;
    rationale: string;
  };
  confidence: {
    overall: number;
    independent_samples: number;
    evidence_window: {
      from: string; // ISO 8601
      to: string; // ISO 8601
    };
    limitations: string[];
  };
}

/** Policies file. */
export interface PoliciesFile {
  version: number;
  modes: Record<
    ExecutionMode,
    {
      permissions: string;
      may_mount_mutation_executor: boolean;
      may_push: boolean;
      may_activate_runtime: boolean;
    }
  >;
  acceptance: {
    stage_a_experimental_validity: {
      min_candidate_runs: number;
      min_verification_coverage: number;
      require_independent_verification_evidence: boolean;
      max_catastrophic_regression: number;
    };
    stage_b_improvement_verification: {
      min_capability_gain: number;
      min_reliability_gain: number;
      max_token_overhead: number;
    };
    held_out: {
      may_invalidate_acceptance: boolean;
      max_relative_drop_vs_parent: number;
      used_for_selection: boolean;
    };
    ci: "required" | "optional";
    human_review: "required" | "optional";
  };
  ranking: {
    weights: {
      impact: number;
      frequency: number;
      evidence_confidence: number;
      potential: number;
      dependency_importance: number;
      feasibility: number;
    };
    min_confidence_to_act: number;
  };
  anti_rules: Array<{
    id: string;
    description: string;
    enforced_by: string;
  }>;
  permissions: {
    allowed_paths: string[];
    forbidden_paths: string[];
    allowed_commands: string[];
    forbidden_commands: Array<{ pattern: string; reason: string }>;
  };
}

/** Schedules file. */
export interface SchedulesFile {
  version: number;
  default_cadence: string;
  categories: Record<
    TaskCategory,
    {
      cadence: string;
      reason: string;
      min_evidence_delta_to_re_run: number;
    }
  >;
  triggers: Array<{
    event: string;
    re_evaluate: string[];
    bypass_cadence?: boolean;
  }>;
  initial_batch: string[];
}
