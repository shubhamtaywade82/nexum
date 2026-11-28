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

// Mission plane (MAC v1, SPEC §5–§7, §9, §11–§12)
export {
  MISSION_EVENT_TYPES,
  missionPayloadSchemas,
  validateMissionEvent,
  isMissionEvent,
  newMissionEventId,
  type MissionEvent,
  type MissionEventType,
  type EvidenceRef,
  type MissionEventValidation,
} from "./mission/events.js";
export { MissionEventRouter } from "./mission/event-router.js";
export type { MissionEventRouterOptions, MissionEventDrop } from "./mission/event-router.js";
export {
  ReportArtifactStore,
  buildReportArtifact,
  hashPayload,
  newArtifactId,
  REPORT_ARTIFACT_SCHEMA_VERSION,
} from "./mission/report-artifacts.js";
export { EvidenceResolver, refFamily, refId } from "./mission/evidence-refs.js";
export type { RefFamily, RefResolution, EvidenceResolverOptions } from "./mission/evidence-refs.js";
export {
  SUPERVISED_DEFAULTS,
  CONTROLLED_AUTONOMOUS_DEFAULTS,
  RESEARCH_DEFAULTS,
  DEFAULT_ENABLED_PROFILES,
  COMMANDER_ACTIONS,
  profileDefaults,
  resolveMissionPolicy,
  validateMissionPolicy,
  amendMissionPolicy,
  type AutonomyProfile,
  type CommanderAction,
  type MissionBudgetEnvelope,
  type MissionPolicy,
  type MissionPolicyRequest,
  type MissionPolicyResolution,
  type MissionPolicyOverrides,
  type PolicyAmendmentSource,
} from "./mission/mission-policy.js";
export {
  MissionBudgetLedger,
  MissionLoopGuard,
  type BudgetSnapshot,
  type BudgetDimensionExceeded,
  type PreflightResult,
  type DecisionSignature,
  type LoopGuardVerdict,
} from "./mission/mission-budget.js";
export {
  MissionLifecycle,
  MissionCheckpointStore,
  MISSION_LIFECYCLE_STATES,
  TERMINAL_MISSION_STATES,
  canTransitionMission,
  isTerminalMissionState,
  type MissionLifecycleState,
  type TerminalMissionState,
  type MissionLifecycleRecord,
  type MissionLifecycleOptions,
  type MissionCheckpoint,
  type TaskGraphSnapshot,
  type TaskGraphSnapshotNode,
  type TaskNodeStatus,
  type LifecycleWarning,
  type LifecycleTransitionResult,
  type MissionCancelResult,
} from "./mission/mission-lifecycle.js";
