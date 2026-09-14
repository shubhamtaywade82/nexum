/**
 * Derived views for the two permanent bottom strips.
 *
 * Activity Strip: live health of all actors, always visible, never navigation.
 * Context Strip: dynamic status for the current runtime mode.
 */

import {
  ActorHealth,
  AGENT_MODE_LABELS,
  PRIMARY_VIEW_LABELS,
  PRIMARY_VIEWS,
  RuntimeState,
  StatusToken,
  ViewId,
} from "../../runtime/types.js";
import { semanticColor } from "./theme-map.js";

/** Primary nav tabs: five workspace views, active one highlighted. Secondary
 * actors (Mem/Mdl/MCP/Skl/LSP) surface as header health tokens instead —
 * they never deserved the same navigational prominence as Chat. */
export function activityStripTokens(_state: RuntimeState, activeView?: ViewId): StatusToken[] {
  const tokens: StatusToken[] = PRIMARY_VIEWS.map((id, i) => {
    const active = activeView === id || (activeView === "dashboard" && id === "conversation");
    return {
      text: active ? `[${PRIMARY_VIEW_LABELS[id]}]` : ` ${PRIMARY_VIEW_LABELS[id]} `,
      priority: i + 1,
      color: semanticColor(active ? "active" : "muted"),
    };
  });
  tokens.push({ text: "Ctrl+P Palette", priority: 20, color: semanticColor("muted") });
  return tokens;
}

/** Only computed when the user has configured a real rate (config.pricing /
 * DEVAGENT_PRICE_*_PER_M) — Ollama has no published per-token price, so
 * there is no default rate to compute this from. Returns null (not 0) when
 * there's nothing to bill, so callers never show a fabricated "$0.000". */
function computeCost(state: RuntimeState): number | null {
  if (!state.pricing) return null;
  const cost =
    (state.usage.totalPromptTokens / 1_000_000) * state.pricing.inputPerMillion +
    (state.usage.totalCompletionTokens / 1_000_000) * state.pricing.outputPerMillion;
  return cost > 0 ? cost : null;
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function contextPercent(state: RuntimeState): string | null {
  if (state.model.contextLimit <= 0) return null;
  return `ctx${Math.round((state.model.contextUsed / state.model.contextLimit) * 100)}%`;
}

function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

export function contextStripTokens(state: RuntimeState, activeView?: ViewId, now: number = Date.now()): StatusToken[] {
  const tokens: StatusToken[] = [];
  const push = (text: string, priority: number, health?: ActorHealth) =>
    tokens.push({ text, priority, color: health ? semanticColor(health) : undefined });

  // View-specific strips take over while idle: the strip always shows the
  // most relevant live state for what the user is looking at.
  if (state.mode === "idle" && activeView === "git") {
    push(`Branch:${state.git.branch || "-"}`, 1, "active");
    push(`Modified:${state.git.files.length}`, 2);
    push(`Ahead:${state.git.ahead}`, 3);
    push(`Behind:${state.git.behind}`, 4);
    return tokens;
  }
  if (state.mode === "idle" && activeView === "logs") {
    const count = (level: string) => state.logs.filter((l) => l.level === level).length;
    push(`INFO:${count("info")}`, 1, "active");
    push(`WARN:${count("warn")}`, 2, "waiting");
    push(`ERROR:${count("error")}`, 3, count("error") > 0 ? "error" : "healthy");
    push("End Follow", 4, "muted");
    return tokens;
  }
  if (state.mode === "idle" && activeView === "memory") {
    push(`Memories:${state.memory.length}`, 1, "active");
    if (state.memorySummary) push("Summary ready", 2, "healthy");
    return tokens;
  }

  switch (state.mode) {
    case "idle": {
      // Mode/Model now live in the top Header — this row is the footer
      // status line: connection/sandbox/git, then usage figures.
      push("● Connected", 1, "healthy");
      if (state.sandboxEnabled === false) {
        push("⊞ Host (No Sandbox)", 2, "active");
      } else if (state.sandboxAvailable != null) {
        push(state.sandboxAvailable ? "⊞ Sandbox ✓" : "⊞ Sandbox ✗", 2, state.sandboxAvailable ? "healthy" : "error");
      }
      const branch = state.git.branch || state.session.branch;
      if (branch) push(`🔀 Git ${branch}`, 3, "active");
      if (state.model.contextLimit > 0) {
        push(`Context: ${formatK(state.model.contextUsed)} / ${formatK(state.model.contextLimit)} tokens`, 4);
      }
      const cost = computeCost(state);
      if (cost != null) push(`Cost: $${cost.toFixed(4)}`, 5);
      if (state.model.latencyMs > 0) push(`Latency: ${state.model.latencyMs}ms`, 6);
      if (state.session.startedAt > 0) push(`⏱ ${formatElapsed(now - state.session.startedAt)}`, 7);
      break;
    }
    case "planning": {
      push("Planning", 1, "thinking");
      const total = state.execution.steps.length;
      const idx = state.execution.steps.findIndex((s) => s.id === state.execution.currentStepId);
      if (total > 0) push(`Step ${idx >= 0 ? idx + 1 : 1}/${total}`, 2);
      if (state.status) push(state.status, 3);
      const ctx = contextPercent(state);
      if (ctx) push(ctx, 4);
      push("Esc Cancel", 5, "muted");
      break;
    }
    case "editing": {
      push(`Tool:${state.execution.activeTool ?? "edit"}`, 1, "active");
      if (state.status) push(state.status, 2);
      push("Ctrl+Z Undo", 5, "muted");
      break;
    }
    case "testing": {
      push(`Tool:${state.execution.activeTool ?? "tests"}`, 1, "active");
      if (state.status) push(state.status, 2);
      if (state.execution.etaSeconds != null) push(`ETA ${formatEta(state.execution.etaSeconds)}`, 3);
      push("Ctrl+C Stop", 4, "muted");
      break;
    }
    case "approval": {
      push("Waiting for approval", 1, "waiting");
      if (state.approval) {
        push(`${state.approval.filesChanged} files +${state.approval.additions} -${state.approval.deletions}`, 2);
      }
      push("Enter Approve", 3, "muted");
      push("N Reject", 4, "muted");
      push("D View Diff", 5, "muted");
      break;
    }
    case "streaming": {
      push("Generating...", 1, "thinking");
      if (state.model.tokensPerSecond > 0) push(`${Math.round(state.model.tokensPerSecond)} tok/s`, 2);
      if (state.model.contextUsed > 0) push(`${formatK(state.model.contextUsed)} tokens`, 3);
      push("Ctrl+C Stop Generation", 4, "muted");
      break;
    }
  }
  return tokens;
}

function formatEta(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const MODE_LABELS: Record<RuntimeState["mode"], string> = {
  idle: "IDLE",
  planning: "PLANNING",
  editing: "EDITING",
  testing: "TESTING",
  approval: "APPROVAL",
  clarification: "CLARIFY",
  streaming: "STREAMING",
};

// Deliberate, distinct priority per token — lower sheds later on a narrow
// terminal. Previously several unrelated tokens shared a number (model/cloud
// tag/agent-mode all at 2; workspace/runtime-mode both at 3; rails/skills
// both at 10), so which one survived a width squeeze came down to array
// insertion order rather than an actual importance call. Ranked here by what
// you'd miss most first: identity > what's answering > what it's doing right
// now > where > secondary code-intelligence status > clock.
const HEADER_PRIORITY = {
  product: 1,
  model: 2,
  agentMode: 3,
  runtimeMode: 4,
  workspace: 5,
  language: 5.5, // between workspace and cloudTag without renumbering the rest
  cloudTag: 6,
  branch: 7,
  contextPct: 8,
  gitDirty: 9,
  memory: 10,
  lsp: 11,
  mcp: 11.5, // between lsp and rails without renumbering the rest
  rails: 12,
  skills: 13,
  clock: 14,
  mission: 15,
} as const;

/** Header zone: product, workspace, model, branch, context usage, mode, state, clock. */
export function headerTokens(state: RuntimeState, now: number = Date.now()): StatusToken[] {
  const tokens: StatusToken[] = [
    { text: "Nexum", priority: HEADER_PRIORITY.product, color: semanticColor("thinking") },
  ];
  if (state.model.name) {
    tokens.push({ text: state.model.name, priority: HEADER_PRIORITY.model, color: semanticColor("active") });
  }
  const am = AGENT_MODE_LABELS[state.agentMode];
  tokens.push({ text: am.label, priority: HEADER_PRIORITY.agentMode, color: semanticColor("active") });
  tokens.push({
    text: MODE_LABELS[state.mode],
    priority: HEADER_PRIORITY.runtimeMode,
    color: semanticColor(state.mode === "idle" ? "healthy" : state.mode === "approval" ? "waiting" : "thinking"),
  });
  if (state.session.workspace) tokens.push({ text: state.session.workspace, priority: HEADER_PRIORITY.workspace });
  if (state.project?.language)
    tokens.push({ text: state.project.language, priority: HEADER_PRIORITY.language, color: semanticColor("muted") });
  if (state.model.provider === "cloud") {
    tokens.push({ text: "☁ cloud", priority: HEADER_PRIORITY.cloudTag, color: semanticColor("thinking") });
  }
  const branch = state.git.branch || state.session.branch;
  if (branch) tokens.push({ text: `⎇ ${branch}`, priority: HEADER_PRIORITY.branch });
  const ctx = contextPercent(state);
  if (ctx) tokens.push({ text: ctx, priority: HEADER_PRIORITY.contextPct });
  // Git status
  if (state.git.files.length > 0) {
    tokens.push({
      text: `Git:${state.git.files.length}m`,
      priority: HEADER_PRIORITY.gitDirty,
      color: semanticColor("waiting"),
    });
  }
  // Memory status
  if (state.memory.length > 0) {
    tokens.push({
      text: `Mem:${state.memory.length}`,
      priority: HEADER_PRIORITY.memory,
      color: semanticColor("healthy"),
    });
  }
  // LSP status — only worth header space when something's wrong.
  const lspErrors = state.lspServers.reduce((sum, s) => sum + s.errorCount, 0);
  if (lspErrors > 0) {
    tokens.push({ text: `LSP:${lspErrors}✗`, priority: HEADER_PRIORITY.lsp, color: semanticColor("error") });
  }
  // MCP status — only when a configured server is down.
  const mcpDown = state.mcpServers.filter((s) => !s.connected).length;
  if (mcpDown > 0) {
    tokens.push({ text: `MCP:${mcpDown}✗`, priority: HEADER_PRIORITY.mcp, color: semanticColor("error") });
  }
  // Rails status
  if (state.rails && state.rails.status !== "disabled") {
    tokens.push({
      text: `Rails:${state.rails.status}`,
      priority: HEADER_PRIORITY.rails,
      color: semanticColor(state.rails.status === "ready" ? "healthy" : "thinking"),
    });
  }
  // Skills
  const activeSkills = state.skills.filter((s) => s.active).length;
  if (activeSkills > 0) {
    tokens.push({ text: `Skills:${activeSkills}`, priority: HEADER_PRIORITY.skills, color: semanticColor("active") });
  }
  if (state.mission.goal) {
    tokens.push({
      text: `Mission: ${state.mission.goal}`,
      priority: HEADER_PRIORITY.mission,
      color: semanticColor("active"),
    });
  }
  const clock = new Date(now);
  const hh = String(clock.getHours()).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  tokens.push({ text: `${hh}:${mm}`, priority: HEADER_PRIORITY.clock, color: semanticColor("muted") });
  return tokens;
}
