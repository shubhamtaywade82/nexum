/**
 * Slash commands are plugins: a registry of named commands with aliases,
 * discoverable by prefix for autocomplete and executed by the prompt.
 */

import { THEME_ORDER, ThemeName, ViewId } from "../runtime/types.js";
import { OverlayId } from "./ui-state.js";

/** Effects a command can request; the shell interprets them. */
export type CommandEffect =
  | { kind: "message"; text: string }
  | { kind: "open-overlay"; overlay: OverlayId }
  | { kind: "focus-view"; view: ViewId }
  | { kind: "clear-conversation" }
  | { kind: "set-model"; model: string }
  | { kind: "set-tier"; tier: "local" | "cloud" }
  | { kind: "activate-skill"; id: string }
  | { kind: "reset-context" }
  | { kind: "resume-session" }
  | { kind: "resume-session-by-id"; id: string }
  | { kind: "show-tool-info"; name: string }
  | { kind: "set-theme"; theme: ThemeName }
  | { kind: "next-theme" }
  | { kind: "toggle-sidebar" }
  | { kind: "run-plan"; goal: string }
  | { kind: "init-workspace" }
  | { kind: "set-agent-mode"; mode: string }
  | { kind: "run-shell"; command: string }
  | { kind: "search" }
  | { kind: "next-mode" }
  | { kind: "quit" }
  | { kind: "learn"; rule: string }
  | { kind: "replay-session"; id?: string }
  | { kind: "doctor" }
  | { kind: "usage"; range?: "24h" | "7d" | "30d" }
  | { kind: "balance" }
  | { kind: "import-gguf"; model: string; path: string }
  | { kind: "capabilities"; action: "show" | "fix" }
  | { kind: "evolve"; action: "diagnose" | "history" | "rollback" | "benchmark"; target?: string }
  | { kind: "error"; text: string };

export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  /** Category for grouping in the completion surface. */
  category?: string;
  execute(args: string): CommandEffect;
  /** Static first-argument values, for subcommand autocomplete (e.g.
   * "/mode a" -> "ask"). Commands that take free-form text omit this. */
  argValues?: string[];
}

export class SlashCommandRegistry {
  private commands: SlashCommand[] = [];

  register(command: SlashCommand): void {
    this.commands = this.commands.filter((c) => c.name !== command.name).concat(command);
  }

  all(): SlashCommand[] {
    return [...this.commands].sort((a, b) => a.name.localeCompare(b.name));
  }

  find(name: string): SlashCommand | undefined {
    return this.commands.find((c) => c.name === name || c.aliases.includes(name));
  }

  /** Prefix matches for autocomplete, e.g. "mod" -> model, models. */
  complete(prefix: string): SlashCommand[] {
    return this.all().filter((c) => c.name.startsWith(prefix) || c.aliases.some((a) => a.startsWith(prefix)));
  }
}

/** Parse "/model qwen3:30b" into { name: "model", args: "qwen3:30b" }. */
export function parseSlashInput(input: string): { name: string; args: string } | null {
  if (!input.startsWith("/")) return null;
  const body = input.slice(1).trim();
  if (!body) return null;
  const space = body.indexOf(" ");
  if (space === -1) return { name: body, args: "" };
  return { name: body.slice(0, space), args: body.slice(space + 1).trim() };
}

export function builtinCommands(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  const viewCommand = (name: string, view: ViewId, description: string): SlashCommand => ({
    name,
    aliases: [],
    description,
    category: "Views",
    execute: () => ({ kind: "focus-view", view }),
  });

  registry.register({
    name: "help",
    aliases: ["h"],
    description: "Show help overlay",
    category: "General",
    execute: () => ({ kind: "open-overlay", overlay: "help" }),
  });
  registry.register({
    name: "clear",
    aliases: [],
    description: "Clear the conversation view",
    category: "General",
    execute: () => ({ kind: "clear-conversation" }),
  });
  registry.register({
    name: "reset",
    aliases: ["compact"],
    description: "Reset the model conversation context",
    category: "General",
    execute: () => ({ kind: "reset-context" }),
  });
  registry.register({
    name: "resume",
    aliases: ["continue"],
    description: "Resume the conversation from before a crash/restart",
    category: "Session",
    execute: () => ({ kind: "resume-session" }),
  });
  registry.register({
    name: "replay",
    aliases: [],
    description: "Replay a past session trajectory: /replay [session-id]",
    category: "Session",
    execute: (args) => ({ kind: "replay-session", id: args.trim() || undefined }),
  });
  registry.register({
    name: "dag",
    aliases: ["graph", "timeline"],
    description: "Inspect the execution DAG graph & node trace overlay",
    category: "Execution",
    execute: () => ({ kind: "open-overlay", overlay: "dag" }),
  });
  registry.register({
    name: "focus",
    aliases: ["console"],
    description: "Switch to Focus Mode (Dynamic Execution Console layout)",
    category: "Layout",
    execute: () => ({ kind: "focus-view", view: "conversation" }),
  });
  registry.register({
    name: "inspect",
    aliases: ["debug"],
    description: "Switch to Inspect Mode (Collapsible Debugger & DAG layout)",
    category: "Layout",
    execute: () => ({ kind: "focus-view", view: "execution" }),
  });
  registry.register({
    name: "mission",
    aliases: ["dashboard"],
    description: "Run an autonomous mission or view Mission Control: /mission [task]",
    category: "Agent",
    execute: (args) =>
      args.trim() ? { kind: "run-plan", goal: args.trim() } : { kind: "focus-view", view: "dashboard" },
  });
  registry.register({
    name: "history",
    aliases: ["sessions"],
    description: "Browse and reload past conversations",
    category: "Session",
    execute: () => ({ kind: "open-overlay", overlay: "sessions" }),
  });
  registry.register({
    name: "theme",
    aliases: [],
    description: "Switch color theme: /theme [name] (no arg opens the picker)",
    category: "Theme",
    execute: (args) => {
      const t = args.trim().toLowerCase();
      if (!t) return { kind: "open-overlay", overlay: "theme" };
      if (!(THEME_ORDER as readonly string[]).includes(t)) {
        return { kind: "error", text: `Unknown theme "${t}". Available: ${THEME_ORDER.join(", ")}` };
      }
      return { kind: "set-theme", theme: t as ThemeName };
    },
    argValues: [...THEME_ORDER],
  });
  registry.register({
    name: "sidebar",
    aliases: [],
    description: "Toggle the sessions/tools/skills sidebar",
    category: "Workspace",
    execute: () => ({ kind: "toggle-sidebar" }),
  });
  registry.register({
    name: "tools",
    aliases: [],
    description: "Browse registered tools by name or category",
    category: "Tools",
    execute: () => ({ kind: "open-overlay", overlay: "tools" }),
  });
  registry.register({
    name: "model",
    aliases: [],
    description: "Switch model: /model [name]",
    category: "Model",
    execute: (args) => (args ? { kind: "set-model", model: args } : { kind: "open-overlay", overlay: "model" }),
  });
  registry.register({
    name: "tier",
    aliases: [],
    description: "Switch provider tier: /tier local|cloud",
    category: "Model",
    execute: (args) => {
      const tier = args.trim().toLowerCase();
      if (tier !== "local" && tier !== "cloud") {
        return { kind: "error", text: "Usage: /tier local|cloud" };
      }
      return { kind: "set-tier", tier };
    },
    argValues: ["local", "cloud"],
  });
  registry.register({
    name: "skills",
    aliases: [],
    description: "Browse skills, or activate one: /skills [id]",
    category: "Tools",
    execute: (args) =>
      args.trim() ? { kind: "activate-skill", id: args.trim() } : { kind: "open-overlay", overlay: "skills" },
  });
  registry.register({
    name: "init",
    aliases: ["setup"],
    description: "Create .nexum/ workspace config with defaults",
    category: "Workspace",
    execute: () => ({ kind: "init-workspace" }),
  });
  registry.register({
    name: "quit",
    aliases: ["exit"],
    description: "Quit Nexum",
    category: "General",
    execute: () => ({ kind: "quit" }),
  });
  registry.register(viewCommand("conversation", "conversation", "Focus the Conversation view"));
  registry.register(viewCommand("chat", "conversation", "Focus the Conversation view"));
  registry.register(viewCommand("execution", "execution", "Focus the Execution view"));
  registry.register(viewCommand("status", "execution", "Focus the Execution view"));
  registry.register(viewCommand("logs", "logs", "Focus the Logs view"));
  registry.register(viewCommand("git", "git", "Focus the Git view"));
  registry.register(viewCommand("tasks", "tasks", "Focus the Tasks view"));
  registry.register(viewCommand("memory", "memory", "Focus the Memory view"));
  registry.register(viewCommand("models", "models", "Focus the Models view"));
  registry.register(viewCommand("mcp", "mcp", "Focus the MCP view"));
  registry.register(viewCommand("files", "files", "Focus the File Explorer view"));
  registry.register(viewCommand("explorer", "files", "Focus the File Explorer view"));
  registry.register(viewCommand("settings", "settings", "Focus the Settings view"));
  registry.register(viewCommand("config", "settings", "Focus the Settings view"));
  registry.register(viewCommand("context", "context", "Focus the Context Inspector view"));
  registry.register(viewCommand("rails", "rails", "Focus the Rails project view"));
  registry.register(viewCommand("timeline", "timeline", "Focus the Tool Timeline view"));
  registry.register(viewCommand("dashboard", "dashboard", "Focus the Dashboard view"));
  registry.register({
    name: "mode",
    aliases: [],
    description: "Switch agent mode: /mode [ask|code|architect|review|debug|autonomous]",
    category: "Mode",
    execute: (args) => {
      const valid = ["ask", "code", "architect", "review", "debug", "autonomous"];
      const mode = args.trim().toLowerCase();
      if (mode && !valid.includes(mode)) {
        return { kind: "error", text: "Usage: /mode [ask|code|architect|review|debug|autonomous]" };
      }
      return mode ? { kind: "set-agent-mode", mode } : { kind: "next-mode" };
    },
    argValues: ["ask", "code", "architect", "review", "debug", "autonomous"],
  });
  registry.register({
    name: "search",
    aliases: ["find"],
    description: "Search conversation, logs, files, and commands",
    category: "General",
    execute: () => ({ kind: "search" }),
  });
  registry.register({
    name: "plan",
    aliases: [],
    description:
      "Decompose and execute a task via the orchestrator: /plan [task description] (no args resumes an interrupted plan)",
    category: "Agent",
    execute: (args) => ({ kind: "run-plan", goal: args.trim() }),
  });
  registry.register({
    name: "commit",
    aliases: [],
    description: "Stage and commit changes with AI-generated message: /commit [message]",
    category: "Git",
    execute: (args) =>
      args.trim()
        ? { kind: "message", text: `Stage all and commit with message: ${args}` }
        : { kind: "message", text: "Stage all changes and create an appropriate commit message" },
  });
  registry.register({
    name: "pr",
    aliases: ["pull-request"],
    description: "Create a pull request for current branch: /pr [title]",
    category: "Git",
    execute: (args) =>
      args.trim()
        ? { kind: "message", text: `Create a pull request: ${args.trim()}` }
        : { kind: "message", text: "Create a pull request for the current branch and verified changes" },
  });
  registry.register({
    name: "review",
    aliases: [],
    description: "Review the current code changes",
    category: "Agent",
    execute: () => ({
      kind: "message",
      text: "Review all uncommitted code changes for quality, security, and best practices",
    }),
  });
  registry.register({
    name: "fix",
    aliases: ["repair"],
    description: "Fix failing tests or issues: /fix [description]",
    category: "Agent",
    execute: (args) =>
      args.trim()
        ? { kind: "message", text: `Fix the following issue: ${args}` }
        : { kind: "message", text: "Find and fix any failing tests or linting issues" },
  });
  registry.register({
    name: "test",
    aliases: ["spec"],
    description: "Run tests: /test [path]",
    category: "Agent",
    execute: (args) =>
      args.trim()
        ? { kind: "message", text: `Run tests at ${args}` }
        : { kind: "message", text: "Run the test suite and report results" },
  });
  registry.register({
    name: "run",
    aliases: [],
    description: "Run a shell command: /run <command>",
    category: "Agent",
    execute: (args) =>
      args.trim() ? { kind: "run-shell", command: args.trim() } : { kind: "error", text: "Usage: /run <command>" },
  });
  registry.register({
    name: "explain",
    aliases: ["why"],
    description: "Explain code or an error: /explain [what]",
    category: "Agent",
    execute: (args) =>
      args.trim()
        ? { kind: "message", text: `Explain: ${args}` }
        : { kind: "error", text: "Usage: /explain <what to explain>" },
  });
  registry.register({
    name: "undo",
    aliases: [],
    description: "Undo the last change",
    category: "Agent",
    execute: () => ({ kind: "message", text: "Undo the last change that was applied" }),
  });
  registry.register({
    name: "redo",
    aliases: [],
    description: "Redo the last undone change",
    category: "Agent",
    execute: () => ({ kind: "message", text: "Redo the last undone change" }),
  });
  registry.register({
    name: "learn",
    aliases: [],
    description: "Record a learning/preference: /learn <preference>",
    category: "Memory",
    execute: (args) =>
      args.trim() ? { kind: "learn", rule: args.trim() } : { kind: "error", text: "Usage: /learn <preference>" },
  });
  registry.register({
    name: "doctor",
    aliases: ["doc", "diagnostics", "check"],
    description: "Run system diagnostics (Ollama, models, LSP servers, workspace)",
    category: "General",
    execute: () => ({ kind: "doctor" }),
  });
  registry.register({
    name: "capabilities",
    aliases: ["caps", "features"],
    description:
      "Show which features are active, on-demand, degraded or off: /capabilities [fix] (fix builds the sandbox image)",
    category: "General",
    execute: (args) => {
      const action = args.trim().toLowerCase();
      if (action === "fix") return { kind: "capabilities", action: "fix" };
      if (action === "" || action === "show") return { kind: "capabilities", action: "show" };
      return { kind: "error", text: "Usage: /capabilities [fix]" };
    },
    argValues: ["show", "fix"],
  });
  registry.register({
    name: "usage",
    aliases: ["spend"],
    description: "Ollama Cloud request counts and spend: /usage [24h|7d|30d]",
    category: "General",
    execute: (args) => {
      const range = args.trim();
      if (range === "") return { kind: "usage" };
      if (range === "24h" || range === "7d" || range === "30d") return { kind: "usage", range };
      return { kind: "error", text: "Usage: /usage [24h|7d|30d]" };
    },
    argValues: ["24h", "7d", "30d"],
  });
  registry.register({
    name: "balance",
    aliases: ["credits"],
    description: "Show remaining Ollama Cloud credits",
    category: "General",
    execute: () => ({ kind: "balance" }),
  });
  registry.register({
    name: "import-gguf",
    aliases: ["gguf"],
    description: "Publish a local GGUF file as an Ollama model: /import-gguf <model> <path>",
    category: "General",
    execute: (args) => {
      const [model, path] = args.trim().split(/\s+/);
      return model && path
        ? { kind: "import-gguf", model, path }
        : { kind: "error", text: "Usage: /import-gguf <model> <path-to-gguf>" };
    },
  });
  registry.register({
    name: "evolve",
    aliases: ["evolution"],
    description: "Harness self-development: /evolve [diagnose|history|rollback <id>|benchmark]",
    category: "Agent",
    execute: (args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase();
      if (action === "diagnose" || action === "benchmark" || action === "history") {
        return { kind: "evolve", action };
      }
      if (action === "rollback") {
        return parts[1]
          ? { kind: "evolve", action: "rollback", target: parts[1] }
          : { kind: "error", text: "Usage: /evolve rollback <id>" };
      }
      return { kind: "evolve", action: "history" };
    },
    argValues: ["diagnose", "history", "rollback", "benchmark"],
  });
  return registry;
}
