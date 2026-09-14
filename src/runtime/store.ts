/**
 * Central state store. The single source of truth the renderer reads.
 *
 * Events flow: actors -> EventBus -> Store.apply -> subscribers (renderer).
 * No business logic lives in rendering; it all terminates here.
 */

import { EventBus, RuntimeEvent } from "./events/bus.js";
import { applyTaskTransition } from "./task-machine.js";
import { ACTOR_IDS, ActorId, ActorState, ChatEntry, RuntimeState, Task, ThemeName, ToolCall } from "./types.js";
import { createMissionState, deriveMissionPhases, missionCrumb } from "./mission-derive.js";

/** Bounded buffer sizes so long sessions can't grow state without limit. */
// NOTE: Buffer limits are now configurable via `src/runtime/config.ts`. This file
// reads the values from environment variables (or falls back to sensible defaults).
// Moving the constants out of this file keeps the reducer pure and makes it easy
// for CI or callers to adjust limits without recompiling.
import { MAX_LOGS, MAX_CONVERSATION, MAX_TOOL_CALLS, MAX_NOTIFICATIONS } from "./config.js";

// Strips ANSI/C0/C1 control sequences from text before it lands in state,
// so tool or shell output emitting screen-clear/cursor-addressing/title-set
// (or hostile) escape sequences can't corrupt the fixed layout. Preserves
// printable characters, newlines, and tabs; \r is stripped since Ink has no
// concept of "rewind the line".
/* eslint-disable no-control-regex -- intentionally matching C0/C1 control chars to strip them */
export function sanitizeText(text: string): string {
  return (
    text
      // CSI sequences, including private-mode forms such as ESC[?25l (hide
      // cursor) and ESC[?1049h (alternate screen). The parameter class must
      // allow the private-marker and intermediate bytes or those sequences
      // fell through to the control-character pass below, which stripped only
      // the ESC and left "[?25l" as visible garbage in the layout.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // OSC (window title, hyperlinks), terminated by BEL or ST.
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
      // Charset designation, e.g. ESC(B — an intermediate byte then a final.
      .replace(/\x1b[ -/]+[0-~]/g, "")
      // Remaining single-character escapes (ESC7, ESC=, ESCM, ...). "[" and
      // "]" are excluded above by construction so this can't eat a CSI/OSC
      // introducer whose body was malformed.
      .replace(/\x1b[@-Z\\-_]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}
/* eslint-enable no-control-regex */

export interface InitialStateOptions {
  workspace?: string;
  branch?: string;
  model?: string;
  provider?: string;
  contextLimit?: number;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  /** Initial color theme (from config/env); defaults to "default". */
  theme?: ThemeName;
}

export function initialRuntimeState(opts: InitialStateOptions = {}): RuntimeState {
  const actors = {} as Record<ActorId, ActorState>;
  for (const id of ACTOR_IDS) {
    actors[id] = { id, health: "muted", detail: "" };
  }
  actors.conversation.health = "healthy";
  return {
    session: {
      workspace: opts.workspace ?? "",
      branch: opts.branch ?? "",
      startedAt: Date.now(),
    },
    mission: createMissionState(""),
    mode: "idle",
    agentMode: "code",
    status: "",
    lastTurnModel: null,
    actors,
    conversation: [],
    execution: {
      goal: "",
      steps: [],
      currentStepId: null,
      activeTool: null,
      queue: [],
      etaSeconds: null,
      reasoning: "",
    },
    tasks: [],
    toolCalls: [],
    logs: [],
    memory: [],
    memorySummary: "",
    git: { branch: opts.branch ?? "", ahead: 0, behind: 0, files: [] },
    model: {
      provider: opts.provider ?? "local",
      name: opts.model ?? "",
      streaming: false,
      tokensPerSecond: 0,
      latencyMs: 0,
      contextUsed: 0,
      contextLimit: opts.contextLimit ?? 0,
    },
    usage: { totalPromptTokens: 0, totalCompletionTokens: 0 },
    mcpServers: [],
    lspServers: [],
    skills: [],
    diagnosticsByPath: {},
    approval: null,
    clarification: null,
    notifications: [],
    lastError: null,
    theme: opts.theme ?? "default",
    pricing: opts.pricing,
  };
}

// Monotonic counter, not `notifications.length`: once the buffer is full
// `bounded()` pins that length at MAX_NOTIFICATIONS, so two notifications
// raised in the same millisecond got identical ids — and these are React keys.
let notificationSeq = 0;
function nextNotificationId(): string {
  return `n${Date.now()}-${notificationSeq++}`;
}

function bounded<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

function withActor(state: RuntimeState, id: ActorId, patch: Partial<Omit<ActorState, "id">>): RuntimeState {
  return { ...state, actors: { ...state.actors, [id]: { ...state.actors[id], ...patch } } };
}

function appendChunk(
  conversation: ChatEntry[],
  role: "assistant" | "thinking",
  chunk: string,
  model?: string,
  crumb?: string,
): ChatEntry[] {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const entry = conversation[i];
    if (entry.kind === "text" && entry.role === role) {
      const updated: ChatEntry = { ...entry, text: entry.text + chunk };
      const next = [...conversation];
      next[i] = updated;
      return next;
    }
    if (entry.kind === "text" && entry.role === "user") break;
    if (entry.kind === "tool_call") break;
  }
  // Stamped once, at entry creation — a turn's answering model doesn't change mid-stream.
  return bounded(
    [...conversation, { kind: "text", role, text: chunk, at: Date.now(), model, crumb }],
    MAX_CONVERSATION,
  );
}

function taskDetail(tasks: Task[]): string {
  const active = tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "blocked");
  return active.length > 0 ? String(active.length) : "✓";
}

export function reduce(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  switch (event.type) {
    case "conversation.message": {
      const entry: ChatEntry = {
        kind: "text",
        role: event.role,
        text: sanitizeText(event.text),
        at: Date.now(),
        crumb: missionCrumb(state.mission),
      };
      // A new user turn starts fresh — any prior turn's delegation label must not
      // bleed into this one if classifyCapability doesn't delegate this time.
      const lastTurnModel = event.role === "user" ? null : state.lastTurnModel;
      return withActor(
        { ...state, lastTurnModel, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "conversation",
        { health: "healthy" },
      );
    }
    case "conversation.chunk": {
      const modelLabel = state.lastTurnModel ?? `${state.model.provider}/${state.model.name}`;
      const next = {
        ...state,
        conversation: appendChunk(
          state.conversation,
          event.role,
          sanitizeText(event.chunk),
          modelLabel,
          missionCrumb(state.mission),
        ),
      };
      return withActor(next, "conversation", { health: event.role === "thinking" ? "thinking" : "active" });
    }
    case "conversation.clear":
      return { ...state, conversation: [] };
    case "conversation.plan": {
      const entry: ChatEntry = {
        kind: "plan",
        role: "assistant",
        steps: event.steps,
        status: event.status,
        at: Date.now(),
      };
      return withActor(
        {
          ...state,
          execution: { ...state.execution, goal: event.goal, steps: event.steps },
          conversation: bounded([...state.conversation, entry], MAX_CONVERSATION),
        },
        "planner",
        { health: event.status === "running" ? "thinking" : "healthy", detail: event.status === "running" ? "▶" : "✓" },
      );
    }
    case "conversation.decision": {
      const entry: ChatEntry = {
        kind: "decision",
        role: "assistant",
        options: event.options,
        selected: event.selected,
        reason: event.reason,
        confidence: event.confidence,
        at: Date.now(),
      };
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "planner",
        { health: "healthy", detail: "✓" },
      );
    }
    case "conversation.tool_call": {
      const existingIdx = state.conversation.findIndex((e) => e.kind === "tool_call" && e.id === event.id);
      const existing = existingIdx >= 0 ? state.conversation[existingIdx] : undefined;
      const entry: ChatEntry = {
        kind: "tool_call",
        role: "assistant",
        id: event.id,
        name: event.name,
        args: event.args,
        status: event.status,
        result: event.result,
        error: event.error,
        at: Date.now(),
        // Preserve the crumb captured when this call started — a later
        // update shouldn't reattribute it to whatever phase is running now.
        crumb: existing && existing.kind === "tool_call" ? existing.crumb : missionCrumb(state.mission),
      };
      const updatedConversation =
        existingIdx >= 0
          ? [...state.conversation.slice(0, existingIdx), entry, ...state.conversation.slice(existingIdx + 1)]
          : [...state.conversation, entry];
      const actorHealth = event.status === "failed" ? "error" : event.status === "running" ? "active" : "healthy";
      return withActor(
        {
          ...state,
          conversation: bounded(updatedConversation, MAX_CONVERSATION),
          execution: {
            ...state.execution,
            activeTool: event.status === "running" ? event.name : state.execution.activeTool,
          },
        },
        "executor",
        { health: actorHealth, detail: event.status === "running" ? "▶" : event.status === "failed" ? "✗" : "✓" },
      );
    }
    case "conversation.diff": {
      const entry: ChatEntry = {
        kind: "diff_preview",
        role: "assistant",
        filePath: event.filePath,
        diff: event.diff,
        status: event.status,
        at: Date.now(),
        crumb: missionCrumb(state.mission),
      };
      return withActor(
        { ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) },
        "executor",
        { health: "healthy", detail: "✓" },
      );
    }
    case "conversation.test_result": {
      const entry: ChatEntry = {
        kind: "test_result",
        role: "assistant",
        command: event.command,
        passed: event.passed,
        failed: event.failed,
        failures: event.failures,
        durationMs: event.durationMs,
        at: Date.now(),
        crumb: missionCrumb(state.mission),
      };
      const actorHealth = event.failed > 0 ? "error" : "healthy";
      return withActor(
        {
          ...state,
          conversation: bounded([...state.conversation, entry], MAX_CONVERSATION),
          lastTestResult: {
            command: event.command,
            passed: event.passed,
            failed: event.failed,
            failures: event.failures,
            durationMs: event.durationMs,
            at: Date.now(),
          },
        },
        "executor",
        { health: actorHealth, detail: event.failed > 0 ? `✗${event.failed}` : "✓" },
      );
    }
    case "conversation.card": {
      const entry: ChatEntry = {
        kind: "card",
        role: "assistant",
        title: event.title,
        status: event.status,
        items: event.items,
        at: Date.now(),
        crumb: missionCrumb(state.mission),
      };
      return withActor({ ...state, conversation: bounded([...state.conversation, entry], MAX_CONVERSATION) }, "tasks", {
        health: event.status === "running" ? "active" : "healthy",
        detail: event.status === "running" ? "▶" : "✓",
      });
    }
    case "conversation.card_item": {
      const last = state.conversation[state.conversation.length - 1];
      if (last && last.kind === "card" && last.title === event.title) {
        const updatedItems = last.items.map((item) =>
          item.label === event.label ? { ...item, status: event.status, detail: event.detail ?? item.detail } : item,
        );
        const updatedEntry: ChatEntry = { ...last, items: updatedItems };
        return withActor(
          { ...state, conversation: bounded([...state.conversation.slice(0, -1), updatedEntry], MAX_CONVERSATION) },
          "tasks",
          { health: event.status === "running" ? "active" : "healthy", detail: event.status as string },
        );
      }
      return state;
    }
    case "task.created": {
      const tasks = [...state.tasks.filter((t) => t.id !== event.task.id), event.task];
      return withActor({ ...state, tasks }, "tasks", { health: "active", detail: taskDetail(tasks) });
    }
    case "task.progress": {
      const tasks = applyTaskTransition(state.tasks, event.taskId, event.status, event.progress);
      const anyFailed = tasks.some((t) => t.status === "failed");
      return withActor({ ...state, tasks }, "tasks", {
        health: anyFailed ? "error" : tasks.some((t) => t.status === "running") ? "active" : "healthy",
        detail: taskDetail(tasks),
      });
    }
    case "tool.started": {
      const call: ToolCall = {
        id: event.id,
        name: event.name,
        args: event.args,
        status: "running",
        startedAt: Date.now(),
      };
      const next = {
        ...state,
        toolCalls: bounded([...state.toolCalls, call], MAX_TOOL_CALLS),
        execution: { ...state.execution, activeTool: event.name },
      };
      return withActor(next, "executor", { health: "active", detail: "▶" });
    }
    case "tool.completed":
    case "tool.failed": {
      const failed = event.type === "tool.failed";
      const toolCalls = state.toolCalls.map((c) =>
        c.id === event.id
          ? {
              ...c,
              status: failed ? ("failed" as const) : ("completed" as const),
              endedAt: Date.now(),
              result: failed ? c.result : (event as { result: Record<string, unknown> }).result,
              error: failed ? (event as { error: string }).error : c.error,
            }
          : c,
      );
      const stillRunning = toolCalls.some((c) => c.status === "running");
      const next = {
        ...state,
        toolCalls,
        execution: { ...state.execution, activeTool: stillRunning ? state.execution.activeTool : null },
      };
      return withActor(next, "executor", {
        health: failed ? "error" : stillRunning ? "active" : "healthy",
        detail: stillRunning ? "▶" : failed ? "✗" : "✓",
      });
    }
    case "model.streaming": {
      const model = {
        ...state.model,
        streaming: event.streaming,
        tokensPerSecond: event.tokensPerSecond ?? (event.streaming ? state.model.tokensPerSecond : 0),
      };
      return withActor({ ...state, model }, "models", {
        health: event.streaming ? "thinking" : "healthy",
        detail: event.streaming ? "▶" : "✓",
      });
    }
    case "model.changed": {
      const model = { ...state.model, name: event.name, provider: event.provider ?? state.model.provider };
      return withActor({ ...state, model }, "models", { health: "healthy" });
    }
    case "context.changed":
      return {
        ...state,
        model: {
          ...state.model,
          contextUsed: event.used,
          contextLimit: event.limit,
          latencyMs: event.latencyMs ?? state.model.latencyMs,
        },
      };
    case "usage.changed":
      return {
        ...state,
        usage: {
          totalPromptTokens: state.usage.totalPromptTokens + event.promptTokens,
          totalCompletionTokens: state.usage.totalCompletionTokens + event.completionTokens,
        },
      };
    case "theme.changed":
      // Presentation concern: the reducer records the selected theme in
      // state; the UI layer (App) applies it to the palette module. The
      // state layer must not import UI code (review item 12).
      return { ...state, theme: event.theme };
    case "git.changed":
      return withActor({ ...state, git: event.git }, "git", {
        health: event.git.files.length > 0 ? "waiting" : "healthy",
        detail: event.git.files.length > 0 ? String(event.git.files.length) : "✓",
      });
    case "logs.appended": {
      const entry = {
        at: Date.now(),
        level: event.level,
        source: event.source,
        message: sanitizeText(event.message),
      };
      const logs = bounded([...state.logs, entry], MAX_LOGS);
      return withActor({ ...state, logs }, "logs", {
        health: event.level === "error" ? "error" : state.actors.logs.health === "error" ? "error" : "healthy",
        detail: String(logs.length),
      });
    }
    case "memory.updated": {
      const next = {
        ...state,
        memory: event.items ?? state.memory,
        memorySummary: event.summary ?? state.memorySummary,
      };
      return withActor(next, "memory", { health: "healthy", detail: "✓" });
    }
    case "mcp.changed": {
      const anyDown = event.servers.some((s) => !s.connected);
      return withActor({ ...state, mcpServers: event.servers }, "mcp", {
        health: event.servers.length === 0 ? "muted" : anyDown ? "error" : "healthy",
        detail: anyDown ? "✗" : "✓",
      });
    }
    case "lsp.changed": {
      const servers = event.servers;
      const anyError = servers.some((s) => s.status === "error");
      const anyRunning = servers.some((s) => s.status === "running");
      const detail = servers
        .filter((s) => s.status === "running")
        .map((s) => s.language.slice(0, 2))
        .join(" ");
      return withActor({ ...state, lspServers: servers }, "lsp", {
        health: servers.length === 0 ? "muted" : anyError ? "error" : anyRunning ? "healthy" : "waiting",
        detail: detail || "—",
      });
    }
    case "lsp.diagnostics": {
      const diagnosticsByPath = { ...state.diagnosticsByPath };
      if (event.count > 0) diagnosticsByPath[event.path] = event.count;
      else delete diagnosticsByPath[event.path];
      return withActor({ ...state, diagnosticsByPath }, "lsp", {
        health: event.count > 0 ? "waiting" : "healthy",
        detail: event.count > 0 ? `${event.count}✗` : state.actors.lsp.detail,
      });
    }
    case "rails.index": {
      return {
        ...state,
        rails: {
          status: event.status,
          entityCount: event.entityCount ?? 0,
          edgeCount: event.edgeCount ?? 0,
          scannerErrors: event.scannerErrors ?? [],
          railsVersion: event.railsVersion,
          rubyVersion: event.rubyVersion,
          testFramework: event.testFramework,
          byType: event.byType,
        },
      };
    }
    case "skills.changed": {
      const anyActive = event.skills.some((s) => s.active);
      return withActor({ ...state, skills: event.skills }, "skills", {
        health: event.skills.length === 0 ? "muted" : anyActive ? "active" : "healthy",
        detail: anyActive ? String(event.skills.filter((s) => s.active).length) : "✓",
      });
    }
    case "approval.requested":
      return withActor({ ...state, approval: event.request, mode: "approval" }, "executor", {
        health: "waiting",
        detail: "?",
      });
    case "approval.resolved": {
      if (!state.approval || state.approval.id !== event.id) return state;
      return { ...state, approval: null, mode: "idle" };
    }
    case "clarification.requested":
      return withActor({ ...state, clarification: event.request, mode: "clarification" }, "conversation", {
        health: "waiting",
        detail: "?",
      });
    case "clarification.resolved": {
      if (!state.clarification || state.clarification.id !== event.response.id) return state;
      return { ...state, clarification: null, mode: "idle" };
    }
    case "execution.goal":
      return withActor(
        {
          ...state,
          execution: { ...state.execution, goal: event.goal, steps: event.steps, currentStepId: null },
          mode: "planning",
        },
        "planner",
        { health: "thinking", detail: "▶" },
      );
    case "execution.step": {
      const known = state.execution.steps.some((s) => s.id === event.step.id);
      const steps = known
        ? state.execution.steps.map((s) => (s.id === event.step.id ? event.step : s))
        : [...state.execution.steps, event.step];
      const currentStepId = event.step.status === "running" ? event.step.id : state.execution.currentStepId;
      const done = steps.every((s) => s.status !== "pending" && s.status !== "running");
      return withActor({ ...state, execution: { ...state.execution, steps, currentStepId } }, "planner", {
        health: done ? "healthy" : "thinking",
        detail: done ? "✓" : "▶",
      });
    }
    case "execution.queue":
      return {
        ...state,
        execution: { ...state.execution, queue: event.queue, etaSeconds: event.etaSeconds ?? null },
      };
    case "execution.reasoning":
      return { ...state, execution: { ...state.execution, reasoning: sanitizeText(event.text) } };
    case "mission.started":
      return { ...state, mission: createMissionState(event.goal) };
    case "mission.phase": {
      const now = Date.now();
      const phases = state.mission.phases.map((p) => {
        if (p.id !== event.id) return p;
        const startedAt = p.startedAt ?? (event.status === "running" ? now : p.startedAt);
        const endedAt = event.status === "completed" || event.status === "failed" ? now : p.endedAt;
        return { ...p, status: event.status, startedAt, endedAt };
      });
      return { ...state, mission: { ...state.mission, phases } };
    }
    case "mission.step": {
      const known = state.mission.steps.some((s) => s.id === event.step.id);
      const steps = known
        ? state.mission.steps.map((s) => (s.id === event.step.id ? event.step : s))
        : [...state.mission.steps, event.step];
      const phases = deriveMissionPhases(state.mission.phases, steps);
      return { ...state, mission: { ...state.mission, steps, phases } };
    }
    case "project.detected":
      return { ...state, project: event.info };
    case "sandbox.detected":
      return { ...state, sandboxAvailable: event.available, sandboxEnabled: event.enabled ?? true };
    case "mode.changed":
      return { ...state, mode: event.mode };
    case "mode.agent":
      return { ...state, agentMode: event.mode };
    case "status.changed":
      return { ...state, status: event.status };
    case "model.answered":
      // Which model actually answered the turn in progress, so the next
      // conversation.chunk entry can be tagged with it (see appendChunk).
      // Sourced from Router.route's own resolved candidate (or the direct
      // provider fallback) — not parsed from a status string, since that
      // string is emitted before routing's own capability-tier widening
      // could change which model actually served the request.
      return { ...state, lastTurnModel: `${event.tier}/${event.model}` };
    case "notification": {
      const note = {
        id: nextNotificationId(),
        text: event.text,
        kind: event.kind,
        at: Date.now(),
      };
      return { ...state, notifications: bounded([...state.notifications, note], MAX_NOTIFICATIONS) };
    }
    case "error": {
      // Executor health flips to "✗" on any error, but that glyph alone gives
      // the user zero detail — surface the actual message as a notification
      // too, the same path a visible toast already uses elsewhere.
      const note = { id: nextNotificationId(), text: event.message, kind: "error" as const, at: Date.now() };
      return withActor(
        {
          ...state,
          lastError: event.message,
          notifications: bounded([...state.notifications, note], MAX_NOTIFICATIONS),
        },
        "executor",
        { health: "error", detail: "✗" },
      );
    }
    default:
      return state;
  }
}

export type StoreListener = (state: RuntimeState) => void;

export class Store {
  private state: RuntimeState;
  private listeners = new Set<StoreListener>();

  constructor(initial?: RuntimeState) {
    this.state = initial ?? initialRuntimeState();
  }

  getState(): RuntimeState {
    return this.state;
  }

  apply(event: RuntimeEvent): void {
    const next = reduce(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Wire this store as the primary subscriber of a bus. */
  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => this.apply(event));
  }
}
