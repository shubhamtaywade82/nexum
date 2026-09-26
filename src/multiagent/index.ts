/**
 * Multi-agent plane — bus, shared state, consensus, supervision.
 *
 * See docs/guide/multiagent.md.
 */

export type {
  AgentAddress,
  TopicName,
  AgentMessage,
  AgentMessageInput,
  DeliveryReceipt,
  BusOptions,
} from "./bus/message-bus.js";
export { AgentMessageBus, AgentInbox, newMessageId } from "./bus/message-bus.js";

export type {
  CoordMessageType,
  TaskAssignPayload,
  TaskStatusPayload,
  TaskResultPayload,
  QuestionPayload,
  AnswerPayload,
  ProposalPayload,
  VotePayload,
  DecisionPayload,
  ResourceRequestPayload,
  ResourceReleasePayload,
  HeartbeatPayload,
} from "./bus/coordination-protocol.js";
export {
  COORD_MESSAGE_TYPES,
  isCoordinationMessage,
  assignTask,
  taskStatus,
  taskResult,
  question,
  answer,
  proposal,
  vote,
  decision,
  resourceRequest,
  resourceRelease,
  heartbeat,
  ConversationTracker,
} from "./bus/coordination-protocol.js";

export type {
  Fact,
  Finding,
  Decision,
  AgentState,
  AgentStatusInfo,
  ArtifactEntry,
  SharedAgentState,
  SharedStateField,
  ChangeLogEntry,
  ConflictContext,
  ConflictPolicy,
  SharedStateOptions,
  UpdateOptions,
} from "./shared-state.js";
export { SharedStateStore, VersionConflictError } from "./shared-state.js";

export type { VoteEntry, ProposalRecord, DecisionOutcome, VotingContext, VotingStrategy } from "./consensus.js";
export {
  ConsensusEngine,
  MajorityVoting,
  UnanimousVoting,
  WeightedVoting,
  QuorumVoting,
  PriorityResolver,
  ConflictResolver,
} from "./consensus.js";

export type {
  WorkerAgent,
  SupervisorTask,
  SupervisorTaskStatus,
  TaskPortResult,
  TaskPort,
  PlannerPort,
  SupervisorPolicy,
  SupervisionResult,
  SupervisorOptions,
} from "./supervisor.js";
export { SupervisorAgent, TaskPortError, busTaskPort, singleTaskPlanner, newSupervisorTask } from "./supervisor.js";
