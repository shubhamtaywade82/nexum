/**
 * Orchestration — the control plane (review items 2, 25, 26).
 *
 *   Planner        task → TaskGraph (LLM / static / product planners)
 *   TaskGraph      dependency-aware work graph (core/tasks)
 *   Scheduler      dependency-aware, resource-locked, deadline-bound ordering
 *   Executor       TaskGraph nodes → AgentRuntime executions
 *   Delegator      first-class delegation: DelegationRequest → isolated
 *                  ChildExecution → ResultAggregation
 *   AgentRegistry  (runtime/agent) capability-driven agent selection
 *
 * The legacy Orchestrator (ASL step machine) remains available; it is
 * expressed on top of these contracts.
 */

// Planner (review item 2)
export {
  StaticPlanner,
  LlmPlanner,
  parsePlanIntoGraph,
  graphFromPlanSteps,
  planStepsFromGraph,
  type Planner,
  type PlannerOptions,
  type PlannerHistoryEntry,
  type PlannerChatClient,
} from "./planner.js";
export { validatePlanDag, sanitizePlanDag, type DagValidationResult } from "./dag-validator.js";

// Scheduler + TaskGraph (review items 2, 34)
export { Scheduler } from "../core/tasks/scheduler.js";
export type { SchedulerOptions, ScheduledNode } from "../core/tasks/scheduler.js";
export { TaskGraph } from "../core/tasks/task-graph.js";
export type { TaskNode, TaskNodeSpec, GraphNodeStatus, TaskPriority } from "../core/tasks/task-graph.js";
export { ResourceLockRegistry, LockAcquireTimeoutError } from "../core/concurrency/resource-locks.js";
export type { LockPriority } from "../core/concurrency/resource-locks.js";

// Executor (review item 2)
export { Executor, mapOutcome } from "./executor.js";
export type { ExecutorOptions, NodeExecution, NodeTaskSpec } from "./executor.js";

// Delegation (review items 25, 26)
export { Delegator, defaultAggregation } from "./delegation/delegator.js";
export type {
  DelegationRequest,
  DelegationPolicy,
  DelegationPolicyDecision,
  ChildExecution,
  DelegatedResult,
  ResultAggregation,
  DelegatorOptions,
} from "./delegation/delegator.js";

// Legacy orchestrator (ASL machinery, still the mission driver)
export { Orchestrator } from "./orchestrator.js";
export type { OrchestratorOptions } from "./orchestrator.js";
export { AgentStepRunner } from "./agent-planner.js";
export { RuntimeStepRunner } from "./runtime-step-runner.js";
export type { StepContextFactory } from "./runtime-step-runner.js";
export { LoopDetector } from "./loop-detector.js";
export type {
  PlanStep,
  StepStatus,
  StepOutcome,
  StepRunner,
  Planner as OrchestratorPlanner,
  HistoryEntry,
} from "./types.js";
