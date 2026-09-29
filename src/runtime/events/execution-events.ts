/**
 * ExecutionEvent — what the machine is *doing* (review item 12).
 *
 * Everything in this union is an act of execution: planning, running
 * tasks, invoking tools, calling models, asking humans for approval.
 * These are the events that must be PERSISTED (runtime/persistence —
 * review item 13) and replayed for recovery, and they are the only
 * events the execution runtime owns.
 *
 * UI concerns (theme, notifications) and world-state snapshots (git,
 * MCP, LSP) deliberately live in other families. A UI may render
 * execution events, but the runtime must never emit UI events.
 *
 * Members are allocated from the former RuntimeEvent mega-union with
 * unchanged shapes — the umbrella `RuntimeEvent` in bus.ts remains the
 * compatibility surface for the store reducer and existing listeners.
 */

import type {
  ApprovalRequest,
  ClarificationRequest,
  ClarificationResponse,
  ExecutionStep,
  MissionPhase,
  MissionPhaseId,
  Task,
  ToolCallStatus,
} from "../types.js";
import type { PlanStep } from "../../orchestration/types.js";
import type { TestFailure } from "../types.js";

export type ExecutionEvent =
  // ── run lifecycle (persisted by the ExecutionRecorder — review item 13) ──
  | { type: "run.started"; goal: string; agentId: string; strategy?: string }
  | { type: "run.completed"; status: string; output?: string; error?: string; usage?: Record<string, unknown> }
  | { type: "run.failed"; error: string }
  | { type: "run.cancelled"; reason?: string }
  | { type: "run.budget_exhausted"; dimension: string }
  | { type: "run.timeout"; deadlineMs?: number }
  | {
      type: "policy.decision";
      tool: string;
      allowed: boolean;
      requireConfirmation: boolean;
      reason: string;
      rule?: string;
    }
  | { type: "checkpoint.saved"; runId: string; stepCount?: number; label?: string }
  | { type: "delegation.started"; delegationId: string; childAgentId: string; goal: string; parentRunId: string }
  | {
      type: "delegation.completed";
      delegationId: string;
      childRunId: string;
      status: string;
      output?: string;
    }
  // ── task lifecycle ──────────────────────────────────────────────────────
  | { type: "task.created"; task: Task }
  | { type: "task.progress"; taskId: string; status: Task["status"]; progress?: number }
  // ── tool invocations ────────────────────────────────────────────────────
  | { type: "tool.started"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool.completed"; id: string; result: Record<string, unknown> }
  | { type: "tool.failed"; id: string; error: string }
  // ── model calls ─────────────────────────────────────────────────────────
  | {
      type: "model.answered";
      tier: string;
      model: string;
      /** Provider-reported usage for this call (absent when the provider reported none). */
      promptTokens?: number;
      completionTokens?: number;
      latencyMs?: number;
    }
  // ── planner / execution progress ────────────────────────────────────────
  | { type: "execution.goal"; goal: string; steps: ExecutionStep[] }
  | { type: "execution.step"; step: ExecutionStep }
  | { type: "execution.queue"; queue: string[]; etaSeconds?: number }
  | { type: "execution.reasoning"; text: string }
  // ── mission / plan orchestration ────────────────────────────────────────
  | { type: "mission.started"; goal: string }
  | { type: "mission.phase"; id: MissionPhaseId; status: MissionPhase["status"] }
  | { type: "mission.step"; step: PlanStep }
  // ── execution node graph (spans) ────────────────────────────────────────
  | {
      type: "node.start";
      id: string;
      kind: string;
      title: string;
      parentId?: string;
      details?: Record<string, unknown>;
    }
  | {
      type: "node.update";
      id: string;
      status: "pending" | "running" | "completed" | "failed" | "collapsed";
      progress?: number;
      details?: Record<string, unknown>;
    }
  | { type: "node.complete"; id: string; durationMs?: number; details?: Record<string, unknown> }
  | { type: "node.fail"; id: string; error: string; details?: Record<string, unknown> }
  // ── human-in-the-loop gates (execution-time decisions) ──────────────────
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; id: string; approved: boolean }
  | { type: "clarification.requested"; request: ClarificationRequest }
  | { type: "clarification.resolved"; response: ClarificationResponse }
  | { type: "mcp.elicitation.requested"; request: import("../../core/user-input.js").McpElicitationRequest }
  | { type: "mcp.elicitation.resolved"; response: import("../../core/user-input.js").McpElicitationResponse }
  // ── transcript records of execution acts ────────────────────────────────
  | {
      type: "conversation.tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: ToolCallStatus;
      result?: string;
      error?: string;
    }
  | {
      type: "conversation.test_result";
      command: string;
      passed: number;
      failed: number;
      failures: TestFailure[];
      durationMs: number;
    };

// ── Runtime type guard (structural, keeps families.ts prefixes honest) ─────

/** Every discriminator in the ExecutionEvent union. */
const EXECUTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.budget_exhausted",
  "run.timeout",
  "policy.decision",
  "checkpoint.saved",
  "delegation.started",
  "delegation.completed",
  "task.created",
  "task.progress",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "model.answered",
  "execution.goal",
  "execution.step",
  "execution.queue",
  "execution.reasoning",
  "mission.started",
  "mission.phase",
  "mission.step",
  "node.start",
  "node.update",
  "node.complete",
  "node.fail",
  "approval.requested",
  "approval.resolved",
  "clarification.requested",
  "clarification.resolved",
  "mcp.elicitation.requested",
  "mcp.elicitation.resolved",
  "conversation.tool_call",
  "conversation.test_result",
]);

import type { RuntimeEvent } from "./bus.js";

/** Narrow a RuntimeEvent to its execution family (mirrors core/events/families.ts). */
export function isExecutionRuntimeEvent(event: RuntimeEvent): event is ExecutionEvent {
  return EXECUTION_EVENT_TYPES.has(event.type);
}
