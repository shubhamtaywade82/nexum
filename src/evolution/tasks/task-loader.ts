/**
 * TaskLoader — reads config/evolution/*.yml and validates every task against
 * a zod schema. Invalid tasks are reported and skipped; the engine never sees
 * them.
 *
 * Architecture: docs/evolution/architecture.md
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { PoliciesFile, SchedulesFile, TaskCatalogFile, TaskDefinition } from "./types.js";

// ── Zod schemas ────────────────────────────────────────────────────────────

const taskCategoryEnum = z.enum([
  "learning",
  "evolution_safety",
  "agent_execution",
  "memory_knowledge",
  "model_intelligence",
  "platform_operations",
  "observability",
  "documentation",
]);

const priorityEnum = z.enum(["P0", "P1", "P2"]);
const modeEnum = z.enum(["diagnose", "experiment", "implement"]);

const reportSectionEnum = z.enum([
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
]);

const fraction = z.number().finite().min(0).max(1);

const scoringSchema = z.object({
  impact: fraction,
  potential: fraction,
  feasibility: fraction,
});

const executionSchema = z.object({
  mode: modeEnum,
  autonomous: z.boolean(),
  allow_code_changes: z.boolean(),
});

const taskSchema = z.object({
  id: z.string().regex(/^EVO-\d{3}$/, "task id must match EVO-NNN"),
  title: z.string().min(1),
  category: taskCategoryEnum,
  priority: priorityEnum,
  schema_version: z.number().int().min(1).default(1),
  objective: z.string().min(1),
  execution: executionSchema,
  inputs: z.array(z.string()).default([]),
  investigation: z.array(z.string()).min(1, "investigation must list at least one step"),
  acceptance: z.array(z.string()).min(1, "acceptance must list at least one criterion"),
  report: z.object({
    required: z.array(reportSectionEnum).min(1, "report.required must list at least one section"),
  }),
  scoring: scoringSchema,
  depends_on: z.array(z.string()).default([]),
});

// catalogSchema is kept inline (z.object({...}).safeParse) in loadCatalog below
// rather than as a top-level const so that per-task validation can collect
// errors individually instead of failing the whole load.

// ── Loader ─────────────────────────────────────────────────────────────────

export interface LoadResult {
  catalog: TaskCatalogFile;
  policies: PoliciesFile;
  schedules: SchedulesFile;
  /** Tasks that failed validation; the engine never sees them. */
  invalid: Array<{ taskId: string; errors: string[] }>;
  /** Path to the directory the catalog was loaded from. */
  configDir: string;
}

export interface LoadOptions {
  /**
   * Directory containing task-catalog.yml, policies.yml, evaluation.yml,
   * schedules.yml. Defaults to <repoRoot>/config/evolution.
   */
  configDir?: string;
}

/**
 * Loads and validates the catalogue, policies, and schedules.
 *
 * Throws only on missing files or unreadable YAML. Schema-validation failures
 * are reported per-task in `result.invalid` and the rest of the catalogue is
 * still returned.
 */
export function loadCatalog(opts: LoadOptions = {}): LoadResult {
  const configDir = opts.configDir ?? defaultConfigDir();
  const catalogPath = join(configDir, "task-catalog.yml");
  const policiesPath = join(configDir, "policies.yml");
  const schedulesPath = join(configDir, "schedules.yml");

  for (const p of [catalogPath, policiesPath, schedulesPath]) {
    if (!existsSync(p)) {
      throw new Error(`Evolution config file not found: ${p}`);
    }
  }

  const rawCatalog = parse(readFileSync(catalogPath, "utf8"));
  const rawPolicies = parse(readFileSync(policiesPath, "utf8"));
  const rawSchedules = parse(readFileSync(schedulesPath, "utf8"));

  // Validate policies + schedules strictly (engine cannot run without them).
  const policies = policiesSchema.parse(rawPolicies) as PoliciesFile;
  const schedules = schedulesSchema.parse(rawSchedules) as SchedulesFile;

  // Validate catalogue header strictly, tasks individually so a single bad
  // task does not take down the whole load.
  const headerResult = z
    .object({ version: z.number().int().min(1), tasks: z.array(z.unknown()) })
    .safeParse(rawCatalog);
  if (!headerResult.success) {
    throw new Error(`task-catalog.yml header failed validation: ${JSON.stringify(headerResult.error.issues)}`);
  }

  const tasksRaw = (rawCatalog as { tasks: unknown[] }).tasks;
  const valid: TaskDefinition[] = [];
  const invalid: Array<{ taskId: string; errors: string[] }> = [];

  for (const t of tasksRaw) {
    const id = (t as { id?: unknown }).id;
    const taskId = typeof id === "string" ? id : "<unknown>";
    const result = taskSchema.safeParse(t);
    if (result.success) {
      valid.push(toTaskDefinition(result.data));
    } else {
      invalid.push({ taskId, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
  }

  // Cross-task validation: ids must be unique; depends_on must reference real
  // tasks; allow_code_changes must match the declared mode.
  const idSet = new Set(valid.map((t) => t.id));
  for (const t of valid) {
    for (const dep of t.dependsOn) {
      if (!idSet.has(dep)) {
        invalid.push({
          taskId: t.id,
          errors: [`depends_on references unknown task: ${dep}`],
        });
      }
    }
    if (t.execution.allow_code_changes !== (t.execution.mode === "implement")) {
      invalid.push({
        taskId: t.id,
        errors: [
          `allow_code_changes=${t.execution.allow_code_changes} is inconsistent with mode=${t.execution.mode} (only implement may set allow_code_changes=true)`,
        ],
      });
    }
  }

  // De-duplicate: a task id that appears in `invalid` due to depends_on should
  // not also appear in `valid`.
  const invalidIds = new Set(invalid.map((i) => i.taskId));
  const finalValid = valid.filter((t) => !invalidIds.has(t.id));

  return {
    catalog: { version: rawCatalog.version, tasks: finalValid },
    policies,
    schedules,
    invalid,
    configDir,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function defaultConfigDir(): string {
  // Walk up from CWD looking for config/evolution/. This is the same pattern
  // used by findWorkspaceRoot in src/platform/paths.ts.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "config", "evolution");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "config", "evolution");
}

function toTaskDefinition(d: z.infer<typeof taskSchema>): TaskDefinition {
  return {
    id: d.id,
    title: d.title,
    category: d.category,
    priority: d.priority,
    schemaVersion: d.schema_version,
    objective: d.objective,
    execution: d.execution,
    inputs: d.inputs,
    investigation: d.investigation,
    acceptance: d.acceptance,
    report: d.report,
    scoring: d.scoring,
    dependsOn: d.depends_on,
  };
}

// ── Policies + schedules schemas (kept here to keep loader self-contained) ─

const policiesSchema = z.object({
  version: z.number().int().min(1),
  modes: z.record(
    z.enum(["diagnose", "experiment", "implement"]),
    z.object({
      permissions: z.string(),
      may_mount_mutation_executor: z.boolean(),
      may_push: z.boolean(),
      may_activate_runtime: z.boolean(),
    }),
  ),
  acceptance: z.object({
    stage_a_experimental_validity: z.object({
      min_candidate_runs: z.number().int().min(1),
      min_verification_coverage: fraction,
      require_independent_verification_evidence: z.boolean(),
      max_catastrophic_regression: fraction,
    }),
    stage_b_improvement_verification: z.object({
      min_capability_gain: fraction,
      min_reliability_gain: fraction,
      max_token_overhead: fraction,
    }),
    held_out: z.object({
      may_invalidate_acceptance: z.boolean(),
      max_relative_drop_vs_parent: fraction,
      used_for_selection: z.boolean(),
    }),
    ci: z.enum(["required", "optional"]),
    human_review: z.enum(["required", "optional"]),
  }),
  ranking: z.object({
    weights: z.object({
      impact: fraction,
      frequency: fraction,
      evidence_confidence: fraction,
      potential: fraction,
      dependency_importance: fraction,
      feasibility: fraction,
    }),
    min_confidence_to_act: fraction,
  }),
  anti_rules: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      enforced_by: z.string().min(1),
    }),
  ),
  permissions: z.object({
    allowed_paths: z.array(z.string()),
    forbidden_paths: z.array(z.string()),
    allowed_commands: z.array(z.string()),
    forbidden_commands: z.array(z.object({ pattern: z.string(), reason: z.string() })),
  }),
});

const schedulesSchema = z.object({
  version: z.number().int().min(1),
  default_cadence: z.string(),
  categories: z.record(
    taskCategoryEnum,
    z.object({
      cadence: z.string(),
      reason: z.string(),
      min_evidence_delta_to_re_run: z.number().int().min(0),
    }),
  ),
  triggers: z.array(
    z.object({
      event: z.string(),
      re_evaluate: z.array(z.string()),
      bypass_cadence: z.boolean().optional(),
    }),
  ),
  initial_batch: z.array(z.string()),
});
