/**
 * Nexum Protocol v0 — the wire contract for the Nexum Local Host.
 *
 * This is transport-agnostic: the HTTP+SSE host (src/host) is the first
 * consumer, but the same Session/Run/Event shapes are meant to also work
 * over stdio/WebSocket transports later (see docs/plan for the phased
 * rollout). Keep this module free of Node/HTTP-specific imports so it can
 * be lifted into a standalone `@nemesis-oss/nexum-protocol` package without
 * dragging the runtime along.
 *
 * Event taxonomy is deliberately smaller than the internal ExecutionEvent
 * union (runtime/events/execution-events.ts): it's what a remote client
 * (CLI, web UI) needs to render a trace, not the full durable execution
 * log. The host derives these from Agent's callback-based AgentEvents
 * surface (src/cli/agent.ts) — see src/host/event-bridge.ts.
 */

import { z } from "zod";

export interface NexumSessionMeta {
  id: string;
  startedAt: number;
  updatedAt: number;
  messageCount: number;
  firstUserLine: string;
}

export type NexumRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface NexumRun {
  id: string;
  sessionId: string;
  goal: string;
  status: NexumRunStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  error?: string;
}

/** One PlanStep as surfaced to a remote client (subset of orchestration/types.ts PlanStep). */
export interface NexumPlanStepView {
  id: string;
  text: string;
  done: boolean;
}

export type NexumRunEvent =
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
  | { type: "run.completed"; runId: string; output: string; ts: number }
  | { type: "run.failed"; runId: string; error: string; ts: number }
  | { type: "run.cancelled"; runId: string; ts: number };

export const CreateRunRequestSchema = z.object({
  goal: z.string().min(1, "goal must not be empty"),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export interface NexumCapabilities {
  agents: string[];
  strategies: string[];
  protocolVersion: string;
}

export const PROTOCOL_VERSION = "0.1.0";
