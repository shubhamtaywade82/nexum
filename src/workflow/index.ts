/**
 * WorkflowService — durable, resumable workflow runtime.
 *
 * Nexum already has a powerful orchestration layer (Planner, TaskGraph,
 * Scheduler, Executor, GraphStrategy) for software-engineering missions.
 * That system is execution-strategy-oriented: it plans a DAG and runs it
 * within a single agent run.
 *
 * The WorkflowService is a SEPARATE concern: durable, long-lived workflows
 * that can span multiple agent runs, survive process restarts, and be
 * inspected/resumed. Think "Ralph-style persistent workers" or cron-like
 * agent jobs.
 *
 *   WorkflowDefinition    the template (steps, triggers, checkpoints)
 *   WorkflowInstance      a materialized run (state, progress, history)
 *   WorkflowWorker        the engine that executes instances
 *   WorkflowCheckpoint    durable snapshot for resume
 *   WorkflowEvent         lifecycle event (started/step-completed/...)
 *   WorkflowResume        pick up an interrupted instance
 *
 * Unlike TaskGraph (in-memory, per-run), WorkflowInstance state is persisted
 * to disk so a crashed process can resume. This is important for:
 *   - long-running automation (crypto market monitoring)
 *   - multi-step research workflows
 *   - scheduled agent jobs
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── Contracts ───────────────────────────────────────────────────────────────

export type WorkflowId = string;
export type WorkflowInstanceId = string;
export type WorkflowStepId = string;

export interface WorkflowStep {
  id: WorkflowStepId;
  /** Human-facing label. */
  label: string;
  /** The work to do. Receives context + signal. */
  run: (ctx: WorkflowStepContext) => Promise<WorkflowStepResult>;
  /** Step ids that must complete before this one. */
  dependsOn?: WorkflowStepId[];
  /** Optional condition (evaluated at runtime). */
  condition?: (ctx: WorkflowStepContext) => boolean;
  /** Retry policy. */
  retries?: number;
  /** Timeout in ms. */
  timeoutMs?: number;
}

export interface WorkflowStepContext {
  instanceId: WorkflowInstanceId;
  stepId: WorkflowStepId;
  /** Outputs of previous steps (keyed by step id). */
  previousOutputs: Record<WorkflowStepId, unknown>;
  /** AbortSignal for cancellation. */
  signal: AbortSignal;
  /** Shared mutable state (for cross-step accumulation). */
  state: Record<string, unknown>;
}

export interface WorkflowStepResult {
  status: "completed" | "failed" | "skipped";
  output?: unknown;
  error?: string;
}

export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  /** Trigger: manual, cron, event. */
  trigger?: WorkflowTrigger;
  /** Tags for filtering. */
  tags?: string[];
}

export type WorkflowTrigger =
  { kind: "manual" } | { kind: "cron"; expression: string } | { kind: "event"; eventType: string };

export type WorkflowInstanceState = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkflowInstance {
  id: WorkflowInstanceId;
  workflowId: WorkflowId;
  /** Lifecycle state. */
  status: WorkflowInstanceState;
  /** Step statuses: stepId → status. */
  stepStates: Record<WorkflowStepId, WorkflowStepResult["status"] | "pending">;
  /** Step outputs: stepId → output. */
  stepOutputs: Record<WorkflowStepId, unknown>;
  /** Shared mutable state. */
  state: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Trigger that started this instance. */
  trigger?: WorkflowTrigger;
}

export interface WorkflowEvent {
  instanceId: WorkflowInstanceId;
  stepId?: WorkflowStepId;
  type:
    | "instance.started"
    | "instance.completed"
    | "instance.failed"
    | "step.started"
    | "step.completed"
    | "step.failed"
    | "step.skipped";
  ts: string;
  data?: Record<string, unknown>;
}

export interface WorkflowCheckpoint {
  instanceId: WorkflowInstanceId;
  ts: string;
  instance: WorkflowInstance;
}

// ── WorkflowService ─────────────────────────────────────────────────────────

export interface WorkflowServiceOptions {
  /** Root directory for workflow persistence (e.g. workspaceRoot/.nexum). */
  rootDir?: string;
  /** Disable fs writes (in-memory). */
  inMemory?: boolean;
}

export class WorkflowService {
  private readonly definitions = new Map<WorkflowId, WorkflowDefinition>();
  private readonly instances = new Map<WorkflowInstanceId, WorkflowInstance>();
  private readonly events: WorkflowEvent[] = [];
  private readonly controllers = new Map<WorkflowInstanceId, AbortController>();
  private readonly workflowsDir?: string;
  private readonly inMemory: boolean;

  constructor(opts: WorkflowServiceOptions = {}) {
    this.inMemory = opts.inMemory ?? false;
    if (opts.rootDir && !this.inMemory) {
      this.workflowsDir = join(opts.rootDir, "workflows");
      mkdirSync(this.workflowsDir, { recursive: true });
      this.loadInstances();
    }
  }

  /** Register a workflow definition. */
  register(definition: WorkflowDefinition): this {
    if (this.definitions.has(definition.id)) {
      throw new Error(`workflow "${definition.id}" already registered`);
    }
    this.definitions.set(definition.id, definition);
    return this;
  }

  /** List registered workflow definitions. */
  listDefinitions(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  /** Get a workflow definition. */
  getDefinition(id: WorkflowId): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  /** Create a new instance of a workflow (does not start it). */
  createInstance(workflowId: WorkflowId, trigger?: WorkflowTrigger): WorkflowInstance {
    const def = this.definitions.get(workflowId);
    if (!def) {
      throw new Error(`unknown workflow "${workflowId}"`);
    }
    const instance: WorkflowInstance = {
      id: `wf_${randomUUID()}`,
      workflowId,
      status: "pending",
      stepStates: {},
      stepOutputs: {},
      state: {},
      createdAt: new Date().toISOString(),
      trigger,
    };
    for (const step of def.steps) {
      instance.stepStates[step.id] = "pending";
    }
    this.instances.set(instance.id, instance);
    this.persistInstance(instance);
    return instance;
  }

  /** Start (or resume) a workflow instance. */
  async start(instanceId: WorkflowInstanceId): Promise<WorkflowInstance> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`unknown workflow instance "${instanceId}"`);
    }
    const def = this.definitions.get(instance.workflowId);
    if (!def) {
      throw new Error(`workflow definition "${instance.workflowId}" not found`);
    }

    if (instance.status === "running") {
      throw new Error(`instance "${instanceId}" is already running`);
    }

    const controller = new AbortController();
    this.controllers.set(instanceId, controller);
    instance.status = "running";
    instance.startedAt = instance.startedAt ?? new Date().toISOString();
    this.emitEvent({ instanceId, type: "instance.started", ts: new Date().toISOString() });
    this.persistInstance(instance);

    try {
      await this.runSteps(def, instance, controller.signal);
      instance.status = "completed";
      instance.finishedAt = new Date().toISOString();
      this.emitEvent({ instanceId, type: "instance.completed", ts: new Date().toISOString() });
    } catch (err) {
      instance.status = "failed";
      instance.finishedAt = new Date().toISOString();
      instance.error = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        instanceId,
        type: "instance.failed",
        ts: new Date().toISOString(),
        data: { error: instance.error },
      });
    } finally {
      this.controllers.delete(instanceId);
      this.persistInstance(instance);
    }

    return instance;
  }

  /** Pause a running instance (cooperative — steps check signal). */
  async pause(instanceId: WorkflowInstanceId): Promise<void> {
    const controller = this.controllers.get(instanceId);
    if (controller) {
      controller.abort(new Error("paused"));
    }
    const instance = this.instances.get(instanceId);
    if (instance && instance.status === "running") {
      instance.status = "paused";
      this.persistInstance(instance);
    }
  }

  /** Cancel a running instance. */
  async cancel(instanceId: WorkflowInstanceId, reason?: string): Promise<void> {
    const controller = this.controllers.get(instanceId);
    if (controller) {
      controller.abort(new Error(reason ?? "cancelled"));
    }
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.status = "cancelled";
      instance.finishedAt = new Date().toISOString();
      this.persistInstance(instance);
    }
  }

  /** Resume a paused instance. */
  async resume(instanceId: WorkflowInstanceId): Promise<WorkflowInstance> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`unknown workflow instance "${instanceId}"`);
    }
    if (instance.status !== "paused" && instance.status !== "failed") {
      throw new Error(`cannot resume instance in status "${instance.status}"`);
    }
    instance.status = "pending";
    return this.start(instanceId);
  }

  /** Get an instance (read-only). */
  getInstance(instanceId: WorkflowInstanceId): WorkflowInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** List instances (optionally filtered by workflow id or state). */
  listInstances(filter?: { workflowId?: WorkflowId; status?: WorkflowInstanceState }): WorkflowInstance[] {
    let instances = [...this.instances.values()];
    if (filter?.workflowId) {
      instances = instances.filter((i) => i.workflowId === filter.workflowId);
    }
    if (filter?.status) {
      instances = instances.filter((i) => i.status === filter.status);
    }
    return instances.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Get events for an instance. */
  eventsFor(instanceId: WorkflowInstanceId): WorkflowEvent[] {
    return this.events.filter((e) => e.instanceId === instanceId);
  }

  /** Create a checkpoint snapshot (for diagnostics / migration). */
  checkpoint(instanceId: WorkflowInstanceId): WorkflowCheckpoint | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return undefined;
    return {
      instanceId,
      ts: new Date().toISOString(),
      instance: JSON.parse(JSON.stringify(instance)),
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async runSteps(def: WorkflowDefinition, instance: WorkflowInstance, signal: AbortSignal): Promise<void> {
    // Topo-sort steps by dependencies (Kahn's algorithm, stable).
    const sorted = topoSortSteps(def.steps);

    for (const step of sorted) {
      if (signal.aborted) throw new Error("aborted");

      // Check dependencies completed.
      const deps = step.dependsOn ?? [];
      const allDepsComplete = deps.every((d) => instance.stepStates[d] === "completed");
      if (!allDepsComplete) {
        instance.stepStates[step.id] = "skipped";
        this.emitEvent({
          instanceId: instance.id,
          stepId: step.id,
          type: "step.skipped",
          ts: new Date().toISOString(),
        });
        continue;
      }

      // Check condition.
      if (step.condition) {
        const ctx = this.makeStepContext(instance, step.id, signal);
        if (!step.condition(ctx)) {
          instance.stepStates[step.id] = "skipped";
          this.emitEvent({
            instanceId: instance.id,
            stepId: step.id,
            type: "step.skipped",
            ts: new Date().toISOString(),
          });
          continue;
        }
      }

      // Execute step.
      instance.stepStates[step.id] = "pending";
      this.emitEvent({ instanceId: instance.id, stepId: step.id, type: "step.started", ts: new Date().toISOString() });
      this.persistInstance(instance);

      const ctx = this.makeStepContext(instance, step.id, signal);
      let result: WorkflowStepResult;
      try {
        result = await step.run(ctx);
      } catch (err) {
        result = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      instance.stepStates[step.id] = result.status;
      if (result.output !== undefined) {
        instance.stepOutputs[step.id] = result.output;
      }
      this.emitEvent({
        instanceId: instance.id,
        stepId: step.id,
        type:
          result.status === "completed"
            ? "step.completed"
            : result.status === "failed"
              ? "step.failed"
              : "step.skipped",
        ts: new Date().toISOString(),
        data: result.error ? { error: result.error } : undefined,
      });
      this.persistInstance(instance);

      if (result.status === "failed") {
        throw new Error(`step "${step.id}" failed: ${result.error ?? "(unknown)"}`);
      }
    }
  }

  private makeStepContext(
    instance: WorkflowInstance,
    stepId: WorkflowStepId,
    signal: AbortSignal,
  ): WorkflowStepContext {
    return {
      instanceId: instance.id,
      stepId,
      previousOutputs: { ...instance.stepOutputs },
      signal,
      state: instance.state,
    };
  }

  private emitEvent(event: WorkflowEvent): void {
    this.events.push(event);
  }

  private persistInstance(instance: WorkflowInstance): void {
    if (this.inMemory || !this.workflowsDir) return;
    const path = join(this.workflowsDir, `${instance.id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(instance, null, 2));
    renameSync(tmp, path);
  }

  private loadInstances(): void {
    if (this.inMemory || !this.workflowsDir) return;
    if (!existsSync(this.workflowsDir)) return;
    try {
      const files = readdirSync(this.workflowsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp.json"));
      for (const file of files) {
        try {
          const content = readFileSync(join(this.workflowsDir, file), "utf8");
          const instance = JSON.parse(content) as WorkflowInstance;
          this.instances.set(instance.id, instance);
        } catch {
          // corrupt file — skip
        }
      }
    } catch {
      // unreadable directory — skip
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function topoSortSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map<WorkflowStepId, number>();
  for (const s of steps) indeg.set(s.id, 0);
  for (const s of steps) {
    for (const _d of s.dependsOn ?? []) {
      indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
    }
  }
  const sorted: WorkflowStep[] = [];
  let frontier = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).sort((a, b) => a.id.localeCompare(b.id));
  while (frontier.length > 0) {
    const next = frontier.shift()!;
    sorted.push(next);
    const newlyReady: WorkflowStep[] = [];
    for (const s of steps) {
      if (s.dependsOn?.includes(next.id)) {
        const newDeg = (indeg.get(s.id) ?? 0) - 1;
        indeg.set(s.id, newDeg);
        if (newDeg === 0) newlyReady.push(s);
      }
    }
    frontier = [...frontier, ...newlyReady].sort((a, b) => a.id.localeCompare(b.id));
  }
  // Include any cyclic steps at the end (best-effort).
  for (const s of steps) {
    if (!sorted.find((x) => x.id === s.id)) sorted.push(s);
  }
  void byId;
  return sorted;
}
