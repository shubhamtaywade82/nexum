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
