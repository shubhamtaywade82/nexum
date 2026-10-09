/**
 * Runtime plane — public surface (review item 39).
 *
 * The execution runtime: AgentRuntime, strategies, contexts, budgets,
 * cancellation, durable execution history, and the state plane (store,
 * sessions, checkpoints, task machine) that applications project from.
 */

// Agent runtime + registries
export {
  AgentRegistry,
  StrategyRegistry,
  DefaultAgentRuntime,
  defaultStrategyRegistry,
  devAgentDescriptor,
  runId,
  type AgentDescriptor,
  type DefaultAgentRuntimeOptions,
} from "./agent/agent-runtime.js";

// Execution strategies (review item 3)
export type { ExecutionStrategy, StrategyRunRequest } from "./strategies/execution-strategy.js";
export { ReActStrategy, runGuarded, extractToolCalls, type LoopOutcome } from "./strategies/execution-strategy.js";
export { PlanExecuteStrategy } from "./strategies/plan-execute-strategy.js";
export { GraphStrategy, type GraphStrategyOptions } from "./strategies/graph-strategy.js";
export type {
  StrategyHooks,
  StrategyTurnInfo,
  StrategyModelCallOptions,
  PreparedToolCall,
  ToolObservation,
  ToolObservationAction,
  ToolFailureInfo,
  ConfirmationRequest,
} from "./strategies/strategy-hooks.js";

// Contexts (review item 15)
export {
  createExecutionContext,
  createManagedExecutionContext,
  childExecutionContext,
  TransientContextManager,
  nullEventSink,
  taskFrom,
} from "./context/execution-context.js";

// Budgets (review item 14)
export {
  BudgetManager,
  IterationBudgetError,
  CloudCallBudgetError,
  CloudSpendBudgetError,
  ParallelBudgetError,
  type RunBudget,
  type RunBudgetUsage,
  type BudgetManagerOptions,
} from "./budget/budget-manager.js";
export {
  BudgetTracker,
  WallClockBudgetError,
  ToolCallBudgetError,
  ModelCallBudgetError,
  TokenBudgetError,
  CostBudgetError,
} from "./budget/budget-tracker.js";

// Events (review item 12)
export * from "./events/index.js";

// Persistence (review items 13, 32)
export * from "./persistence/index.js";

// State plane (store, sessions, checkpoints, task machine)
export { EventBus } from "./events/bus.js";
export {
  Store,
  sanitizeText,
  initialRuntimeState,
  reduce,
  type InitialStateOptions,
  type StoreListener,
} from "./store.js";
export { applyTaskTransition, canTransition, readyTasks } from "./task-machine.js";
export { gateTaskCompletion, type GateResult, type GateOutcome, type GateOptions } from "./verification-gate.js";
export { SessionStore, type SessionMeta } from "./session.js";
export { CheckpointStore, sanitizeResumedSteps, type CheckpointData } from "./checkpoint.js";
export { ConcurrencyGate, GateSaturatedError, GateAbortedError } from "../core/concurrency/gate.js";
