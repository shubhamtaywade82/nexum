/**
 * Nexum Protocol v1 — the wire contract for the Nexum Server.
 *
 * Transport-agnostic: HTTP+SSE host (src/host, src/server) is the primary
 * consumer, but the same Session/Run/Event shapes work across stdio/RPC
 * and WebSocket transports.
 *
 * Keep this module free of Node/HTTP-specific imports so it can be extracted
 * into a standalone `@nemesis-oss/nexum-protocol` package without dragging
 * runtime dependencies along.
 */

import { z } from "zod";

export const PROTOCOL_VERSION = "1.0.0";

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  instanceId: string;
}

export interface HealthStatus {
  status: "ready" | "degraded" | "unavailable";
  checks: {
    postgres: "ok" | "error";
    redis: "ok" | "error";
    runtime: "ok" | "error";
  };
}

export interface NexumSessionMeta {
  id: string;
  startedAt: number;
  updatedAt: number;
  messageCount: number;
  firstUserLine: string;
}

export type NexumRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type WaitingOn = "approval" | "clarification" | "elicitation";

export const NexumOutputFormatSchema = z.enum(["text", "markdown", "openui", "json"]);
export type NexumOutputFormat = z.infer<typeof NexumOutputFormatSchema>;

/** Final run output; `format` is authoritative, so clients pick a renderer from it rather than sniffing content. */
export interface NexumRunOutput {
  format: NexumOutputFormat;
  content: string;
  schemaVersion?: string;
}

export interface NexumRun {
  id: string;
  sessionId: string;
  goal: string;
  status: NexumRunStatus;
  waitingOn?: WaitingOn | null;
  startedAt: number;
  finishedAt?: number;
  output?: NexumRunOutput;
  error?: string;
}

/** Validates run status transitions */
export function isValidRunTransition(from: NexumRunStatus, to: NexumRunStatus): boolean {
  const transitions: Record<NexumRunStatus, NexumRunStatus[]> = {
    queued: ["running", "cancelled", "interrupted"],
    running: ["completed", "failed", "cancelled", "interrupted"],
    completed: [],
    failed: [],
    cancelled: [],
    interrupted: [],
  };
  return transitions[from]?.includes(to) ?? false;
}

/** One PlanStep as surfaced to a remote client (subset of orchestration/types.ts PlanStep). */
export interface NexumPlanStepView {
  id: string;
  text: string;
  done: boolean;
}

// ==================== Interactions ====================

export type InteractionType = "approval" | "clarification" | "elicitation";

export interface ApprovalInteraction {
  id: string;
  runId: string;
  type: "approval";
  title: string;
  summary: string;
  tool?: string;
  risk?: "low" | "medium" | "high";
  resolved?: boolean;
  approved?: boolean;
  createdAt: number;
  resolvedAt?: number;
}

export interface ClarificationInteraction {
  id: string;
  runId: string;
  type: "clarification";
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  resolved?: boolean;
  selectedId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface McpElicitationInteraction {
  id: string;
  runId: string;
  type: "elicitation";
  serverName: string;
  parameterName: string;
  prompt: string;
  resolved?: boolean;
  response?: string;
  createdAt: number;
  resolvedAt?: number;
}

export type NexumInteraction = ApprovalInteraction | ClarificationInteraction | McpElicitationInteraction;

export const ResolveInteractionRequestSchema = z.object({
  approved: z.boolean().optional(),
  reason: z.string().optional(),
  selectedId: z.string().optional(),
  response: z.string().optional(),
});
export type ResolveInteractionRequest = z.infer<typeof ResolveInteractionRequestSchema>;

// ==================== Events ====================

export type NexumRunEvent =
  | { type: "run.queued"; runId: string; sessionId: string; goal: string; ts: number }
  | { type: "run.started"; runId: string; sessionId: string; goal: string; ts: number }
  | {
      type: "plan.updated";
      runId: string;
      goal: string;
      steps: NexumPlanStepView[];
      status: "running" | "completed" | "failed";
      ts: number;
    }
  | { type: "thought"; runId: string; text: string; ts: number }
  | {
      type: "tool.started";
      runId: string;
      callId: string;
      name: string;
      args: Record<string, unknown>;
      ts: number;
    }
  | {
      type: "tool.completed";
      runId: string;
      callId: string;
      name: string;
      result: Record<string, unknown>;
      ts: number;
    }
  | { type: "model.used"; runId: string; tier: string; model: string; ts: number }
  | {
      type: "run.approval.required";
      runId: string;
      interactionId: string;
      title: string;
      summary: string;
      tool?: string;
      ts: number;
    }
  | {
      type: "run.approval.resolved";
      runId: string;
      interactionId: string;
      approved: boolean;
      ts: number;
    }
  | {
      type: "run.clarification.required";
      runId: string;
      interactionId: string;
      question: string;
      options: Array<{ id: string; label: string }>;
      ts: number;
    }
  | {
      type: "run.clarification.resolved";
      runId: string;
      interactionId: string;
      selectedId: string;
      ts: number;
    }
  | {
      type: "run.mcp_elicitation.required";
      runId: string;
      interactionId: string;
      serverName: string;
      parameterName: string;
      prompt: string;
      ts: number;
    }
  | {
      type: "run.mcp_elicitation.resolved";
      runId: string;
      interactionId: string;
      response: string;
      ts: number;
    }
  | { type: "run.completed"; runId: string; output: NexumRunOutput; ts: number }
  | { type: "run.failed"; runId: string; error: string; ts: number }
  | { type: "run.cancelled"; runId: string; ts: number }
  | { type: "run.interrupted"; runId: string; reason: string; ts: number };

export interface RunEventEnvelope {
  seq: number;
  runId: string;
  type: NexumRunEvent["type"];
  ts: number;
  payload: NexumRunEvent;
}

// ==================== Requests & Capabilities ====================

export const CreateRunRequestSchema = z.object({
  goal: z.string().min(1, "goal must not be empty"),
  outputFormat: NexumOutputFormatSchema.default("markdown"),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export interface NexumCapabilities {
  protocolVersion: string;
  serverVersion?: string;
  agents: string[];
  strategies: string[];
  outputFormats: NexumOutputFormat[];
  features?: {
    streaming?: boolean;
    replay?: boolean;
    approvals?: boolean;
    clarifications?: boolean;
    mcpElicitation?: boolean;
  };
}

// ==================== Errors ====================

export const ErrorCodes = {
  NOT_FOUND: "not_found",
  SESSION_NOT_FOUND: "session_not_found",
  RUN_NOT_FOUND: "run_not_found",
  SESSION_BUSY: "session_busy",
  INVALID_REQUEST: "invalid_request",
  INVALID_STATE_TRANSITION: "invalid_state_transition",
  UNAUTHORIZED: "unauthorized",
  SERVER_NOT_READY: "server_not_ready",
  INTERNAL_ERROR: "internal_error",
  INTERACTION_NOT_FOUND: "interaction_not_found",
  INTERACTION_ALREADY_RESOLVED: "interaction_already_resolved",
  UNSUPPORTED_OUTPUT_FORMAT: "unsupported_output_format",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface NexumErrorResponse {
  error: {
    code: ErrorCode | string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
