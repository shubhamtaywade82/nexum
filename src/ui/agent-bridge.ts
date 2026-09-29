/**
 * Bridges the Agent's callback events onto the runtime event bus. This is
 * the only place agent callbacks are translated; everything downstream is
 * bus -> store -> renderer.
 */

import { EventBus } from "../runtime/events/bus.js";
import { LspServerState } from "../lsp/protocol.js";
import { SkillMeta } from "../skills/types.js";
import { PlanStep, StepStatus } from "../orchestration/types.js";
import {
  ApprovalRequest,
  ClarificationRequest,
  ExecutionStep,
  MissionPhase,
  MissionPhaseId,
} from "../runtime/types.js";

// PlanStep tracks a fine-grained ASL (analyzing/planning/implementing/
// testing/reviewing/...); the TUI only renders the coarse 5-state model.
const STEP_STATUS_MAP: Record<StepStatus, ExecutionStep["status"]> = {
  pending: "pending",
  analyzing: "running",
  planning: "running",
  implementing: "running",
  testing: "running",
  reviewing: "running",
  running: "running",
  completed: "completed",
  failed: "failed",
  blocked: "failed",
  rejected: "failed",
  paused: "failed",
  cancelled: "failed",
  rolledback: "failed",
  skipped: "skipped",
};

function toExecutionSteps(steps: PlanStep[]): ExecutionStep[] {
  return steps.map((s) => ({ id: s.id, description: s.description, status: STEP_STATUS_MAP[s.status] }));
}

export interface BridgeableAgent {
  on<E extends string>(event: E, handler: (...args: any[]) => void): unknown;
  getSkillsRegistry?(): { list(): SkillMeta[] };
}

export function wireAgentBridge(agent: BridgeableAgent, bus: EventBus): void {
  let toolSeq = 0;
  interface OpenCall {
    id: string;
    args: Record<string, unknown>;
  }
  const openCalls = new Map<string, OpenCall[]>(); // tool name -> stack of open calls

  agent.on("onAssistantText", (chunk: string) => {
    bus.publish({ type: "conversation.chunk", role: "assistant", chunk });
    bus.publish({ type: "model.streaming", streaming: true });
  });
  agent.on("onThinking", (chunk: string) => {
    bus.publish({ type: "conversation.chunk", role: "thinking", chunk });
  });
  agent.on("onToolCall", (name: string, args: Record<string, unknown>) => {
    const id = `tc${++toolSeq}`;
    const stack = openCalls.get(name) ?? [];
    stack.push({ id, args });
    openCalls.set(name, stack);
    bus.publish({ type: "tool.started", id, name, args });
    bus.publish({ type: "conversation.tool_call", id, name, args, status: "running" });
    bus.publish({ type: "logs.appended", level: "info", source: "tool", message: `${name} started` });
  });
  agent.on("onToolResult", (name: string, result: Record<string, unknown> | string) => {
    const stack = openCalls.get(name) ?? [];
    const call = stack.shift();
    if (!call) return;
    const { id, args } = call;
    const resultObj = typeof result === "string" ? { output: result } : (result ?? {});
    const error = resultObj && typeof resultObj.error === "string" ? resultObj.error : null;
    if (error) {
      bus.publish({ type: "tool.failed", id, error });
      bus.publish({ type: "conversation.tool_call", id, name, args, status: "failed", error });
      bus.publish({ type: "logs.appended", level: "error", source: "tool", message: `${name} failed: ${error}` });
    } else {
      const resultStr = JSON.stringify(resultObj);
      bus.publish({ type: "tool.completed", id, result: resultObj });
      bus.publish({ type: "conversation.tool_call", id, name, args, status: "completed", result: resultStr });
      bus.publish({ type: "logs.appended", level: "info", source: "tool", message: `${name} completed` });
    }
  });
  agent.on("onStatus", (status: string) => {
    bus.publish({ type: "status.changed", status });
    // Model-routing decisions (which tier/model handled this turn) matter after
    // the spinner clears — persist them to Logs instead of only flashing by.
    if (status.startsWith("delegating task to") || status.startsWith("escalating to")) {
      bus.publish({ type: "logs.appended", level: "info", source: "model", message: status });
    }
  });
  agent.on("onError", (error: Error) => {
    bus.publish({ type: "error", message: error.message });
    bus.publish({ type: "logs.appended", level: "error", source: "agent", message: error.message });
  });
  agent.on("onShellOutput", (stream: "stdout" | "stderr", chunk: string) => {
    bus.publish({
      type: "logs.appended",
      level: stream === "stderr" ? "warn" : "debug",
      source: "shell",
      message: chunk,
    });
  });
  agent.on("onMemorySummary", (summary: string) => {
    bus.publish({ type: "memory.updated", summary });
  });
  agent.on("onSkillsActivated", (activated: SkillMeta[]) => {
    const allSkills = agent.getSkillsRegistry?.().list() ?? activated;
    const activeIds = new Set(activated.map((s) => s.id));
    bus.publish({
      type: "skills.changed",
      skills: allSkills.map((s) => ({ id: s.id, name: s.name, tags: s.tags, active: activeIds.has(s.id) })),
    });
  });
  agent.on("onLspStateChange", (servers: LspServerState[]) => {
    bus.publish({ type: "lsp.changed", servers });
  });
  agent.on("onApprovalRequested", (request: ApprovalRequest) => {
    bus.publish({ type: "approval.requested", request });
  });
  agent.on("onClarificationRequested", (request: ClarificationRequest) => {
    bus.publish({ type: "clarification.requested", request });
  });
  agent.on("onMcpElicitationRequested", (request) => {
    bus.publish({ type: "mcp.elicitation.requested", request });
  });
  agent.on("onModelUsed", (tier: string, model: string) => {
    bus.publish({ type: "model.answered", tier, model });
  });
  agent.on("onPlanUpdate", (goal: string, steps: PlanStep[], status: "running" | "completed" | "failed") => {
    bus.publish({ type: "conversation.plan", goal, steps: toExecutionSteps(steps), status });
  });
  agent.on("onMissionStarted", (goal: string) => {
    bus.publish({ type: "mission.started", goal });
  });
  agent.on("onMissionPhase", (id: MissionPhaseId, status: MissionPhase["status"]) => {
    bus.publish({ type: "mission.phase", id, status });
  });
  agent.on("onMissionStep", (step: PlanStep) => {
    bus.publish({ type: "mission.step", step });
  });
  agent.on(
    "onUsage",
    (info: { promptTokens: number; completionTokens: number; tokensPerSecond: number; latencyMs: number }) => {
      const used = info.promptTokens + info.completionTokens;
      bus.publish({ type: "context.changed", used, limit: 0, latencyMs: info.latencyMs });
      bus.publish({ type: "usage.changed", promptTokens: info.promptTokens, completionTokens: info.completionTokens });
    },
  );
}
