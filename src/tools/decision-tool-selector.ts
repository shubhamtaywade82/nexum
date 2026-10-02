/**
 * DecisionToolSelector — the first Decision-Plane integration for tool
 * selection.
 *
 * Replaces the DynamicToolSelector's "ask the small model to emit a JSON
 * array of tool names" path with a two-stage bounded-decision process:
 *
 *   user request
 *      │
 *      ▼
 *   deterministic domain heuristic
 *      │
 *      ├── high confidence → deterministic domain → tool mapping
 *      │
 *      └── ambiguous
 *            │
 *            ▼
 *       System One (one batched call, all domains as choices)
 *            │
 *            ▼
 *       domain probabilities
 *            │
 *            ▼
 *       decision policy (threshold + maxDomains)
 *            │
 *            ▼
 *       deterministic domain → tool mapping
 *            │
 *            ▼
 *          Tool[]
 *
 * ── Why System One picks DOMAINS, not tool names ────────────────────────────
 *
 * A small model emitting free-form tool names hallucinates: "super_search",
 * "magic_patch", "run_everything" all happen. Asking it to pick a domain
 * from an explicitly bounded list eliminates the hallucination surface —
 * the gateway rejects out-of-band ids (see SystemOneDecisionGateway).
 *
 * ── Security invariants ────────────────────────────────────────────────────
 *
 * The selector returns only `Tool[]`. It has no execute/approve/sandbox/
 * cloud fields, so by construction it cannot:
 *
 *   - bypass the ApprovalBroker (the broker gates tool execution, not
 *     tool selection)
 *   - bypass tool policy (the policy engine runs at execution time, not
 *     at selection time)
 *   - execute a tool (the executor owns Tool.call)
 *   - force cloud execution (tier routing is the Provider/Router's job)
 *
 * The selector can only change WHICH tools are surfaced. It is composed
 * with the existing DynamicToolSelector heuristic in a parallel class so
 * the existing heuristic / llm / hybrid modes are untouched and the
 * existing tests stay valid.
 *
 * ── Fallback ───────────────────────────────────────────────────────────────
 *
 * On any DecisionError from the gateway, the selector returns its own
 * heuristic result (which may be empty). System One is an optimization,
 * not the final authority — see integration prompt §26.
 */

import { Tool } from "./tool.js";
import type { ChatMessage } from "../models/adapters/provider.js";
import {
  DecisionGateway,
  DecisionPolicy,
  DecisionRequest,
  DecisionResult,
  DecisionError,
  applyDecisionPolicy,
  defaultDecisionPolicy,
} from "../models/decision/index.js";

/** Bounded set of domains System One is allowed to choose from. */
export type ToolDomain =
  | "filesystem"
  | "shell"
  | "git"
  | "github"
  | "rails"
  | "database"
  | "browser"
  | "lsp"
  | "documentation"
  | "testing"
  | "package-management"
  | "deployment";

/** Canonical, ordered domain list (also the choices the selector sends). */
export const DOMAINS: ToolDomain[] = [
  "filesystem",
  "shell",
  "git",
  "github",
  "rails",
  "database",
  "browser",
  "lsp",
  "documentation",
  "testing",
  "package-management",
  "deployment",
];

/**
 * Deterministic domain → tool-name mapping. Owned by Nexum, never by System
 * One. The intersection with the runtime-available tools is what the
 * selector actually returns — so System One selecting a domain whose tools
 * are not installed yields nothing, never an invented tool.
 */
export const DOMAIN_TOOL_NAMES: Record<ToolDomain, string[]> = {
  filesystem: ["read_file", "write_file", "patch_file", "search_files", "list_directory"],
  shell: ["run_shell", "exec", "shell"],
  git: ["git_status", "git_diff", "git_commit", "git_branch", "git_log", "git"],
  github: ["github_pr", "github_issue", "github_review", "create_pr", "github"],
  rails: ["rails_console", "rails_routes", "rails_test", "rails_dbconsole", "rails"],
  database: ["db_query", "db_migrate", "db_schema", "sql_query", "database"],
  browser: ["browser_open", "browser_click", "browser_screenshot", "browser_navigate"],
  lsp: ["lsp_diagnostics", "lsp_definition", "lsp_references", "lsp_hover", "lsp"],
  documentation: ["docs_search", "read_docs", "docs", "documentation"],
  testing: ["run_tests", "test_runner", "rspec", "jest_test", "test"],
  "package-management": ["npm_install", "npm_run", "bundle_install", "package_install"],
  deployment: ["deploy", "deploy_status", "rollback"],
};

/**
 * Lightweight domain-keyword patterns used by the heuristic stage. A
 * domain scores one point per distinct keyword that appears in the user
 * prompt. The threshold is intentionally low (>= 1) — any real signal wins
 * outright; "do something complex" / "what is X?" matches nothing and
 * falls through to System One.
 */
const DOMAIN_KEYWORDS: Record<ToolDomain, string[]> = {
  filesystem: ["file", "files", "read", "write", "patch", "open", "save", "directory", "folder", "path", "fs"],
  shell: ["shell", "sh", "bash", "exec", "execute", "run", "command", "cmd", "terminal", "grep", "awk"],
  git: ["git", "commit", "diff", "branch", "merge", "rebase", "checkout", "stash", "log"],
  github: ["github", "pr", "pull request", "issue", "review", "merge request", "mr"],
  rails: ["rails", "ruby on rails", "ror", "rspec", "rake", "gem", "bundler", "bundle"],
  database: ["database", "sql", "query", "schema", "migration", "table", "db", "record"],
  browser: ["browser", "chrome", "playwright", "selenium", "page", "dom", "navigate"],
  lsp: ["lsp", "diagnostic", "definition", "references", "hover", "language server", "completion"],
  documentation: ["docs", "documentation", "readme", "explain", "what is", "how does", "help"],
  testing: ["test", "tests", "testing", "spec", "jest", "vitest", "rspec", "mocha", "unittest"],
  "package-management": ["npm", "yarn", "pnpm", "install", "bundle", "pip", "package"],
  deployment: ["deploy", "deployment", "rollback", "release", "publish", "ci/cd", "ship"],
};

export interface DecisionToolSelectorOptions {
  /** The Decision Plane gateway; undefined disables System One (pure heuristic). */
  decisionGateway?: DecisionGateway;
  /** Dedicated decision model (independent of the primary generation model). */
  decisionModel: string;
  /** Decision policy applied to System One probabilities. */
  decisionPolicy?: DecisionPolicy;
  /** Maximum tools surfaced to the agent. Default 8. */
  maxActiveTools?: number;
  /** Minimum heuristic score (per domain) above which the heuristic wins
   *  outright and System One is not consulted. Default 1. */
  heuristicThreshold?: number;
}

/** Default decision model surfaced by the selector if a caller forgets.
 * `tev1` is the 4B System One model from Together AI, published at
 * https://ollama.com/library/tev1. `tev1:0.8b` is the smaller-memory
 * alternative. */
const DEFAULT_DECISION_MODEL = "tev1";

const DEFAULT_MAX_ACTIVE_TOOLS = 8;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "what",
  "which",
  "is",
  "are",
  "do",
  "does",
  "how",
  "why",
  "i",
  "you",
  "we",
]);

function scoreDomain(prompt: string, domain: ToolDomain): number {
  const keywords = DOMAIN_KEYWORDS[domain];
  const text = prompt.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`);
    if (re.test(text)) score += 1;
  }
  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(prompt: string): string[] {
  return (prompt.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

function topScoringDomains(prompt: string, threshold: number): ToolDomain[] {
  const scored = DOMAINS.map((d) => ({ domain: d, score: scoreDomain(prompt, d) })).filter((s) => s.score >= threshold);
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.domain);
}

function domainsToTools(domains: ToolDomain[], available: Tool[], max: number): Tool[] {
  const availableByName = new Map(available.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const d of domains) {
    for (const name of DOMAIN_TOOL_NAMES[d]) {
      if (seen.has(name)) continue;
      const t = availableByName.get(name);
      if (!t) continue;
      seen.add(name);
      out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function buildDecisionRequest(prompt: string, history: ChatMessage[], model: string): DecisionRequest {
  // Compact context: the user prompt plus a short tail of the last user
  // turn. No full tool descriptions, no repository dump, no source files.
  // This keeps the request well under System One's 64 KiB limit and keeps
  // the decision cheap.
  const tail = history
    .slice(-1)
    .map((m) => m.content ?? "")
    .join(" ")
    .slice(0, 400);
  const context = tail ? `${prompt}\nRecent: ${tail}` : prompt;
  return {
    id: `tool-selection-${Date.now().toString(36)}`,
    model,
    mode: "noul",
    context,
    questions: [
      {
        id: "domain",
        prompt:
          "Which operational domain best matches this user request? Return at most the few most-likely domains; 'none of the above' is a valid answer for conceptual questions.",
        choices: DOMAINS.map((d) => ({ id: d, description: `${d} operations` })),
      },
    ],
    metadata: { subsystem: "tool-selection", promptTokens: tokenize(prompt).length },
  };
}

export class DecisionToolSelector {
  private readonly decisionGateway: DecisionGateway | undefined;
  private readonly decisionModel: string;
  private readonly decisionPolicy: DecisionPolicy;
  private readonly maxActiveTools: number;
  private readonly heuristicThreshold: number;

  constructor(opts: DecisionToolSelectorOptions) {
    this.decisionGateway = opts.decisionGateway;
    this.decisionModel = opts.decisionModel ?? DEFAULT_DECISION_MODEL;
    this.decisionPolicy = opts.decisionPolicy ?? defaultDecisionPolicy;
    this.maxActiveTools = opts.maxActiveTools ?? DEFAULT_MAX_ACTIVE_TOOLS;
    this.heuristicThreshold = opts.heuristicThreshold ?? 1;
  }

  async selectTools(prompt: string, history: ChatMessage[], availableTools: Tool[]): Promise<Tool[]> {
    if (availableTools.length === 0) return [];

    // Stage 1: deterministic domain heuristic. If any domain scores above
    // the threshold, the heuristic wins outright and System One is never
    // consulted.
    const heuristicDomains = topScoringDomains(prompt, this.heuristicThreshold);
    if (heuristicDomains.length > 0) {
      // Bound the heuristic domains by the same maxDomains knob the
      // decision policy uses, so a keyword-heavy prompt does not surface
      // every domain at once.
      const bounded = heuristicDomains.slice(0, this.decisionPolicy.maxDomains);
      return domainsToTools(bounded, availableTools, this.maxActiveTools);
    }

    // Stage 2: ambiguous — consult System One if available.
    if (!this.decisionGateway) {
      // Decision Plane disabled — return the empty heuristic result. The
      // caller's downstream policy decides whether to proceed with no
      // tools or escalate to a heuristic-only mode.
      return [];
    }

    const request = buildDecisionRequest(prompt, history, this.decisionModel);
    let result: DecisionResult;
    try {
      result = await this.decisionGateway.decide(request);
    } catch (err) {
      // Any DecisionError (transport, protocol, policy, unavailable) is
      // caught here. System One is an optimization, not the final
      // authority — fall back to the heuristic result, which is [] for an
      // ambiguous prompt. The caller (agent runtime) decides whether to
      // proceed with no tools, retry with heuristic mode, or escalate.
      if (err instanceof DecisionError) return [];
      throw err;
    }

    const selectedDomains = applyDecisionPolicy(result, this.decisionPolicy).filter((id): id is ToolDomain =>
      (DOMAINS as readonly string[]).includes(id),
    );

    // System One may return a domain the selector knows but for which the
    // runtime has no matching tool (e.g. "deployment" with no deployment
    // tools installed). domainsToTools drops those silently — System One
    // cannot surface an invented tool name.
    return domainsToTools(selectedDomains, availableTools, this.maxActiveTools);
  }
}
