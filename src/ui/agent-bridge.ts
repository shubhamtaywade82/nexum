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
  ClarificationResponse,
  ExecutionStep,
  MissionPhase,
  MissionPhaseId,
} from "../runtime/types.js";
import type { NexumClient } from "../assistant/client/index.js";
import type { NexumRunEvent } from "../protocol/types.js";
import type { McpElicitationResponse } from "../core/user-input.js";
import type { SessionMeta } from "../runtime/session.js";
import type { ShellAgent } from "./App.js";

// PlanStep tracks a fine-grained ASL (analyzing/planning/implementing/
// testing/reviewing/...); the TUI only renders the coarse 5-state model.
const STEP_STATUS_MAP: Record<StepStatus, ExecutionStep["status"]> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  analyzing: "running",
  planning: "running",
  implementing: "running",
  testing: "running",
  reviewing: "running",
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
  agent.on("onApprovalRequested", (request: ApprovalRequest) => bus.publish({ type: "approval.requested", request }));
  agent.on("onClarificationRequested", (request: ClarificationRequest) =>
    bus.publish({ type: "clarification.requested", request }),
  );
  agent.on("onMcpElicitationRequested", (request) => bus.publish({ type: "mcp.elicitation.requested", request }));
  agent.on(
    "onModelUsed",
    (tier: string, model: string, usage?: { promptTokens: number; completionTokens: number; latencyMs: number }) => {
      bus.publish({ type: "model.answered", tier, model, ...usage });
    },
  );
  agent.on("onPlanUpdate", (goal: string, steps: PlanStep[], status: "running" | "completed" | "failed") => {
    bus.publish({ type: "conversation.plan", goal, steps: toExecutionSteps(steps), status });
  });
  agent.on("onMissionStarted", (goal: string) => bus.publish({ type: "mission.started", goal }));
  agent.on("onMissionPhase", (id: MissionPhaseId, status: MissionPhase["status"]) =>
    bus.publish({ type: "mission.phase", id, status }),
  );
  agent.on("onMissionStep", (step: PlanStep) => bus.publish({ type: "mission.step", step }));
  agent.on("onUsage", (info: { promptTokens: number; completionTokens: number; latencyMs: number }) => {
    bus.publish({
      type: "context.changed",
      used: info.promptTokens + info.completionTokens,
      limit: 0,
      latencyMs: info.latencyMs,
    });
    bus.publish({ type: "usage.changed", promptTokens: info.promptTokens, completionTokens: info.completionTokens });
  });
}

function dispatchToolEvent(bus: EventBus, ev: NexumRunEvent): boolean {
  if (ev.type === "tool.started") {
    bus.publish({ type: "tool.started", id: ev.callId, name: ev.name, args: ev.args });
    bus.publish({ type: "conversation.tool_call", id: ev.callId, name: ev.name, args: ev.args, status: "running" });
    bus.publish({ type: "logs.appended", level: "info", source: "tool", message: `${ev.name} started` });
    return true;
  }
  if (ev.type === "tool.completed") {
    bus.publish({ type: "tool.completed", id: ev.callId, result: ev.result });
    bus.publish({
      type: "conversation.tool_call",
      id: ev.callId,
      name: ev.name,
      args: {},
      status: "completed",
      result: JSON.stringify(ev.result),
    });
    bus.publish({ type: "logs.appended", level: "info", source: "tool", message: `${ev.name} completed` });
    return true;
  }
  return false;
}

function dispatchInteractionEvent(bus: EventBus, ev: NexumRunEvent): boolean {
  if (ev.type === "run.approval.required") {
    bus.publish({
      type: "approval.requested",
      request: {
        id: ev.interactionId,
        title: ev.title,
        summary: ev.summary,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
    });
    return true;
  }
  if (ev.type === "run.approval.resolved") {
    bus.publish({ type: "approval.resolved", id: ev.interactionId, approved: ev.approved });
    return true;
  }
  if (ev.type === "run.clarification.required") {
    bus.publish({
      type: "clarification.requested",
      request: { id: ev.interactionId, prompt: ev.question, question: ev.question, options: ev.options },
    });
    return true;
  }
  if (ev.type === "run.clarification.resolved") {
    bus.publish({ type: "clarification.resolved", response: { id: ev.interactionId, selectedId: ev.selectedId } });
    return true;
  }
  return false;
}

function dispatchMcpElicitation(bus: EventBus, ev: NexumRunEvent): boolean {
  if (ev.type === "run.mcp_elicitation.required") {
    bus.publish({
      type: "mcp.elicitation.requested",
      request: { id: ev.interactionId, serverId: ev.serverName, mode: "form", message: ev.prompt },
    });
    return true;
  }
  if (ev.type === "run.mcp_elicitation.resolved") {
    bus.publish({ type: "mcp.elicitation.resolved", response: { id: ev.interactionId, action: "accept" } });
    return true;
  }
  return false;
}

function dispatchLifecycleEvent(bus: EventBus, ev: NexumRunEvent): boolean {
  if (ev.type === "thought") {
    bus.publish({ type: "conversation.chunk", role: "thinking", chunk: ev.text });
    return true;
  }
  if (ev.type === "model.used") {
    bus.publish({ type: "model.answered", tier: ev.tier, model: ev.model });
    return true;
  }
  if (ev.type === "plan.updated") {
    const steps = ev.steps.map((s) => ({
      id: s.id,
      description: s.text,
      status: s.done ? ("completed" as const) : ("running" as const),
    }));
    bus.publish({ type: "conversation.plan", goal: ev.goal, steps, status: ev.status });
    return true;
  }
  if (ev.type === "run.completed") {
    bus.publish({ type: "conversation.chunk", role: "assistant", chunk: ev.output.content });
    bus.publish({ type: "status.changed", status: "completed" });
    return true;
  }
  if (ev.type === "run.failed") {
    bus.publish({ type: "error", message: ev.error });
    return true;
  }
  if (ev.type === "run.interrupted") {
    bus.publish({ type: "error", message: `Run interrupted: ${ev.reason}` });
    return true;
  }
  return false;
}

export function dispatchServerEvent(bus: EventBus, ev: NexumRunEvent): void {
  if (dispatchToolEvent(bus, ev)) return;
  if (dispatchInteractionEvent(bus, ev)) return;
  if (dispatchMcpElicitation(bus, ev)) return;
  dispatchLifecycleEvent(bus, ev);
}

export interface RemoteAgentOptions {
  sessionId?: string;
}

export function createRemoteAgentBridge(
  client: NexumClient,
  bus: EventBus,
  options: RemoteAgentOptions = {},
): ShellAgent {
  let activeSessionId = options.sessionId;
  let activeRunId: string | null = null;
  let cachedSessions: SessionMeta[] = [];

  const refreshSessions = async (): Promise<void> => {
    try {
      const summaries = await client.listSessions();
      cachedSessions = summaries.map((s) => ({
        id: s.id,
        startedAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        firstUserLine: s.title ?? "Remote Session",
      }));
    } catch {
      // Retain existing cached list on network glitch
    }
  };

  void refreshSessions();

  return {
    async runUserMessage(message: string): Promise<unknown> {
      if (!activeSessionId) {
        const title = message.slice(0, 50).trim();
        const sess = await client.createSession({ title });
        activeSessionId = sess.id;
        void refreshSessions();
      }
      const run = await client.createRun(activeSessionId, message);
      activeRunId = run.id;
      try {
        for await (const env of client.streamEvents(run.id)) {
          dispatchServerEvent(bus, env.payload);
        }
      } finally {
        activeRunId = null;
      }
      return run;
    },
    resolveApproval(id: string, approved: boolean): void {
      if (activeRunId) {
        client.resolveInteraction(activeRunId, id, { approved }).catch(() => {});
      }
    },
    resolveClarification(response: ClarificationResponse): void {
      if (activeRunId) {
        client.resolveInteraction(activeRunId, response.id, { selectedId: response.selectedId }).catch(() => {});
      }
    },
    resolveMcpElicitation(response: McpElicitationResponse): void {
      if (activeRunId) {
        const text = response.action === "accept" ? JSON.stringify(response.content ?? {}) : undefined;
        client.resolveInteraction(activeRunId, response.id, { response: text }).catch(() => {});
      }
    },
    listSessions(): SessionMeta[] {
      return cachedSessions;
    },
    hasResumableSession(): boolean {
      return cachedSessions.length > 0;
    },
    resumeSessionById(id: string): Array<{ role: string; content: string }> | null {
      activeSessionId = id;
      client.getSession(id).catch(() => {});
      return null;
    },
  };
}
