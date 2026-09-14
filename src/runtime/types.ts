/**
 * Core domain model for the Nexum agent runtime.
 *
 * The UI is a pure reflection of this state: actors are always alive,
 * views only change what is observed, never what is running.
 */

import { PlanStep } from "../orchestration/types.js";

/** The always-alive actors. Every subsystem is one of these. */
export type ActorId =
  "conversation" | "planner" | "executor" | "tasks" | "git" | "logs" | "memory" | "models" | "mcp" | "skills" | "lsp";

export const ACTOR_IDS: readonly ActorId[] = [
  "conversation",
  "planner",
  "executor",
  "tasks",
  "git",
  "logs",
  "memory",
  "models",
  "mcp",
  "skills",
  "lsp",
];

/** Semantic health of an actor, mapped 1:1 to theme colors. */
export type ActorHealth = "healthy" | "active" | "waiting" | "error" | "thinking" | "muted";

/**
 * Built-in color themes. The first three are Nexum-native palettes kept
 * byte-compatible with the pre-theme-registry era; the rest are vendored
 * from the termcn (ink-ui) registry under src/tui/ui/lib/terminal-themes/.
 * The mapping ThemeName -> Theme tokens lives in src/tui/ui/theme-registry.ts.
 */
export type ThemeName =
  | "default"
  | "midnight"
  | "solarized"
  | "dracula"
  | "nord"
  | "github"
  | "gruvbox"
  | "tokyo-night"
  | "monokai"
  | "catppuccin"
  | "one-dark"
  | "vercel"
  | "high-contrast"
  | "high-contrast-light"
  | "matrix";

/** Cycle order for "/theme" without arguments (next-theme). */
export const THEME_ORDER: readonly ThemeName[] = [
  "default",
  "midnight",
  "solarized",
  "dracula",
  "nord",
  "github",
  "gruvbox",
  "tokyo-night",
  "monokai",
  "catppuccin",
  "one-dark",
  "vercel",
  "high-contrast",
  "high-contrast-light",
  "matrix",
];

export interface ActorState {
  id: ActorId;
  health: ActorHealth;
  /** Short live detail, e.g. a count ("3") or a glyph-worthy summary. */
  detail: string;
}

/** The focusable views of the Active View zone. Focus never stops actors. */
export type ViewId =
  | "conversation"
  | "execution"
  | "tasks"
  | "git"
  | "logs"
  | "memory"
  | "models"
  | "mcp"
  | "lsp"
  | "files"
  | "settings"
  | "context"
  | "rails"
  | "timeline"
  | "dashboard";

export const VIEW_ORDER: readonly ViewId[] = [
  "conversation",
  "execution",
  "tasks",
  "git",
  "logs",
  "memory",
  "models",
  "mcp",
  "lsp",
  "files",
  "settings",
  "context",
  "rails",
  "timeline",
  "dashboard",
];

/** The five workspace views that get tab-strip prominence and digit keys
 * 1-5; everything else stays reachable via slash commands and the palette. */
export const PRIMARY_VIEWS = ["conversation", "execution", "tasks", "git", "logs"] as const satisfies readonly ViewId[];

export const PRIMARY_VIEW_LABELS: Record<(typeof PRIMARY_VIEWS)[number], string> = {
  conversation: "Chat",
  execution: "Plan",
  tasks: "Tasks",
  git: "Changes",
  logs: "Logs",
};

/** Runtime mode drives the Context Strip contents. */
export type RuntimeMode = "idle" | "planning" | "editing" | "testing" | "approval" | "clarification" | "streaming";

/** Agent operational modes — controls what the agent is allowed to do. */
export type AgentMode = "ask" | "code" | "architect" | "review" | "debug" | "autonomous";

export const AGENT_MODES: readonly AgentMode[] = ["ask", "code", "architect", "review", "debug", "autonomous"];

export const AGENT_MODE_LABELS: Record<AgentMode, { label: string; description: string }> = {
  ask: { label: "Ask", description: "Q&A only, no file changes" },
  code: { label: "Code", description: "Generate and apply code changes" },
  architect: { label: "Architect", description: "Design, UML, and implementation plans" },
  review: { label: "Review", description: "Analyze code quality, security, and performance" },
  debug: { label: "Debug", description: "Investigate failures using logs and tests" },
  autonomous: { label: "Autonomous", description: "Plan, edit, test, iterate until complete" },
};

export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dependencies: string[];
  /** 0..1 progress for running tasks; undefined when not measurable. */
  progress?: number;
  worker?: string;
}

export type ToolCallStatus = "running" | "completed" | "failed";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  startedAt: number;
  endedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  at: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface MemoryItem {
  key: string;
  value: string;
  kind: "repo" | "style" | "preference" | "architecture";
}

export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitState {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface ModelState {
  provider: string;
  name: string;
  streaming: boolean;
  tokensPerSecond: number;
  latencyMs: number;
  contextUsed: number;
  contextLimit: number;
}

/** Running totals across the whole TUI process, not just the current turn. */
export interface UsageState {
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface McpServerState {
  name: string;
  connected: boolean;
  latencyMs: number;
  tools: string[];
  errors: number;
}

export interface SkillState {
  id: string;
  name: string;
  tags: string[];
  active: boolean;
}

export interface LspServerState {
  language: string;
  status: "starting" | "running" | "idle" | "stopped" | "error";
  documentsCount: number;
  errorCount: number;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  summary: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  diff?: string;
}

export interface ClarificationOption {
  id: string;
  label: string;
  detail?: string;
  isCustom?: boolean;
}

export interface ClarificationRequest {
  id: string;
  prompt: string;
  question: string;
  options: ClarificationOption[];
  allowCustom?: boolean;
}

export interface ClarificationResponse {
  id: string;
  selectedId: string;
  customText?: string;
}

export type ChatRole = "user" | "assistant" | "thinking" | "tool" | "system";

export interface TestFailure {
  file: string;
  line: number;
  message: string;
}

export interface CardItem {
  label: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  detail?: string;
}

export type ChatEntry =
  // model: "tier/name" of whichever model actually answered this entry (e.g.
  // "local/minicpm5-1b" or "cloud/gemma4:31b") — only set for assistant text.
  | { kind: "text"; role: ChatRole; text: string; at: number; model?: string; crumb?: string }
  | {
      kind: "plan";
      role: "assistant";
      steps: ExecutionStep[];
      status: "pending" | "running" | "completed" | "failed";
      at: number;
    }
  | {
      kind: "decision";
      role: "assistant";
      options: string[];
      selected: string;
      reason: string;
      confidence: number;
      at: number;
    }
  // crumb: "Execute > Generate migration" — the mission phase/step active when
  // this entry was created (see mission-derive.ts's missionCrumb), used by the
  // Dashboard's Activity Feed. Undefined outside an active mission.
  | {
      kind: "tool_call";
      role: "assistant";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: ToolCallStatus;
      result?: string;
      error?: string;
      at: number;
      crumb?: string;
    }
  | {
      kind: "diff_preview";
      role: "assistant";
      filePath: string;
      diff: string;
      status: "pending_review" | "approved" | "rejected";
      at: number;
      crumb?: string;
    }
  | {
      kind: "test_result";
      role: "assistant";
      command: string;
      passed: number;
      failed: number;
      failures: TestFailure[];
      durationMs: number;
      at: number;
      crumb?: string;
    }
  | {
      kind: "card";
      role: "assistant";
      title: string;
      status: "running" | "completed" | "failed";
      items: CardItem[];
      at: number;
      crumb?: string;
    };

export interface ExecutionStep {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

export interface ExecutionState {
  goal: string;
  steps: ExecutionStep[];
  currentStepId: string | null;
  activeTool: string | null;
  /** Names of queued tools, in order. */
  queue: string[];
  etaSeconds: number | null;
  reasoning: string;
}

export interface SessionState {
  workspace: string;
  branch: string;
  startedAt: number;
}

/** Whole-mission stages, coarser than a single PlanStep's lifecycle. */
export type MissionPhaseId =
  "understand" | "inspect" | "plan" | "execute" | "validate" | "repair" | "review" | "complete";

export const MISSION_PHASE_ORDER: readonly MissionPhaseId[] = [
  "understand",
  "inspect",
  "plan",
  "execute",
  "validate",
  "repair",
  "review",
  "complete",
];

export const MISSION_PHASE_LABELS: Record<MissionPhaseId, string> = {
  understand: "Understand",
  inspect: "Inspect",
  plan: "Plan",
  execute: "Execute",
  validate: "Validate",
  repair: "Repair",
  review: "Review",
  complete: "Complete",
};

export interface MissionPhase {
  id: MissionPhaseId;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: number;
  endedAt?: number;
}

/**
 * Mission-level progress, driven by real orchestrator events (see
 * agent-bridge.ts onMissionStarted/onMissionPhase/onMissionStep) — not a
 * cosmetic checklist. `steps` are Execute's live substeps: the same
 * PlanStep[] the Orchestrator is actually running, kept at full StepStatus
 * granularity (analyzing/planning/implementing/testing/reviewing/...) so
 * Validate/Repair/Review can be derived from them (see mission-derive.ts).
 */
export interface MissionState {
  goal: string;
  phases: MissionPhase[];
  steps: PlanStep[];
}

/** One-time static project sniff (package.json/Gemfile) — see project-info.ts. */
export interface ProjectInfo {
  language?: string;
  framework?: string;
  testFramework?: string;
}

/**
 * A single unit of the status system. Lower `priority` numbers are more
 * important and survive longer as width shrinks.
 */
export interface StatusToken {
  text: string;
  priority: number;
  color?: string;
}

export interface Notification {
  id: string;
  text: string;
  kind: "info" | "success" | "warning" | "error";
  at: number;
}

/** The complete runtime state. Rendering maps this to terminal output. */
export interface RailsIndexState {
  status: "building" | "ready" | "updated" | "disabled" | "error";
  entityCount: number;
  edgeCount: number;
  scannerErrors: string[];
  railsVersion?: string;
  rubyVersion?: string;
  testFramework?: string;
  byType?: Record<string, number>;
}

export interface RuntimeState {
  session: SessionState;
  mission: MissionState;
  project?: ProjectInfo;
  /** Whether run_shell's Docker sandbox is actually reachable — checked once
   * at bootstrap (see tui/index.ts), undefined until that check resolves. */
  sandboxAvailable?: boolean;
  /** Whether the Docker sandbox is enabled (false when NEXUM_SANDBOX=false / host mode). */
  sandboxEnabled?: boolean;
  mode: RuntimeMode;
  agentMode: AgentMode;
  status: string;
  // "tier/name" of the model delegated-to for the turn in progress, or null when
  // the primary model is answering. Reset to null on each new user message,
  // set by "delegating task to X" status lines, cleared by "escalating to..." ones.
  lastTurnModel: string | null;
  actors: Record<ActorId, ActorState>;
  conversation: ChatEntry[];
  execution: ExecutionState;
  tasks: Task[];
  toolCalls: ToolCall[];
  logs: LogEvent[];
  memory: MemoryItem[];
  memorySummary: string;
  git: GitState;
  model: ModelState;
  usage: UsageState;
  mcpServers: McpServerState[];
  lspServers: LspServerState[];
  rails?: RailsIndexState;
  skills: SkillState[];
  /** Latest test run, persisted (feed's test_result entries scroll away). */
  lastTestResult?: {
    command: string;
    passed: number;
    failed: number;
    failures: TestFailure[];
    durationMs: number;
    at: number;
  };
  /** Per-file LSP diagnostic counts; errors aggregate = sum of values. */
  diagnosticsByPath: Record<string, number>;
  approval: ApprovalRequest | null;
  clarification: ClarificationRequest | null;
  notifications: Notification[];
  lastError: string | null;
  theme: ThemeName;
  /** Only set when the user configures a real rate (config.pricing / env vars)
   * — Ollama has no published per-token price, so this stays unset by
   * default rather than showing an invented cost. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
}
