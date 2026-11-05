/**
 * Agent Coordination Protocol — the standard message vocabulary.
 *
 * The bus carries arbitrary types; coordination needs a shared one so
 * unrelated agents interoperate. Every builder produces a well-formed
 * envelope and every guard parses one back, with conversation threading
 * baked in (ConversationTracker groups a working thread by conversationId).
 */

import type { AgentMessage, AgentMessageInput } from "./message-bus.js";

export const COORD_MESSAGE_TYPES = [
  "coord.task.assign",
  "coord.task.status",
  "coord.task.result",
  "coord.question",
  "coord.answer",
  "coord.proposal",
  "coord.vote",
  "coord.decision",
  "coord.resource.request",
  "coord.resource.release",
  "coord.heartbeat",
] as const;

export type CoordMessageType = (typeof COORD_MESSAGE_TYPES)[number];

export function isCoordinationMessage(message: AgentMessage): boolean {
  return (COORD_MESSAGE_TYPES as readonly string[]).includes(message.type);
}

// ── Payload shapes ──────────────────────────────────────────────────────────

export interface TaskAssignPayload {
  taskId: string;
  goal: string;
  input?: string;
  constraints?: string[];
  deadlineMs?: number;
}

export interface TaskStatusPayload {
  taskId: string;
  status: "accepted" | "working" | "blocked" | "done" | "failed";
  progress?: number;
  note?: string;
}

export interface TaskResultPayload {
  taskId: string;
  status: "done" | "failed" | "blocked";
  output: string;
  /** Artifact references instead of payload strings (see artifacts plane). */
  artifacts?: Array<{ artifactId: string; version?: number }>;
  error?: string;
}

export interface QuestionPayload {
  question: string;
  context?: string;
  /** Who should answer (default: the addressee). */
  directedAt?: string;
}

export interface AnswerPayload {
  answer: string;
  confidence?: number;
}

export interface ProposalPayload {
  proposalId: string;
  topic: string;
  /** The proposed value/decision (opaque to the protocol). */
  value: unknown;
  rationale?: string;
  deadlineMs?: number;
}

export interface VotePayload {
  proposalId: string;
  choice: "approve" | "reject" | "abstain" | string;
  weight?: number;
  rationale?: string;
}

export interface DecisionPayload {
  proposalId: string;
  outcome: "approved" | "rejected" | "deadlock";
  winner?: unknown;
  tally: Record<string, number>;
  rationale?: string;
}

export interface ResourceRequestPayload {
  resource: string;
  reason: string;
  leaseMs?: number;
}

export interface ResourceReleasePayload {
  resource: string;
}

export interface HeartbeatPayload {
  state: "idle" | "working" | "blocked" | "done" | "failed";
  currentTaskId?: string;
  progress?: number;
}

// ── Builders ────────────────────────────────────────────────────────────────

const coord =
  (type: CoordMessageType) =>
  <P>(input: Omit<AgentMessageInput<P>, "type">): AgentMessageInput<P> => ({
    ...input,
    type,
  });

export const assignTask = (
  from: string,
  to: string,
  payload: TaskAssignPayload,
): AgentMessageInput<TaskAssignPayload> =>
  coord("coord.task.assign")({ from, to, payload, conversationId: `task:${payload.taskId}` });

export const taskStatus = (
  from: string,
  to: string,
  payload: TaskStatusPayload,
): AgentMessageInput<TaskStatusPayload> =>
  coord("coord.task.status")({
    from,
    to,
    payload,
    ...(payload.taskId ? { conversationId: `task:${payload.taskId}` } : {}),
  });

export const taskResult = (
  from: string,
  to: string,
  payload: TaskResultPayload,
): AgentMessageInput<TaskResultPayload> =>
  coord("coord.task.result")({ from, to, payload, conversationId: `task:${payload.taskId}` });

export const question = (from: string, to: string, payload: QuestionPayload): AgentMessageInput<QuestionPayload> =>
  coord("coord.question")({ from, to, payload });

export const answer = (from: string, to: string, payload: AnswerPayload): AgentMessageInput<AnswerPayload> =>
  coord("coord.answer")({ from, to, payload });

export const proposal = (from: string, to: string, payload: ProposalPayload): AgentMessageInput<ProposalPayload> =>
  coord("coord.proposal")({ from, to, payload, conversationId: `proposal:${payload.proposalId}` });

export const vote = (from: string, to: string, payload: VotePayload): AgentMessageInput<VotePayload> =>
  coord("coord.vote")({ from, to, payload, conversationId: `proposal:${payload.proposalId}` });

export const decision = (from: string, to: string, payload: DecisionPayload): AgentMessageInput<DecisionPayload> =>
  coord("coord.decision")({ from, to, payload, conversationId: `proposal:${payload.proposalId}` });

export const resourceRequest = (
  from: string,
  to: string,
  payload: ResourceRequestPayload,
): AgentMessageInput<ResourceRequestPayload> => coord("coord.resource.request")({ from, to, payload });

export const resourceRelease = (
  from: string,
  to: string,
  payload: ResourceReleasePayload,
): AgentMessageInput<ResourceReleasePayload> => coord("coord.resource.release")({ from, to, payload });

export const heartbeat = (from: string, to: string, payload: HeartbeatPayload): AgentMessageInput<HeartbeatPayload> =>
  coord("coord.heartbeat")({ from, to, payload });

// ── Conversation tracking ───────────────────────────────────────────────────

/** Groups messages into threads by conversationId — the audit view of a
 *  multi-agent negotiation or task handoff. */
export class ConversationTracker {
  private readonly threads = new Map<string, AgentMessage[]>();

  append(message: AgentMessage): void {
    if (!message.conversationId) return;
    const thread = this.threads.get(message.conversationId) ?? [];
    thread.push(message);
    this.threads.set(message.conversationId, thread);
  }

  thread(conversationId: string): AgentMessage[] {
    return [...(this.threads.get(conversationId) ?? [])];
  }

  conversationIds(): string[] {
    return [...this.threads.keys()];
  }
}
