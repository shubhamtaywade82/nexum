/**
 * Context provider framework — formal model-visible context contributions.
 *
 * Nexum already has a ContextManager (core/types.ts) and a context packer
 * (src/context/packer.ts) for prompt assembly. What's missing is the formal
 * provider architecture: separate, composable sources of context that are
 * made model-visible and durable within session history.
 *
 * DeepSeek Harness has separate context providers for:
 *   - workspace instructions
 *   - file references
 *   - other sessions
 *   - current time
 *   - agent location/state
 *
 * This module formalizes that pattern:
 *
 *   ContextProvider         ← pluggable source of context fragments
 *   ContextFragment         ← a typed, tagged piece of context
 *   ContextService          ← orchestrates providers, assembles fragments
 *
 * Built-in providers:
 *   - WorkspaceContextProvider  (project root, git branch, workspace instructions)
 *   - FileReferenceProvider    (referenced files injected as context)
 *   - SessionReferenceProvider (other sessions the agent can see)
 *   - TimeContextProvider      (current time, timezone)
 *   - RuntimeContextProvider   (agent id, run id, capabilities)
 *   - GitContextProvider       (current branch, recent commits, diff summary)
 *   - DomainContextProvider    (domain-specific context, e.g. crypto market state)
 *
 * Each provider contributes ContextFragments which the ContextService
 * assembles into a single system-prompt section. Fragments are typed and
 * tagged so the model can distinguish "this is a file reference" from
 * "this is the current time".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Contracts ───────────────────────────────────────────────────────────────

export type ContextFragmentKind =
  | "workspace"
  | "file-reference"
  | "session-reference"
  | "time"
  | "runtime"
  | "git"
  | "domain"
  | "custom";

export interface ContextFragment {
  /** Which provider contributed this fragment. */
  provider: string;
  /** The kind of context (for model-visible tagging). */
  kind: ContextFragmentKind;
  /** Human-facing label (e.g. "Current Time", "Git Branch"). */
  label: string;
  /** The actual content (markdown-formatted). */
  content: string;
  /** Priority (higher = more important; used for truncation). */
  priority?: number;
  /** Estimated token cost (for budgeting). */
  tokens?: number;
}

export interface ContextProvider {
  /** Unique provider id. */
  readonly id: string;
  /** Contribute context fragments for the current step. */
  contribute(input: ContextContributionInput): ContextFragment[] | Promise<ContextFragment[]>;
}

export interface ContextContributionInput {
  /** The user's current prompt. */
  prompt: string;
  /** Workspace root (if available). */
  workspaceRoot?: string;
  /** Current session id. */
  sessionId?: string;
  /** Current run id. */
  runId?: string;
  /** Current agent id. */
  agentId?: string;
  /** Agent capabilities. */
  agentCapabilities?: string[];
  /** Files referenced in the prompt or recent tool calls. */
  referencedFiles?: string[];
  /** Other session ids the agent can see. */
  visibleSessions?: string[];
  /** Domain-specific context (e.g. crypto market state). */
  domainContext?: Record<string, unknown>;
  /** Maximum tokens the provider should contribute. */
  maxTokens?: number;
}

export interface ContextAssemblyResult {
  /** All fragments, sorted by priority descending. */
  fragments: ContextFragment[];
  /** The assembled system-prompt section (markdown). */
  content: string;
  /** Total estimated tokens. */
  totalTokens: number;
  /** Whether the assembly was truncated to fit a budget. */
  truncated: boolean;
}

// ── ContextService ──────────────────────────────────────────────────────────

export interface ContextServiceOptions {
  /** Maximum tokens for the assembled context (default 4000). */
  maxTokens?: number;
}

export class ContextService {
  private readonly providers: ContextProvider[] = [];
  private readonly maxTokens: number;

  constructor(opts: ContextServiceOptions = {}) {
    this.maxTokens = opts.maxTokens ?? 4000;
  }

  registerProvider(provider: ContextProvider): this {
    if (this.providers.some((p) => p.id === provider.id)) {
      throw new Error(`context provider "${provider.id}" already registered`);
    }
    this.providers.push(provider);
    return this;
  }

  unregisterProvider(id: string): boolean {
    const idx = this.providers.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.providers.splice(idx, 1);
    return true;
  }

  listProviders(): string[] {
    return this.providers.map((p) => p.id);
  }

  /** Assemble context from all providers, respecting the token budget. */
  async assemble(input: ContextContributionInput): Promise<ContextAssemblyResult> {
    const allFragments: ContextFragment[] = [];
    for (const provider of this.providers) {
      try {
        const fragments = await provider.contribute(input);
        allFragments.push(...fragments);
      } catch {
        // A failing provider shouldn't break context assembly.
      }
    }

    // Sort by priority descending (undefined priority = 0).
    allFragments.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // Apply token budget: drop lowest-priority fragments that exceed budget.
    let totalTokens = 0;
    const kept: ContextFragment[] = [];
    const budget = input.maxTokens ?? this.maxTokens;
    for (const fragment of allFragments) {
      const tokens = fragment.tokens ?? estimateTokens(fragment.content);
      if (totalTokens + tokens > budget && kept.length > 0) {
        // Skip this fragment — over budget.
        continue;
      }
      kept.push({ ...fragment, tokens });
      totalTokens += tokens;
    }

    const content = formatFragments(kept);
    return {
      fragments: kept,
      content,
      totalTokens,
      truncated: kept.length < allFragments.length,
    };
  }
}

// ── Built-in providers ──────────────────────────────────────────────────────

/** Workspace instructions + project root. */
export class WorkspaceContextProvider implements ContextProvider {
  readonly id = "workspace";

  async contribute(input: ContextContributionInput): Promise<ContextFragment[]> {
    if (!input.workspaceRoot) return [];
    const fragments: ContextFragment[] = [];

    fragments.push({
      provider: this.id,
      kind: "workspace",
      label: "Workspace Root",
      content: `Workspace: \`${input.workspaceRoot}\``,
      priority: 10,
    });

    // Look for AGENTS.md or workspace instructions.
    const instructionsPath = join(input.workspaceRoot, "AGENTS.md");
    if (existsSync(instructionsPath)) {
      try {
        const content = readFileSync(instructionsPath, "utf8");
        fragments.push({
          provider: this.id,
          kind: "workspace",
          label: "Workspace Instructions",
          content: truncate(content, 2000),
          priority: 8,
        });
      } catch {
        // unreadable — skip
      }
    }

    return fragments;
  }
}

/** File references injected as context. */
export class FileReferenceProvider implements ContextProvider {
  readonly id = "file-reference";

  async contribute(input: ContextContributionInput): Promise<ContextFragment[]> {
    if (!input.referencedFiles || input.referencedFiles.length === 0) return [];
    if (!input.workspaceRoot) return [];

    const fragments: ContextFragment[] = [];
    for (const file of input.referencedFiles.slice(0, 5)) {
      const path = file.startsWith("/") ? file : join(input.workspaceRoot, file);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf8");
        fragments.push({
          provider: this.id,
          kind: "file-reference",
          label: `File: ${file}`,
          content: `\`\`\`\n${truncate(content, 1000)}\n\`\`\``,
          priority: 5,
        });
      } catch {
        // unreadable — skip
      }
    }
    return fragments;
  }
}

/** Other sessions the agent can see. */
export class SessionReferenceProvider implements ContextProvider {
  readonly id = "session-reference";

  async contribute(input: ContextContributionInput): Promise<ContextFragment[]> {
    if (!input.visibleSessions || input.visibleSessions.length === 0) return [];
    return [
      {
        provider: this.id,
        kind: "session-reference",
        label: "Visible Sessions",
        content: `This agent can see sessions: ${input.visibleSessions.slice(0, 10).join(", ")}`,
        priority: 3,
      },
    ];
  }
}

/** Current time + timezone. */
export class TimeContextProvider implements ContextProvider {
  readonly id = "time";

  async contribute(_input: ContextContributionInput): Promise<ContextFragment[]> {
    const now = new Date();
    return [
      {
        provider: this.id,
        kind: "time",
        label: "Current Time",
        content: `Current time: ${now.toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        priority: 7,
      },
    ];
  }
}

/** Runtime state (agent id, run id, capabilities). */
export class RuntimeContextProvider implements ContextProvider {
  readonly id = "runtime";

  async contribute(input: ContextContributionInput): Promise<ContextFragment[]> {
    const lines: string[] = [];
    if (input.agentId) lines.push(`- Agent: \`${input.agentId}\``);
    if (input.runId) lines.push(`- Run: \`${input.runId}\``);
    if (input.sessionId) lines.push(`- Session: \`${input.sessionId}\``);
    if (input.agentCapabilities && input.agentCapabilities.length > 0) {
      lines.push(`- Capabilities: ${input.agentCapabilities.join(", ")}`);
    }
    if (lines.length === 0) return [];
    return [
      {
        provider: this.id,
        kind: "runtime",
        label: "Runtime State",
        content: lines.join("\n"),
        priority: 6,
      },
    ];
  }
}

/** Git context (current branch, recent commits). */
export class GitContextProvider implements ContextProvider {
  readonly id = "git";

  async contribute(input: ContextContributionInput): Promise<ContextFragment[]> {
    if (!input.workspaceRoot) return [];
    const gitDir = join(input.workspaceRoot, ".git");
    if (!existsSync(gitDir)) return [];

    const lines: string[] = [];
    try {
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      const branchMatch = head.match(/ref:\s+refs\/heads\/(.+)/);
      if (branchMatch) {
        lines.push(`- Branch: \`${branchMatch[1]}\``);
      }
    } catch {
      // unreadable — skip
    }

    if (lines.length === 0) return [];
    return [
      {
        provider: this.id,
        kind: "git",
        label: "Git State",
        content: lines.join("\n"),
        priority: 4,
      },
    ];
  }
}

/** Domain-specific context (e.g. crypto market state). */
export class DomainContextProvider implements ContextProvider {
  readonly id = "domain";

  async contribute(input: ContextContributionInput): Promise<ContextFragment[]> {
    if (!input.domainContext) return [];
    const entries = Object.entries(input.domainContext);
    if (entries.length === 0) return [];
    const lines = entries.map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    return [
      {
        provider: this.id,
        kind: "domain",
        label: "Domain Context",
        content: lines.join("\n"),
        priority: 5,
      },
    ];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... (truncated)";
}

function formatFragments(fragments: ContextFragment[]): string {
  if (fragments.length === 0) return "";
  const sections = fragments.map((f) => `### ${f.label}\n\n${f.content}`);
  return `## Context\n\n${sections.join("\n\n")}\n`;
}

/** Factory: register all built-in providers. */
export function defaultContextProviders(): ContextProvider[] {
  return [
    new WorkspaceContextProvider(),
    new FileReferenceProvider(),
    new SessionReferenceProvider(),
    new TimeContextProvider(),
    new RuntimeContextProvider(),
    new GitContextProvider(),
    new DomainContextProvider(),
  ];
}
