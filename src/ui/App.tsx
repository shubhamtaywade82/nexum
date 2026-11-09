import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, usePaste, useStdout } from "@nemesis-oss/termina-core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { historyFile as flatHistoryFile, legacyHistoryFile, workspaceStateDir } from "../platform/paths.js";
import { EventBus } from "../runtime/events/bus.js";
import { Store } from "../runtime/store.js";
import { RuntimeState, VIEW_ORDER, ViewId } from "../runtime/types.js";
import { activeViewRows, densityForWidth, detailForDensity, MAX_COMPLETION_ROWS } from "./layout/density.js";
import { setActiveTheme } from "./layout/theme-map.js";
import { resolveKey, UiCommand } from "../interaction/keybindings.js";
import { MOUSE_SGR_PATTERN } from "../interaction/mouse.js";
import { initialUiState, uiReduce } from "../interaction/ui-state.js";
import { builtinCommands, parseSlashInput, SlashCommandRegistry } from "../interaction/slash-commands.js";
import { HistoryManager } from "../interaction/history.js";
import { acceptWord, completions, ghostSuffix, isNoOpCompletion } from "../interaction/completion.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Header } from "./zones/Header.js";
import { ActivityStrip } from "./zones/ActivityStrip.js";
import { ContextStrip } from "./zones/ContextStrip.js";
import { PromptBar, promptBarRows } from "./zones/PromptBar.js";
import { CompletionSurface } from "./input/CompletionSurface.js";
import { PromptSession, type PromptState } from "./input/prompt-session.js";
import { ConversationView, ViewProps } from "./views/ConversationView.js";
import { PinnedDiffPanel } from "./components/PinnedDiffPanel.js";
import { VDivider } from "./components/Section.js";
import { DashboardView } from "./views/DashboardView.js";
import { ExecutionView } from "./views/ExecutionView.js";
import { TasksView } from "./views/TasksView.js";
import { GitView } from "./views/GitView.js";
import { LogsView } from "./views/LogsView.js";
import { MemoryView } from "./views/MemoryView.js";
import { ModelsView } from "./views/ModelsView.js";
import { McpView } from "./views/McpView.js";
import { LspView } from "./views/LspView.js";
import { FileExplorerView } from "./views/FileExplorerView.js";
import { SettingsView } from "./views/SettingsView.js";
import { ContextInspectorView } from "./views/ContextInspectorView.js";
import { RailsView } from "./views/RailsView.js";
import { ToolTimelineView } from "./views/ToolTimelineView.js";
import { CommandPalette } from "./overlays/CommandPalette.js";
import { HelpOverlay } from "./overlays/HelpOverlay.js";
import { ActorsOverlay } from "./overlays/ActorsOverlay.js";
import { ApprovalOverlay } from "./overlays/ApprovalOverlay.js";
import { ClarificationOverlay } from "./overlays/ClarificationOverlay.js";
import { McpElicitationOverlay } from "./overlays/McpElicitationOverlay.js";
import { ClarificationResponse } from "../runtime/types.js";
import type { McpElicitationResponse } from "../core/user-input.js";
import { ModelSwitcher } from "./overlays/ModelSwitcher.js";
import { ModeSwitcher } from "./overlays/ModeSwitcher.js";
import { ThemeSwitcher } from "./overlays/ThemeSwitcher.js";
import { SearchEverywhere } from "./overlays/SearchEverywhere.js";
import { SkillsOverlay } from "./overlays/SkillsOverlay.js";
import { SessionHistory } from "./overlays/SessionHistory.js";
import { SessionMeta } from "../runtime/session.js";
import { ToolPaletteOverlay, ToolInfo } from "./overlays/ToolPaletteOverlay.js";
import { ExecutionDagOverlay } from "./overlays/ExecutionDagOverlay.js";
import { executionNodesFromState } from "../runtime/event-node.js";
import { Sidebar, ToolCategoryCount } from "./zones/Sidebar.js";
import { SkillsRegistry } from "../skills/registry.js";
import { useCommandEffects } from "./hooks/useCommandEffects.js";
import { ThemeProvider } from "./ui/providers/theme-provider.js";
import { getTheme } from "./ui/theme-registry.js";

export interface ShellAgent {
  runUserMessage(message: string): Promise<unknown>;
  setModel?(model: string): void;
  setTier?(tier: "local" | "cloud"): void;
  resetContext?(): void;
  resumeSession?(): Array<{ role: string; content: string }> | null;
  resumeSessionById?(id: string): Array<{ role: string; content: string }> | null;
  hasResumableSession?(): boolean;
  listSessions?(): SessionMeta[];
  getTools?(): ToolInfo[];
  runPlan?(goal: string): Promise<unknown>;
  hasResumablePlan?(): boolean;
  getCapabilities?(): Promise<Array<import("../cli/capabilities.js").FeatureStatus>>;
  buildSandboxImage?(): Promise<{ ok: boolean; message: string }>;
  resolveApproval?(id: string, approved: boolean): void;
  resolveClarification?(response: ClarificationResponse): void;
  resolveMcpElicitation?(response: McpElicitationResponse): void;
  listModels?(): Promise<string[]>;
  /** Cache-only: which of the given models are known to require a Cloud subscription. */
  modelAvailability?(models: string[]): Record<string, boolean>;
  /** coding/vision/reasoning/quick/tools/agentic tags per model. */
  modelCapabilities?(models: string[]): Promise<Record<string, string[]>>;
  /** Round-trips a real request through the new model; true, or an error string. */
  validateModel?(): Promise<true | string>;
  getSkillsRegistry?(): SkillsRegistry;
  pinSkill?(id: string | null): void;
  addLearning?(category: string, context: string, lesson: string): void;
  /** Ollama Cloud request counts + spend for every configured API key. */
  usageAll?(
    range?: "24h" | "7d" | "30d",
    groupBy?: "model",
  ): Promise<Array<import("../models/adapters/provider.js").AccountUsage>>;
  /** Ollama Cloud remaining included + purchased credits, one row per key. */
  balanceAll?(): Promise<Array<import("../models/adapters/provider.js").AccountBalance>>;
  /** Publishes a local GGUF file as an Ollama model (blob upload + /api/create). */
  importGguf?(model: string, path: string): Promise<unknown>;
  /** Downloads a model from the Ollama registry, reporting each progress frame. */
  pullModel?(
    model: string,
    onEvent: (event: import("@nemesis-oss/ollama-sdk").PullProgressEvent) => void,
  ): Promise<void>;
}

export interface AppProps {
  bus: EventBus;
  store: Store;
  agent?: ShellAgent;
  registry?: SlashCommandRegistry;
  /** Explicit size for tests; defaults to the live terminal size. */
  columns?: number;
  rows?: number;
  now?: number;
  workspaceRoot?: string;
  initialTask?: string;
}

const VIEWS: Record<ViewId, (props: ViewProps) => React.JSX.Element> = {
  conversation: ConversationView,
  dashboard: DashboardView,
  execution: ExecutionView,
  tasks: TasksView,
  git: GitView,
  logs: LogsView,
  memory: MemoryView,
  models: ModelsView,
  mcp: McpView,
  lsp: LspView,
  files: FileExplorerView,
  settings: SettingsView,
  context: ContextInspectorView,
  rails: RailsView,
  timeline: ToolTimelineView,
};

const VIEW_LABELS: Record<ViewId, string> = {
  conversation: "Conversation",
  dashboard: "Dashboard",
  execution: "Execution",
  tasks: "Tasks",
  git: "Changes",
  logs: "Logs",
  memory: "Memory",
  models: "Models",
  mcp: "MCP",
  lsp: "LSP",
  files: "Files",
  settings: "Settings",
  context: "Context",
  rails: "Rails",
  timeline: "Timeline",
};

/**
 * Terminal size tracker. When both dimensions are provided (always the case
 * in tests and when the TUI bootstrap passes explicit values), we skip
 * useStdout() entirely to avoid Ink's internal stdout listener keeping
 * test processes alive.
 */
function TerminalSizeListener({ onSize, rows }: { onSize: (w: number, h: number) => void; rows?: number }) {
  const { stdout } = useStdout();
  useEffect(() => {
    if (!stdout) return;
    // termina types stdout as a bare WritableStream; at runtime it is the TTY
    // WriteStream (or the test stream) that carries columns, rows and resize.
    const tty = stdout as NodeJS.WriteStream;
    const onResize = () => onSize(tty.columns, rows ?? tty.rows);
    tty.on("resize", onResize);
    return () => {
      tty.off("resize", onResize);
    };
  }, [stdout, onSize, rows]);
  return null;
}

function useTerminalSize(columns?: number, rows?: number) {
  const [size, setSize] = useState(() => ({
    width: columns ?? (process.stdout?.columns || 100),
    height: rows ?? (process.stdout?.rows || 30),
  }));
  const onSize = useCallback((w: number, h: number) => setSize({ width: w, height: h }), []);
  const needsListener = columns == null || rows == null;
  const listener = needsListener ? <TerminalSizeListener onSize={onSize} rows={rows} /> : null;
  return { ...size, listener };
}

// Ink 3 bundles a React 17-era reconciler without useSyncExternalStore,
// so subscribe the classic way. The re-sync inside the effect catches any
// events published between first render and subscription.
//
// Streaming responses publish one bus event per token (see agent-bridge.ts).
// Real tokens arrive on separate event-loop turns (real network/inference
// latency between them), not in a same-tick burst — same-tick coalescing
// (the previous approach here) does nothing for that case, since there's
// only ever one event per turn to coalesce. Calling setState on every single
// token is what causes the flicker: Ink 3's renderer isn't a real diffing
// engine, so every commit is close to a full-screen repaint.
//
// Real fix: a leading+trailing time-window throttle, independent of how the
// events are spaced. The first update in a quiet period renders immediately
// (stays responsive); anything within RENDER_THROTTLE_MS of the last render
// is deferred to a single trailing flush instead of one render each.
const RENDER_THROTTLE_MS = 50; // ~20fps cap — well above flicker threshold, still feels live

/** Cadence and stop condition for the model-switcher's availability poll. */
const AVAILABILITY_POLL_MS = 1000;
const AVAILABILITY_POLL_TIMEOUT_MS = 30_000;

function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}
function useRuntimeState(store: Store): RuntimeState {
  const [state, setState] = useState<RuntimeState>(() => store.getState());
  useEffect(() => {
    setState(store.getState());
    let lastFlush = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pendingTimer = null;
      lastFlush = Date.now();
      setState(store.getState());
    };
    const unsubscribe = store.subscribe(() => {
      if (pendingTimer) return; // a trailing flush is already scheduled — it'll pick up this update
      const elapsed = Date.now() - lastFlush;
      if (elapsed >= RENDER_THROTTLE_MS) {
        flush();
      } else {
        pendingTimer = setTimeout(flush, RENDER_THROTTLE_MS - elapsed);
      }
    });
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      unsubscribe();
    };
  }, [store]);
  return state;
}

export function App({
  bus,
  store,
  agent,
  registry,
  columns,
  rows,
  now,
  workspaceRoot,
  initialTask,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const state = useRuntimeState(store);
  // Presentation side effect (review item 12): applying the active theme to
  // the palette module is a UI concern — the state reducer only records it.
  useEffect(() => {
    setActiveTheme(state.theme);
  }, [state.theme]);
  const { width, height, listener: sizeListener } = useTerminalSize(columns, rows);
  const [ui, uiDispatch] = useReducer(uiReduce, undefined, initialUiState);
  // The session owns the prompt text and cursor and applies each edit to its
  // latest state; `editor` only mirrors it for rendering (see prompt-session.ts).
  const [editor, setEditor] = useState<PromptState>({ text: "", cursor: 0 });
  const [promptSession] = useState(() => new PromptSession({ onChange: setEditor }));
  const prompt = editor.text;
  const cursor = editor.cursor;
  const [busy, setBusy] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [history] = useState(() => {
    const root = workspaceRoot ?? process.cwd();
    const historyFile = join(workspaceStateDir(root), "history.json");
    // Also load legacy flat file for backwards compat (pre-rename DevAgent)
    const legacyPath = legacyHistoryFile(root);
    let initialHistory: string[] = [];
    try {
      if (existsSync(legacyPath)) {
        const content = readFileSync(legacyPath, "utf-8");
        initialHistory = content.split("\n").filter(Boolean);
      }
    } catch {
      // ignore
    }
    const mgr = new HistoryManager(initialHistory, 200, historyFile);
    mgr.load();
    return mgr;
  });
  const [models, setModels] = useState<string[] | null>(null);
  const [modelAvailability, setModelAvailability] = useState<Record<string, boolean>>({});
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, string[]>>({});
  const commandRegistry = useMemo(() => registry ?? builtinCommands(), [registry]);
  const focusReportRef = useRef(false);
  const lastCtrlCTimeRef = useRef(0);

  // Termina handles bracketed paste markers natively. The session normalizes
  // line breaks, collapses multi-line content, and moves the cursor past it.
  usePaste((text) => {
    promptSession.paste(text);
  });

  useEffect(() => () => promptSession.dispose(), [promptSession]);

  // Terminal focus tracking (DECSET 1004): most modern terminals (iTerm2,
  // kitty, WezTerm, Alacritty, Windows Terminal) report window focus in/out
  // as \x1b[I / \x1b[O once this mode is enabled — used to switch the prompt
  // cursor from a solid block (focused) to a thin bar (unfocused), same
  // convention as GUI editors. Terminals that don't support it simply never
  // send the sequence, so `focused` just stays true — no feature detection
  // needed.
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!process.stdin.isTTY) return;
    process.stdout.write("\x1b[?1004h");
    // Ink doesn't recognize \x1b[I / \x1b[O as a real key — left alone it
    // falls through Ink's keypress parser as literal "[I"/"[O" text typed
    // into the prompt. Same fix as the bracketed-paste handler above:
    // prependListener runs before Ink's own stdin listener, and
    // focusReportRef tells useInput to swallow the resulting keypresses.
    const handler = (data: Buffer) => {
      const s = data.toString();
      if (s !== "\x1b[I" && s !== "\x1b[O") return;
      setFocused(s === "\x1b[I");
      focusReportRef.current = true;
      setTimeout(() => {
        focusReportRef.current = false;
      }, 0);
    };
    process.stdin.prependListener("data", handler);
    return () => {
      process.stdin.off("data", handler);
      process.stdout.write("\x1b[?1004l");
    };
  }, []);

  // Load the model list lazily when the switcher opens; cache afterwards.
  useEffect(() => {
    if (ui.overlay !== "model" || models !== null) return;
    let cancelled = false;
    if (!agent?.listModels) {
      setModels([]);
      return;
    }
    agent
      .listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setModelAvailability(agent.modelAvailability?.(list) ?? {});
        // Returned, and with its own catch: as a floating promise the outer
        // .catch() below didn't cover it, so a rejection here was an unhandled
        // rejection — fatal under Node's default settings, taking down the TUI.
        return agent.modelCapabilities?.(list).then(
          (caps) => {
            if (!cancelled) setModelCapabilities(caps);
          },
          () => {
            // capability tags are decoration; the picker works without them
          },
        );
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ui.overlay, models, agent]);

  // The availability cache fills in progressively (ModelAvailabilityChecker's
  // startup refreshAll checks each model via a real network round-trip,
  // batched 5 at a time) — poll the cache while the switcher is open so
  // subscription tags appear as checks land instead of only reflecting
  // whatever was cached the instant the list loaded (often none of it yet).
  useEffect(() => {
    if (ui.overlay !== "model" || models === null || !agent?.modelAvailability) return;
    let elapsed = 0;
    const interval = setInterval(() => {
      const next = agent.modelAvailability!(models);
      elapsed += AVAILABILITY_POLL_MS;
      // Only re-render when something actually changed. This always allocated
      // a fresh object and handed it to setState, so on the default local tier
      // — where modelAvailability() always returns {} because the checker only
      // tracks cloud ids — it was a pure no-op repaint every second.
      setModelAvailability((prev) => (shallowEqual(prev, next) ? prev : next));
      // The startup refresh is bounded work; without a stop condition this
      // polled forever for as long as the overlay stayed open.
      if (elapsed >= AVAILABILITY_POLL_TIMEOUT_MS) clearInterval(interval);
    }, AVAILABILITY_POLL_MS);
    return () => clearInterval(interval);
  }, [ui.overlay, models, agent]);

  const completionItems = completions(prompt, commandRegistry, undefined, history.all());
  // A list whose only entry is the command the user already typed in full is
  // not an actionable completion — treating it as one made Enter re-insert the
  // same text instead of submitting, so every zero-argument slash command
  // (/help, /clear, /resume, /model, /quit, ...) needed Enter pressed twice.
  const activeCompletion = completionItems.some((item) => !isNoOpCompletion(prompt, item));
  const ghost = activeCompletion ? "" : ghostSuffix(prompt, history.all());

  const density = densityForWidth(width);
  const detail = ui.zoom ? "full" : detailForDensity(density);
  const completionRowCount = activeCompletion ? Math.min(completionItems.length, MAX_COMPLETION_ROWS) : 0;
  // When completions are visible they add extra rows: a counter row when
  // scrolling is needed, plus CompletionSurface's own trailing hint row.
  const completionChrome =
    completionRowCount + (completionItems.length > MAX_COMPLETION_ROWS ? 1 : 0) + (activeCompletion ? 1 : 0);
  const totalPromptRows = promptBarRows(prompt) + completionChrome;
  const viewRows = activeViewRows(height, totalPromptRows);
  // Dashboard skips the "─ N ViewName ─" title (its branded Header is
  // directly above, and the numeric index is a digit-key hint that only
  // reaches views 1-9 anyway) but still gets a plain divider row separating
  // Header from content, same as every other view.
  const showViewTitle = ui.activeView !== "dashboard";
  const contentRows = Math.max(2, viewRows - 1);

  const applyEffect = useCommandEffects(bus, store, agent, workspaceRoot, setBusy, uiDispatch);

  const submitPrompt = useCallback(
    (text: string): void => {
      // "[Pasted text #N +K lines]" is a display-only label PromptBar uses to
      // collapse a paste — the real content is already on the following
      // lines, so drop the label itself before it leaks into the actual
      // message sent to the model / saved to history.
      const withoutPasteLabels = text
        .split("\n")
        .filter((line) => !/^\[Pasted text #\d+ \+\d+ lines\]$/.test(line))
        .join("\n");
      const trimmed = withoutPasteLabels.trim();
      if (!trimmed) return;
      const slash = parseSlashInput(trimmed);
      if (slash) {
        promptSession.clear();
        setCompletionIndex(0);
        const command = commandRegistry.find(slash.name);
        applyEffect(command ? command.execute(slash.args) : { kind: "error", text: `Unknown command: /${slash.name}` });
        return;
      }

      history.add(trimmed);
      try {
        const root = workspaceRoot ?? process.cwd();
        // New writes go to the canonical `.nexum_history`; the legacy
        // `.devagent_history` is only ever read (docs/REBRANDING.md §2).
        const historyPath = flatHistoryFile(root);
        writeFileSync(historyPath, history.all().join("\n"), "utf-8");
      } catch {
        // ignore
      }
      promptSession.clear();
      setCompletionIndex(0);

      // Dashboard is a live cockpit in its own right (Activity Feed shows the
      // reply) — don't yank the user off it. Every other view still switches
      // to Conversation so the reply is visible where it always used to be.
      if (ui.activeView !== "dashboard") {
        uiDispatch({ type: "focus-view", view: "conversation" });
      }
      bus.publish({ type: "conversation.message", role: "user", text: trimmed });
      if (!agent) return;
      setBusy(true);
      bus.publish({ type: "mode.changed", mode: "streaming" });
      agent
        .runUserMessage(trimmed)
        .catch((e: unknown) => {
          bus.publish({ type: "error", message: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => {
          setBusy(false);
          bus.publish({ type: "model.streaming", streaming: false });
          bus.publish({ type: "mode.changed", mode: "idle" });
        });
    },
    [agent, applyEffect, bus, commandRegistry, history, promptSession, ui.activeView, uiDispatch],
  );

  const initialTriggered = useRef(false);
  useEffect(() => {
    if (initialTask && !initialTriggered.current && agent) {
      initialTriggered.current = true;
      submitPrompt(initialTask);
    }
  }, [initialTask, agent, submitPrompt]);

  const handleCommand = useCallback(
    (command: UiCommand): void => {
      switch (command.type) {
        case "quit":
          exit();
          return;
        case "approve":
        case "reject": {
          const approval = store.getState().approval;
          if (approval) {
            agent?.resolveApproval?.(approval.id, command.type === "approve");
            bus.publish({ type: "approval.resolved", id: approval.id, approved: command.type === "approve" });
            bus.publish({
              type: "notification",
              kind: command.type === "approve" ? "success" : "warning",
              text: command.type === "approve" ? "Approved" : "Rejected",
            });
          }
          if (ui.overlay === "diff") uiDispatch({ type: "close-overlay" });
          return;
        }
        case "clear-conversation":
          bus.publish({ type: "conversation.clear" });
          return;
        case "open-mode":
          uiDispatch(command);
          return;
        case "next-mode": {
          const modes: Array<RuntimeState["agentMode"]> = ["ask", "code", "architect", "review", "debug", "autonomous"];
          const current = store.getState().agentMode;
          const idx = modes.indexOf(current);
          const next = modes[(idx + 1) % modes.length];
          bus.publish({ type: "mode.agent", mode: next });
          bus.publish({ type: "notification", kind: "info", text: `Mode: ${next}` });
          return;
        }
        case "cancel":
          // Dismissing a completion and cancelling the prompt both clear it; only
          // the latter leaves history browsing.
          promptSession.clear();
          setCompletionIndex(0);
          if (!activeCompletion) history.stopBrowsing();
          return;
        default:
          uiDispatch(command);
      }
    },
    [activeCompletion, bus, exit, history, promptSession, store, ui.overlay],
  );

  useInput((input, key) => {
    if (focusReportRef.current) return; // terminal focus in/out escape, not real text
    if (MOUSE_SGR_PATTERN.test(input)) return; // scroll/click artifact, never real text

    // Double Ctrl+C to exit cleanly; single Ctrl+C clears prompt and warns
    if (key.ctrl && (input === "c" || input === "\u0003")) {
      const now = Date.now();
      if (now - lastCtrlCTimeRef.current < 1500) {
        exit();
        return;
      }
      lastCtrlCTimeRef.current = now;
      if (promptSession.text.length > 0) {
        promptSession.clear();
        setCompletionIndex(0);
        history.stopBrowsing();
      }
      bus.publish({
        type: "notification",
        kind: "warning",
        text: "Press Ctrl+C again within 1.5s to exit",
      });
      return;
    }

    promptSession.touch();

    const ctx = { overlay: ui.overlay, promptHasText: promptSession.text.length > 0, mode: state.mode };
    const command = resolveKey(input, key, ctx);
    if (command) {
      handleCommand(command);
      return;
    }
    if (ui.overlay || state.clarification != null || state.mcpElicitation != null) return; // remaining keys belong to the overlay's own handler

    // Prompt editing. Each edit lands on the session's latest state, so keys
    // delivered before a re-render still compose.
    if (key.return && key.shift) {
      promptSession.newline();
      return;
    }
    if (key.return) {
      // A fast Enter is the terminal delivering a paste line by line: a newline in the
      // burst, not a submit. Anything deliberate falls through to completion or submit.
      if (promptSession.enter() === "newline") return;
      const text = promptSession.text;
      const isExplicitTrigger = text.startsWith("/") || text.startsWith("@");
      const hasUserNavigated = completionIndex > 0;
      const item =
        (isExplicitTrigger || hasUserNavigated) && activeCompletion
          ? completionItems[Math.min(completionIndex, completionItems.length - 1)]
          : undefined;
      // Guard the selected entry too, not just the list: a prefix can be both
      // an exact command and a prefix of others (e.g. "/test" alongside
      // "/tests"), which would otherwise leave Enter permanently stuck on the
      // no-op entry.
      if (item && !isNoOpCompletion(text, item)) {
        promptSession.replace(item.insert);
        setCompletionIndex(0);
        return;
      }
      submitPrompt(text);
      return;
    }
    if (key.backspace) {
      promptSession.backspace();
      setCompletionIndex(0);
      history.stopBrowsing();
      return;
    }
    if (key.delete) {
      promptSession.deleteForward();
      setCompletionIndex(0);
      history.stopBrowsing();
      return;
    }
    // Home / Ctrl+A: jump to start of line
    if ((key.ctrl && input === "a") || input === "\x1b[H" || input === "\x1b[1~") {
      promptSession.moveHome();
      return;
    }
    // End / Ctrl+E: jump to end of line
    if ((key.ctrl && input === "e") || input === "\x1b[F" || input === "\x1b[4~") {
      promptSession.moveEnd();
      return;
    }
    if (key.leftArrow) {
      promptSession.moveLeft();
      return;
    }
    if (key.rightArrow) {
      if (promptSession.cursor === promptSession.text.length && ghost) {
        promptSession.append(acceptWord(ghost).accepted);
      } else {
        promptSession.moveRight();
      }
      return;
    }
    if (key.tab) {
      if (activeCompletion) {
        const item = completionItems[Math.min(completionIndex, completionItems.length - 1)];
        promptSession.replace(item.insert);
        setCompletionIndex(0);
      } else if (ghost) {
        promptSession.append(ghost);
      }
      return;
    }
    if (key.upArrow) {
      if (activeCompletion) setCompletionIndex((i) => Math.max(0, i - 1));
      else promptSession.replace(history.up(promptSession.text));
      return;
    }
    if (key.downArrow) {
      if (activeCompletion) setCompletionIndex((i) => Math.min(completionItems.length - 1, i + 1));
      else promptSession.replace(history.down(promptSession.text));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // Real keystrokes arrive one character at a time; a chunk containing a
      // line break is an unmarked paste, which the session collapses.
      promptSession.insert(input);
      setCompletionIndex(0);
    }
  });

  const ActiveView = VIEWS[ui.activeView];
  // The runtime theme (state.theme, updated by "theme.changed" events) drives
  // the termcn ThemeProvider; every vendored component and migrated view
  // resolves its colors from this context via useTheme().
  const activeTheme = useMemo(() => getTheme(state.theme), [state.theme]);
  const approval = state.approval;
  const showApproval = approval != null && (ui.overlay === null || ui.overlay === "diff");
  const clarification = state.clarification;
  const showClarification = clarification != null && !showApproval;
  const mcpElicitation = state.mcpElicitation;
  const showMcpElicitation = mcpElicitation != null && !showApproval && !showClarification;
  const viewIndex = VIEW_ORDER.indexOf(ui.activeView) + 1;
  const title = ` ${viewIndex} ${VIEW_LABELS[ui.activeView]} `;
  const rule = "─".repeat(Math.max(0, width - title.length - 2));

  // Sidebar only competes for space with the plain view — overlays and the
  // approval flow stay full-bleed (they're ephemeral by design, see
  // OverlayFrame). Gated on width so it never fights the strips' narrow-
  // terminal token-shedding behavior.
  const SIDEBAR_WIDTH = 24;
  const MIN_WIDTH_FOR_SIDEBAR = 90;
  const showSidebar =
    ui.sidebarVisible &&
    !showApproval &&
    !showClarification &&
    !showMcpElicitation &&
    ui.overlay === null &&
    width >= MIN_WIDTH_FOR_SIDEBAR &&
    ui.activeView !== "dashboard";
  const activeViewWidth = showSidebar ? width - SIDEBAR_WIDTH - 1 : width;
  const toolCategoryCounts: ToolCategoryCount[] = showSidebar
    ? (() => {
        const counts = new Map<string, number>();
        for (const t of agent?.getTools?.() ?? []) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
        return [...counts.entries()]
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => b.count - a.count);
      })()
    : [];

  return (
    <Box flexDirection="column" width={width} height={height}>
      {sizeListener}
      <ErrorBoundary>
        <ThemeProvider theme={activeTheme}>
          <Header state={state} width={width} now={now} />
          <Box height={1}>
            <Text color={activeTheme.colors.mutedForeground} dimColor>
              {"─".repeat(Math.max(0, width - 1))}
            </Text>
          </Box>
          <ActivityStrip
            state={state}
            width={width}
            now={now}
            activeView={ui.activeView}
            onSelectView={(v) => uiDispatch({ type: "focus-view", view: v })}
            onOpenPalette={() => uiDispatch({ type: "open-overlay", overlay: "palette" })}
          />
          <Box flexDirection="column" height={viewRows}>
            {showViewTitle ? (
              <Box height={1}>
                <Text color={activeTheme.colors.mutedForeground}>{"─"}</Text>
                <Text color={activeTheme.colors.primary} bold>
                  {title}
                </Text>
                <Text color={activeTheme.colors.mutedForeground} wrap="truncate">
                  {rule}
                </Text>
              </Box>
            ) : (
              <Box height={1}>
                <Text color={activeTheme.colors.mutedForeground} dimColor>
                  {"─".repeat(Math.max(0, width))}
                </Text>
              </Box>
            )}
            {showApproval ? (
              <ApprovalOverlay request={approval} width={width} rows={contentRows} showDiff={ui.overlay === "diff"} />
            ) : showMcpElicitation ? (
              <McpElicitationOverlay
                request={mcpElicitation}
                width={width}
                rows={contentRows}
                onSubmit={(response) => {
                  agent?.resolveMcpElicitation?.(response);
                  bus.publish({ type: "mcp.elicitation.resolved", response });
                }}
                onCancel={() => {
                  const response = { id: mcpElicitation.id, action: "cancel" } as const;
                  agent?.resolveMcpElicitation?.(response);
                  bus.publish({ type: "mcp.elicitation.resolved", response });
                }}
              />
            ) : showClarification ? (
              <ClarificationOverlay
                request={clarification}
                width={width}
                rows={contentRows}
                onSubmit={(response) => {
                  agent?.resolveClarification?.(response);
                  bus.publish({ type: "clarification.resolved", response });
                }}
                onCancel={() => {
                  const fallbackId = clarification.options[0]?.id ?? "cancel";
                  agent?.resolveClarification?.({ id: clarification.id, selectedId: fallbackId });
                  bus.publish({
                    type: "clarification.resolved",
                    response: { id: clarification.id, selectedId: fallbackId },
                  });
                }}
              />
            ) : ui.overlay === "diff" ? (
              <Box flexDirection="row" width={width} height={contentRows}>
                <Box width={Math.floor((width - 1) / 2)} height={contentRows}>
                  <ConversationView
                    state={state}
                    width={Math.floor((width - 1) / 2)}
                    rows={contentRows}
                    detail={detail}
                  />
                </Box>
                <VDivider rows={contentRows} />
                <Box width={width - Math.floor((width - 1) / 2) - 1} height={contentRows}>
                  <PinnedDiffPanel
                    conversation={state.conversation}
                    width={width - Math.floor((width - 1) / 2) - 1}
                    rows={contentRows}
                  />
                </Box>
              </Box>
            ) : ui.overlay === "palette" ? (
              <CommandPalette
                registry={commandRegistry}
                width={width}
                rows={contentRows}
                active={true}
                onAction={(effect) => {
                  uiDispatch({ type: "close-overlay" });
                  applyEffect(effect);
                }}
              />
            ) : ui.overlay === "help" ? (
              <HelpOverlay width={width} rows={contentRows} />
            ) : ui.overlay === "actors" ? (
              <ActorsOverlay state={state} width={width} rows={contentRows} />
            ) : ui.overlay === "model" ? (
              <ModelSwitcher
                current={state.model.name}
                models={models}
                availability={modelAvailability}
                capabilities={modelCapabilities}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(model) => {
                  uiDispatch({ type: "close-overlay" });
                  applyEffect({ kind: "set-model", model });
                }}
              />
            ) : ui.overlay === "search" ? (
              <SearchEverywhere
                state={state}
                registry={commandRegistry}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(view) => {
                  uiDispatch({ type: "close-overlay" });
                  uiDispatch({ type: "focus-view", view });
                }}
              />
            ) : ui.overlay === "mode" ? (
              <ModeSwitcher
                current={state.agentMode}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(mode) => {
                  uiDispatch({ type: "close-overlay" });
                  bus.publish({ type: "mode.agent", mode });
                  bus.publish({ type: "notification", kind: "info", text: `Mode: ${mode}` });
                }}
              />
            ) : ui.overlay === "theme" ? (
              <ThemeSwitcher
                current={state.theme}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(theme) => {
                  uiDispatch({ type: "close-overlay" });
                  applyEffect({ kind: "set-theme", theme });
                }}
              />
            ) : ui.overlay === "skills" ? (
              <SkillsOverlay
                skills={agent?.getSkillsRegistry?.().list() ?? []}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(id) => {
                  uiDispatch({ type: "close-overlay" });
                  applyEffect({ kind: "activate-skill", id });
                }}
              />
            ) : ui.overlay === "sessions" ? (
              <SessionHistory
                sessions={agent?.listSessions?.() ?? []}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(id) => {
                  uiDispatch({ type: "close-overlay" });
                  applyEffect({ kind: "resume-session-by-id", id });
                }}
              />
            ) : ui.overlay === "dag" ? (
              <ExecutionDagOverlay
                nodes={executionNodesFromState(state)}
                width={width}
                rows={contentRows}
                active={true}
                onClose={() => uiDispatch({ type: "close-overlay" })}
              />
            ) : ui.overlay === "tools" ? (
              <ToolPaletteOverlay
                tools={agent?.getTools?.() ?? []}
                width={width}
                rows={contentRows}
                active={true}
                onSelect={(name) => {
                  uiDispatch({ type: "close-overlay" });
                  applyEffect({ kind: "show-tool-info", name });
                }}
              />
            ) : showSidebar ? (
              <Box flexDirection="row" width={width} height={contentRows}>
                <Box width={activeViewWidth} height={contentRows}>
                  <ActiveView state={state} width={activeViewWidth} rows={contentRows} detail={detail} now={now} />
                </Box>
                <Box flexDirection="column" width={1} height={contentRows}>
                  {Array.from({ length: contentRows }, (_, i) => (
                    <Text key={i} color={activeTheme.colors.mutedForeground} dimColor>
                      │
                    </Text>
                  ))}
                </Box>
                <Sidebar
                  state={state}
                  sessions={agent?.listSessions?.() ?? []}
                  toolCategories={toolCategoryCounts}
                  width={SIDEBAR_WIDTH}
                  rows={contentRows}
                />
              </Box>
            ) : (
              <ActiveView state={state} width={activeViewWidth} rows={contentRows} detail={detail} now={now} />
            )}
          </Box>
          <Box height={1}>
            <Text color={activeTheme.colors.mutedForeground} dimColor>
              {"─".repeat(Math.max(0, width - 1))}
            </Text>
          </Box>
          {activeCompletion && (
            <CompletionSurface items={completionItems} selectedIndex={completionIndex} width={width} />
          )}
          <PromptBar text={prompt} cursor={cursor} ghost={ghost} width={width} busy={busy} focused={focused} />
          <Box height={1}>
            <Text color={activeTheme.colors.mutedForeground} dimColor>
              {"─".repeat(Math.max(0, width - 1))}
            </Text>
          </Box>
          <ContextStrip state={state} width={width} activeView={ui.activeView} now={now} />
        </ThemeProvider>
      </ErrorBoundary>
    </Box>
  );
}
