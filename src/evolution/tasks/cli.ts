/**
 * CLI for the Evolution Task Catalogue.
 *
 * Wired from src/evolution/cli.ts when --task-* flags are present. Implements:
 *   nexum evolve --task-catalog             list all catalogue tasks
 *   nexum evolve --task-validate            validate the catalogue YAML
 *   nexum evolve --task-show <id>           show one task definition
 *   nexum evolve --task-backlog             show backlog state for all tasks
 *   nexum evolve --task-prioritize          rank pending tasks
 *   nexum evolve --task-run <id>            run a task end-to-end (diagnose mode;
 *                                            experiment/implement stay on the
 *                                            --mutate path)
 *
 * Architecture: docs/evolution/architecture.md
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, workspaceStateDir } from "../../platform/paths.js";
import { loadCatalog, LoadResult } from "./task-loader.js";
import { TaskRegistry } from "./task-registry.js";
import { TaskPrioritizer } from "./task-prioritizer.js";
import { BacklogTracker } from "./backlog-tracker.js";
import { ReportStore } from "../reporting/report-store.js";
import { TaskDefinition } from "./types.js";
import { buildEngineWiring } from "./engine-wiring.js";
import { TaskScheduler, sweepOnce } from "./task-scheduler.js";

export interface TaskCliOptions {
  taskCatalog?: boolean;
  taskValidate?: boolean;
  taskShow?: string;
  taskBacklog?: boolean;
  taskPrioritize?: boolean;
  taskRun?: string;
  taskContinuous?: boolean;
  taskCategory?: string;
  taskPriority?: string;
}

const HELP = `
Nexum Evolution Task Catalogue — CLI

Usage:
  nexum evolve --task-catalog                  list all catalogue tasks
  nexum evolve --task-validate                 validate the catalogue YAML
  nexum evolve --task-show <id>                show one task definition
  nexum evolve --task-backlog                  show backlog state for all tasks
  nexum evolve --task-prioritize               rank pending tasks
  nexum evolve --task-run <id>                 run a task end-to-end (diagnose mode)
  nexum evolve --task-continuous                sweep the catalogue on a schedule
                                               (--interval <ms>, --max-cycles <n>)

Filters (apply to --task-catalog and --task-prioritize):
  --task-category <name>                       learning|evolution_safety|agent_execution|
                                               memory_knowledge|model_intelligence|
                                               platform_operations|observability|documentation
  --task-priority <P0|P1|P2>                   restrict to a priority bucket

The catalogue lives in config/evolution/task-catalog.yml. Backlog state lives in
<workspace>/.nexum/state/task-catalogue.db. Reports live in
<workspace>/.nexum/state/report-store.db.

See docs/evolution/architecture.md for the full design.
`;

export function taskCliHelpText(): string {
  return HELP;
}

/** Returns true if `opts` requests any task-catalogue operation. */
export function isTaskCliInvocation(opts: TaskCliOptions): boolean {
  return Boolean(
    opts.taskCatalog ||
    opts.taskValidate ||
    opts.taskShow ||
    opts.taskBacklog ||
    opts.taskPrioritize ||
    opts.taskRun ||
    opts.taskContinuous,
  );
}

export async function runTaskCli(opts: TaskCliOptions): Promise<number> {
  if (opts.taskValidate) {
    return runValidate();
  }
  if (opts.taskShow) {
    return runShow(opts.taskShow);
  }
  if (opts.taskBacklog) {
    return runBacklog();
  }
  if (opts.taskPrioritize) {
    return runPrioritize(opts.taskCategory, opts.taskPriority);
  }
  if (opts.taskRun) {
    return runRun(opts.taskRun);
  }
  // Default: list the catalogue.
  return runList(opts.taskCategory, opts.taskPriority);
}

// ── Commands ───────────────────────────────────────────────────────────────

function runValidate(): number {
  let result: LoadResult;
  try {
    result = loadCatalog();
  } catch (err) {
    console.error(`Failed to load catalogue: ${(err as Error).message}`);
    return 1;
  }
  console.log(`Catalogue version: ${result.catalog.version}`);
  console.log(`Tasks loaded:      ${result.catalog.tasks.length}`);
  console.log(`Tasks invalid:     ${result.invalid.length}`);
  console.log(`Policies version:  ${result.policies.version}`);
  console.log(`Schedules version: ${result.schedules.version}`);
  console.log(`Anti-rules:        ${result.policies.anti_rules.length}`);
  console.log(`Config dir:        ${result.configDir}`);
  if (result.invalid.length > 0) {
    console.log("");
    console.log("Invalid tasks:");
    for (const inv of result.invalid) {
      console.log(`  ${inv.taskId}:`);
      for (const e of inv.errors) console.log(`    - ${e}`);
    }
    return 2;
  }
  // Cross-task dependency cycle check.
  const registry = new TaskRegistry(result.catalog.tasks);
  try {
    registry.topologicalOrder();
  } catch (err) {
    console.error(`Dependency cycle detected: ${(err as Error).message}`);
    return 3;
  }
  console.log("");
  console.log("Catalogue is valid. Dependency graph is a DAG.");
  return 0;
}

function runList(category: string | undefined, priority: string | undefined): number {
  const result = loadCatalog();
  const registry = new TaskRegistry(result.catalog.tasks);
  let tasks: TaskDefinition[] = registry.all();
  if (category) tasks = tasks.filter((t) => t.category === category);
  if (priority) tasks = tasks.filter((t) => t.priority === priority);

  const byPri: Record<string, TaskDefinition[]> = { P0: [], P1: [], P2: [] };
  for (const t of tasks) byPri[t.priority].push(t);

  console.log(`Nexum Evolution Task Catalogue (v${result.catalog.version})`);
  console.log(`${result.catalog.tasks.length} tasks total, ${tasks.length} matching filters`);
  console.log("");
  for (const p of ["P0", "P1", "P2"]) {
    if (byPri[p].length === 0) continue;
    console.log(`── ${p} ──────────────────────────────────────────────`);
    for (const t of byPri[p]) {
      const deps = t.dependsOn.length ? `  depends: ${t.dependsOn.join(",")}` : "";
      console.log(`${t.id}  [${t.category.padEnd(20)}]  ${t.title}${deps}`);
    }
    console.log("");
  }
  return 0;
}

function runShow(taskId: string): number {
  const result = loadCatalog();
  const registry = new TaskRegistry(result.catalog.tasks);
  const task = registry.get(taskId);
  if (!task) {
    console.error(`Task ${taskId} not found in catalogue.`);
    return 1;
  }
  console.log(`id:           ${task.id}`);
  console.log(`title:        ${task.title}`);
  console.log(`category:     ${task.category}`);
  console.log(`priority:     ${task.priority}`);
  console.log(`schema:       v${task.schemaVersion}`);
  console.log(`mode:         ${task.execution.mode}`);
  console.log(`autonomous:   ${task.execution.autonomous}`);
  console.log(`code-changes: ${task.execution.allow_code_changes}`);
  console.log(`objective:    ${task.objective}`);
  console.log(`inputs:`);
  for (const i of task.inputs) console.log(`  - ${i}`);
  console.log(`investigation:`);
  for (const i of task.investigation) console.log(`  - ${i}`);
  console.log(`acceptance:`);
  for (const a of task.acceptance) console.log(`  - ${a}`);
  console.log(`report.required:`);
  for (const s of task.report.required) console.log(`  - ${s}`);
  console.log(`scoring:`);
  console.log(`  impact:      ${task.scoring.impact}`);
  console.log(`  potential:   ${task.scoring.potential}`);
  console.log(`  feasibility: ${task.scoring.feasibility}`);
  console.log(`depends_on:   ${task.dependsOn.length ? task.dependsOn.join(", ") : "(none)"}`);
  const deps = registry.dependentCount(task.id);
  console.log(`dependents:   ${deps}`);
  return 0;
}

function runBacklog(): number {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    console.error("Could not find Nexum workspace root (looking for package.json with @nemesis-oss/nexum).");
    return 1;
  }
  const stateDir = workspaceStateDir(root);
  mkdirSync(stateDir, { recursive: true });
  const tracker = new BacklogTracker(join(stateDir, "task-catalogue.db"));
  try {
    const result = loadCatalog();
    const registry = new TaskRegistry(result.catalog.tasks);
    const all = tracker.list();
    const byState: Record<string, typeof all> = {};
    for (const e of all) {
      (byState[e.state] ??= []).push(e);
    }
    // Include pending tasks that have no entry yet.
    const trackedIds = new Set(all.map((e) => e.taskId));
    const pending: string[] = [];
    for (const t of registry.all()) {
      if (!trackedIds.has(t.id)) pending.push(t.id);
    }
    console.log(`Backlog state (${all.length} tracked, ${pending.length} untracked)`);
    console.log("");
    for (const state of ["pending", "investigated", "in_progress", "completed", "rejected_deferred"]) {
      const list = byState[state] ?? [];
      console.log(`── ${state} (${list.length}) ────────────────────`);
      for (const e of list) {
        const date = new Date(e.updatedAt).toISOString();
        console.log(
          `  ${e.taskId}  last_commit=${e.lastEvaluatedCommit ?? "(none)"}  report=${e.lastReportId ?? "(none)"}  updated=${date}`,
        );
      }
      if (state === "pending") {
        for (const id of pending) console.log(`  ${id}  (no entry yet)`);
      }
      console.log("");
    }
    return 0;
  } finally {
    tracker.close();
  }
}

function runPrioritize(category: string | undefined, priority: string | undefined): number {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    console.error("Could not find Nexum workspace root.");
    return 1;
  }
  const stateDir = workspaceStateDir(root);
  mkdirSync(stateDir, { recursive: true });
  const tracker = new BacklogTracker(join(stateDir, "task-catalogue.db"));
  try {
    const result = loadCatalog();
    const registry = new TaskRegistry(result.catalog.tasks);
    let tasks = registry.all();
    if (category) tasks = tasks.filter((t) => t.category === category);
    if (priority) tasks = tasks.filter((t) => t.priority === priority);

    // Pending = no backlog entry, or entry in pending/investigated state.
    const eligible = tasks.filter((t) => {
      const e = tracker.get(t.id);
      if (!e) return true;
      return e.state === "pending" || e.state === "investigated";
    });

    // Without a real evidence store wired here, we use neutral defaults: 0
    // observed frequency, 0 evidence confidence. The real prioritizer in the
    // closed-loop engine replaces these with values from ExperienceStore.
    const prioritizer = new TaskPrioritizer(result.policies, registry);
    const ranked = prioritizer.rank(
      eligible.map((task) => ({
        task,
        observedFrequency: 0,
        evidenceConfidence: 0,
      })),
    );

    console.log(
      `Prioritized tasks (${ranked.length} eligible, ${tasks.length - eligible.length} filtered out by state)`,
    );
    console.log("");
    console.log("rank   route                  task      category                  impact  potential");
    console.log("─".repeat(96));
    ranked.forEach((r, i) => {
      console.log(
        `${(i + 1).toString().padStart(3)}    ${r.route.padEnd(20)}  ${r.task.id}  ${r.task.category.padEnd(24)}  ${r.task.scoring.impact.toFixed(2)}    ${r.task.scoring.potential.toFixed(2)}`,
      );
    });
    return 0;
  } finally {
    tracker.close();
  }
}

async function runRun(taskId: string): Promise<number> {
  const result = loadCatalog();
  const registry = new TaskRegistry(result.catalog.tasks);
  const task = registry.get(taskId);
  if (!task) {
    console.error(`Task ${taskId} not found in catalogue.`);
    return 1;
  }
  if (task.execution.mode !== "diagnose") {
    console.error(
      `Task ${taskId} is in ${task.execution.mode} mode. Only diagnose runs from the catalogue CLI; ` +
        `experiment/implement deliver through the closed-loop mutation path — use ` +
        `"nexum evolve --mutate --repo <path>" (add --github for delivery) until task-level dispatch lands.`,
    );
    return 1;
  }
  const root = findWorkspaceRoot(process.cwd());
  const wiring = buildEngineWiring({ workspaceRoot: root });
  try {
    const outcome = await wiring.runner.runOne({ taskId });
    console.log(`[${taskId}] ${outcome.summary}`);
    if (outcome.reportRef) {
      const ref = outcome.reportRef;
      console.log(
        `  report ${ref.id} (commit ${ref.evaluatedCommit.slice(0, 12)}) → decision=${ref.decision}, confidence=${ref.confidence.toFixed(2)}, independent samples=${ref.independentSamples}`,
      );
      console.log(`  backlog: ${task.id} is now investigated; next re-run requires new evidence.`);
    }
    if (!outcome.validated) {
      // Anti-rule blocks are legitimate outcomes, not errors: exit 2 mirrors
      // --task-validate's convention for "contract not satisfied".
      return 2;
    }
    return 0;
  } catch (err) {
    console.error(`Task ${taskId} run failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    wiring.close();
  }
}

// Re-export so callers (the closed-loop engine) can construct the same stores.
export { BacklogTracker, ReportStore, TaskRegistry, TaskPrioritizer };

// ── Continuous sweep (--task-continuous) ──────────────────────────────────

export interface TaskContinuousOptions {
  intervalMs?: number;
  maxTasks?: number;
}

/**
 * `nexum evolve --task-continuous`: the cadence-driven catalogue sweep.
 * Every tick rebuilds the engine wiring (fresh episode snapshot — new
 * episodes arriving while the loop runs are picked up), applies the
 * schedules.yml ceilings, and runs at most one task. SIGINT stops cleanly.
 */
export async function runTaskContinuous(bounds: TaskContinuousOptions = {}): Promise<number> {
  const root = findWorkspaceRoot(process.cwd());
  const scheduler = new TaskScheduler({
    // One wiring PER SWEEP: the engine wiring snapshots episodes at
    // construction, so a long-running loop must re-observe on every tick.
    sweep: async () => {
      const wiring = buildEngineWiring({ workspaceRoot: root });
      try {
        return await sweepOnce({
          runner: wiring.runner,
          registry: wiring.registry,
          backlog: wiring.backlog,
          schedules: wiring.schedules,
          getCurrentCommit: wiring.deps.getCurrentCommit,
          getNewEvidenceCount: wiring.deps.getNewEvidenceCount,
        });
      } finally {
        wiring.close();
      }
    },
    intervalMs: bounds.intervalMs,
    maxTasks: bounds.maxTasks,
  });
  const onSigint = () => scheduler.stop();
  process.once("SIGINT", onSigint);
  try {
    const summary = await scheduler.run();
    console.log(
      `[TaskScheduler] Finished: ${summary.tasksRun} task(s) run, ${summary.tasksDeferred} deferred — ${summary.stoppedReason}.`,
    );
    return 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
