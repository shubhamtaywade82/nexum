/**
 * Kernel-level identity, execution, and budget contracts.
 *
 * This module is the heart of the Nexum agent execution kernel: the boundary
 * between "the runtime that executes agents" and "the agents themselves".
 * Everything in src/kernel depends only on other kernel modules, the
 * provider layer (model transport), and src/runtime primitives — never on
 * domains (exchange/, intelligence/rails, tools/*), the CLI, or the TUI.
 *
 * Layering (target architecture, docs/guide/kernel.md):
 *
 *   Applications (CLI / TUI / DevAgent / CryptoAgent)
 *        ↓
 *   Control Plane (orchestrator, planner, delegator)
 *        ↓
 *   NEXUM KERNEL (this package)
 *     AgentRuntime · ExecutionStrategy · Context · Budgets · Events
 *        ↓                     ↓
 *   ModelGateway          ToolGateway (+ PolicyEngine)
 *        ↓                     ↓
 *   Provider (local/cloud)   Tool packs (filesystem, git, crypto, ...)
 */

import type { ChatMessage } from "../models/adapters/provider.js";
import type { RuntimeEvent } from "../runtime/events/bus.js";
import type { BudgetTracker } from "../runtime/budget/budget-tracker.js";
import type { ToolGateway } from "../tools/gateway/tool-gateway.js";
import type { PolicyEngine } from "./policy/policy-engine.js";
import type { ModelGateway } from "../models/gateway/model-gateway.js";
import type { StrategyHooks } from "../runtime/strategies/strategy-hooks.js";
import type { TaskId, TraceId } from "./identity.js";

// ── Identity ────────────────────────────────────────────────────────────────

/** A single agent execution (one run of one task). */
export type RunId = string;
/** A persisted conversation/session that can span many runs. */
export type SessionId = string;
/** A registered agent product (e.g. "devagent", "crypto-agent"). */
export type AgentId = string;

// ── Task & request ──────────────────────────────────────────────────────────

/** The unit of work an agent is asked to perform. */
export interface TaskSpec {
  goal: string;
  /** Optional free-form input (the user message, a ticket, a patch request). */
  input?: string;
  /** Hard constraints the agent must respect (paths, budgets, style). */
  constraints?: string[];
  metadata?: Record<string, unknown>;
}

/** Which execution strategy drives the think→act→observe loop. */
export type StrategyName = "react" | "plan_execute" | "graph" | "workflow" | "custom";

export interface ExecutionRequest {
  agentId: AgentId;
  task: TaskSpec;
  strategy?: StrategyName;
  /** Capability tags used for tool discovery filtering (e.g. ["coding"]). */
  capabilities?: string[];
  budgets?: ExecutionBudget;
  /**
   * Agent mode for this run (e.g. "ask" | "review" deny mutating tools via
   * ModeRestrictionRule). Products that don't track modes omit it.
   */
  mode?: string;
  /**
   * True when the operator asked for fully unattended execution: the
   * gateway's confirmation gate is bypassed by contract (deny rules still
   * apply). Headless runners and AUTO_APPROVE-style flags set this.
   */
  unattended?: boolean;
}

// ── Budgets ─────────────────────────────────────────────────────────────────

/** Resource ceilings for one execution. Any dimension may be omitted. */
export interface ExecutionBudget {
  maxToolCalls?: number;
  maxModelCalls?: number;
  maxTotalTokens?: number;
  /** Approximate spend ceiling in USD (requires profiled model costs). */
  maxCostUsd?: number;
  /** Wall-clock deadline for the whole run. */
  deadlineMs?: number;
}

export interface BudgetUsage {
  toolCalls: number;
  modelCalls: number;
  totalTokens: number;
  costUsd: number;
  elapsedMs: number;
}

export type BudgetDimension = keyof BudgetUsage;

// ── Result ──────────────────────────────────────────────────────────────────

export type ExecutionStatus = "completed" | "failed" | "cancelled" | "budget_exhausted" | "timeout";

export interface ExecutionResult {
  status: ExecutionStatus;
  runId: RunId;
  agentId: AgentId;
  strategy: StrategyName;
  output: string;
  usage: BudgetUsage;
  error?: string;
  /**
   * Strategy/product extras. Conventional keys: `terminal` (product-facing
   * terminal tag, e.g. "answered" | "loop_abort" | "turn_budget") and
   * `error` (the original Error object on failed/cancelled runs, so callers
   * can rethrow with type fidelity).
   */
  metadata?: Record<string, unknown>;
}

// ── Ports the kernel depends on (implemented outside the kernel) ────────────

/** Sink for runtime events. The existing EventBus satisfies this structurally. */
export interface EventSink {
  publish(event: RuntimeEvent): void;
}

/**
 * Conversation/context port over the agent transcript. Strategies read and
 * append messages through this port instead of touching a concrete store, so
 * the same strategy works for CLI, TUI, and headless runs.
 */
export interface ContextManager {
  messages(): readonly ChatMessage[];
  push(message: ChatMessage): void;
  pushSystem(text: string): void;
  pushToolResult(content: string): void;
  /** Latest assistant text, if any (used for final-answer extraction). */
  lastAssistantText(): string | undefined;
}

/** Minimal state-projection port (implemented by runtime/store.ts consumers). */
export interface StateStore {
  snapshot(): Record<string, unknown>;
}

// ── Execution context ───────────────────────────────────────────────────────

/**
 * Everything a strategy needs to execute one run. The runtime creates this
 * per execute() call — never share it across runs.
 *
 * Request-scoped identity (review item 15): every run carries runId +
 * taskId + agentId + sessionId + traceId + optional parentRunId, so state
 * (messages, budget, policy decisions, cancellation) can never leak across
 * runs — child runs derive their own context via
 * `childExecutionContext()` with inherited budget/policy/signal.
 */
export interface ExecutionContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  /** The scheduled task this run executes (control-plane linkage). */
  readonly taskId?: TaskId;
  /** Trace this run belongs to (correlation root; review item 33). */
  readonly traceId: TraceId;
  /** Set on delegated child runs — links back to the delegating run. */
  readonly parentRunId?: RunId;
  readonly task: TaskSpec;
  readonly signal: AbortSignal;
  /** Agent mode for this run (policy mode restrictions). */
  readonly mode?: string;
  /** Unattended run — gateway confirmation gate bypassed by contract. */
  readonly unattended?: boolean;
  /** Free-form run metadata (request-scoped, never shared across runs). */
  readonly metadata: Record<string, unknown>;

  readonly modelGateway: ModelGateway;
  readonly toolGateway: ToolGateway;
  readonly policyEngine: PolicyEngine;
  readonly context: ContextManager;
  readonly events: EventSink;
  readonly budget: BudgetTracker;
}

// ── AgentRuntime (the kernel facade) ────────────────────────────────────────

/** Optional per-execute settings: product hooks + loop sizing. */
export interface StrategyExecuteOptions {
  /** Product-side policies for the loop (see strategies/strategy-hooks.ts). */
  hooks?: StrategyHooks;
  /** Max tool turns override for this run. */
  maxToolTurns?: number;
}

/**
 * The single entry point of the kernel. Applications request executions;
 * the runtime resolves the agent, picks the strategy, and drives one run.
 * The runtime owns state, policies, budgets, retries, cancellation and
 * checkpoints (review item 3) — strategies only own the reasoning loop.
 */
export interface AgentRuntime {
  execute(
    request: ExecutionRequest,
    context: ExecutionContext,
    options?: StrategyExecuteOptions,
  ): Promise<ExecutionResult>;
  /** Cancel an active run by id (propagates through the run's signal). */
  cancel?(runId: string): boolean;
}

// Ergonomic re-exports so kernel-internal modules can import peer contracts
// from one place without introducing cycles.
export type { ToolGateway } from "../tools/gateway/tool-gateway.js";
export type { ToolDefinition } from "./tools/tool-contract.js";
export type { PolicyEngine } from "./policy/policy-engine.js";
export type { ModelGateway } from "../models/gateway/model-gateway.js";
