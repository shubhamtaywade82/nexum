/**
 * ExecutionContext factories. Wire a run-scoped context: fresh
 * BudgetTracker (or BudgetManager), abort signal, event sink, correlation
 * identity, and the ports (context manager) supplied by the embedding
 * application (CLI, TUI, background worker, ...).
 *
 * Review item 15: every run gets isolated, request-scoped state —
 * runId/taskId/agentId/sessionId/traceId + messages + budget + policy +
 * signal + metadata — and delegated children derive their OWN context via
 * `childExecutionContext()` so nothing leaks across runs.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../models/adapters/provider.js";
import type {
  AgentId,
  ContextManager,
  EventSink,
  ExecutionContext,
  ExecutionRequest,
  ModelGateway,
  RunId,
  SessionId,
  StateStore,
  TaskSpec,
  ToolGateway,
} from "../../core/types.js";
import type { TaskId, TraceId } from "../../core/identity.js";
import type { EnvironmentPolicyContext, WorkspacePolicyContext } from "../../core/policy/policy-engine.js";
import { budgetContextOf, type ToolInvocationContext } from "../../core/tools/invocation-context.js";
import { BudgetTracker } from "../budget/budget-tracker.js";
import { BudgetManager, RunBudget } from "../budget/budget-manager.js";

export interface CreateExecutionContextOptions {
  runId?: RunId;
  sessionId?: SessionId;
  taskId?: TaskId;
  traceId?: TraceId;
  parentRunId?: RunId;
  signal?: AbortSignal;
  context?: ContextManager;
  events?: EventSink;
  budget?: ExecutionRequest["budgets"];
  modelGateway: ModelGateway;
  toolGateway: ToolGateway;
  workspace?: WorkspacePolicyContext;
  environment?: EnvironmentPolicyContext;
  state?: StateStore;
  /** Request-scoped run metadata. */
  metadata?: Record<string, unknown>;
  /** Cancellation registry run key (review item 16); defaults to runId. */
  cancellationKey?: string;
}

export class TransientContextManager implements ContextManager {
  private readonly items: ChatMessage[] = [];

  constructor(initial: ChatMessage[] = []) {
    this.items.push(...initial);
  }

  messages(): readonly ChatMessage[] {
    return this.items;
  }

  push(message: ChatMessage): void {
    this.items.push(message);
  }

  pushSystem(text: string): void {
    this.items.push({ role: "system", content: text });
  }

  pushToolResult(content: string): void {
    this.items.push({ role: "tool", content });
  }

  /** Replaces every tool result except the newest `keep` with `stub(content)`; returns how many were replaced. */
  elideToolResults(keep: number, stub: (content: string) => string | null): number {
    let seen = 0;
    let replaced = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      if (m.role !== "tool" || ++seen <= keep) continue;
      const next = stub(m.content ?? "");
      if (next === null || next === m.content) continue;
      this.items[i] = { ...m, content: next };
      replaced++;
    }
    return replaced;
  }

  lastAssistantText(): string | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      if (m.role === "assistant" && m.content) return m.content;
    }
    return undefined;
  }
}

/** A no-op event sink for headless runs that don't need event projection. */
export const nullEventSink: EventSink = {
  publish: () => undefined,
};

export function createExecutionContext(
  request: ExecutionRequest,
  opts: CreateExecutionContextOptions,
): ExecutionContext {
  const runId = opts.runId ?? `run_${randomUUID()}`;
  const sessionId = opts.sessionId ?? `sess_${randomUUID()}`;
  const traceId = opts.traceId ?? `trace_${randomUUID()}`;
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return {
    runId,
    sessionId,
    agentId: request.agentId,
    taskId: opts.taskId,
    traceId,
    parentRunId: opts.parentRunId,
    task: request.task,
    signal: controller.signal,
    mode: request.mode,
    unattended: request.unattended,
    metadata: opts.metadata ?? {},
    modelGateway: opts.modelGateway,
    toolGateway: opts.toolGateway,
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.environment ? { environment: opts.environment } : {}),
    context: opts.context ?? new TransientContextManager(),
    events: opts.events ?? nullEventSink,
    budget: new BudgetTracker({ runId, sessionId, budget: opts.budget }),
  };
}

/**
 * Create a run context with a full BudgetManager (review item 14): new
 * dimensions (iterations, cloud calls, cloud spend, parallel executions)
 * plus child-budget derivation for delegation.
 */
export function createManagedExecutionContext(
  request: ExecutionRequest,
  opts: CreateExecutionContextOptions & { budgetManager?: BudgetManager },
): ExecutionContext {
  const ctx = createExecutionContext(request, opts);
  const manager =
    opts.budgetManager ??
    new BudgetManager({
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      budget: opts.budget as RunBudget | undefined,
    });
  return { ...ctx, budget: manager };
}

/**
 * Derive an isolated child context for a delegated sub-run (review item 26).
 * The child gets:
 *   - its own runId (with parentRunId linkage for correlation)
 *   - a derived child budget whose consumption propagates to the parent
 *   - a fresh (or caller-supplied) message window — no transcript leakage
 *   - a cancellation signal chained from the parent's signal
 *   - the same policy engine and gateways (policies narrow, never widen)
 */
export function childExecutionContext(
  parent: ExecutionContext,
  request: ExecutionRequest,
  opts: {
    runId?: RunId;
    context?: ContextManager;
    events?: EventSink;
    budgetManager?: BudgetManager;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): ExecutionContext {
  const runId = opts.runId ?? `run_${randomUUID()}`;
  const controller = new AbortController();
  if (parent.signal.aborted) controller.abort();
  else parent.signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const parentManager = parent.budget instanceof BudgetManager ? parent.budget : undefined;
  const budget =
    opts.budgetManager ??
    (parentManager ? parentManager.deriveChild({ runId }) : new BudgetTracker({ runId, sessionId: parent.sessionId }));

  return {
    runId,
    sessionId: parent.sessionId,
    agentId: request.agentId,
    taskId: parent.taskId,
    traceId: parent.traceId,
    parentRunId: parent.runId,
    task: request.task,
    signal: controller.signal,
    mode: request.mode ?? parent.mode,
    unattended: request.unattended ?? parent.unattended,
    metadata: { ...parent.metadata, delegated: true, ...(opts.metadata ?? {}) },
    modelGateway: parent.modelGateway,
    toolGateway: parent.toolGateway,
    ...(parent.workspace ? { workspace: parent.workspace } : {}),
    ...(parent.environment ? { environment: parent.environment } : {}),
    context: opts.context ?? new TransientContextManager(),
    events: opts.events ?? parent.events,
    budget,
  };
}

/**
 * The single place a run's authorization context is assembled for a tool call. Strategies call this
 * instead of picking fields by hand, so no policy input the run owns can be left out. Call it BEFORE the
 * strategy consumes budget for the call: depletion is judged at this moment.
 */
export function toolInvocationFor(ctx: ExecutionContext): ToolInvocationContext {
  return {
    agentId: ctx.agentId,
    runId: ctx.runId,
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    task: ctx.task,
    budget: budgetContextOf(ctx.budget),
    ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
    ...(ctx.environment ? { environment: ctx.environment } : {}),
    ...(ctx.mode !== undefined ? { mode: ctx.mode } : {}),
    unattended: ctx.unattended === true,
    signal: ctx.signal,
  };
}

// Re-exported task type guard for callers building TaskSpecs dynamically.
export function taskFrom(input: string | TaskSpec): TaskSpec {
  return typeof input === "string" ? { goal: input } : input;
}

export type { AgentId, RunId, SessionId, TaskId, TraceId };
