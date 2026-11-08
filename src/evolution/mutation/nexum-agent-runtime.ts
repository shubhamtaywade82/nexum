/**
 * NexumEngineeringAgentRuntime — the PRODUCTION wiring for the
 * EngineeringAgentRuntime seam.
 *
 * v2.2 introduced the seam (AgentMutationStrategy + executor pipeline) but
 * shipped only ScriptedAgentRuntime as a concrete implementation, leaving
 * "what actually proposes the edits in production" open. This module closes
 * that gap: it runs Nexum's OWN engineering loop — a bounded, tool-calling
 * chat loop over the same Provider surface the interactive agent uses —
 * against the confined candidate worktree:
 *
 *   ClosedLoopEngine (agentRuntime)
 *     ↓  auto-builds GitWorktreeMutationExecutor + AgentMutationStrategy
 *   NexumEngineeringAgentRuntime
 *     ↓  bounded tool loop over EngineeringChatClient (Nexum Provider)
 *   list_files / read_file / propose_edit / finish / decline
 *     ↓  proposals only — the executor applies, verifies (actual-diff
 *        audit), commits, benchmarks, and delivers
 *
 * Trust boundary (unchanged, defense in depth — this runtime adds a layer):
 *   1. the agent is PROMPTED with the allowed paths and the propose-only
 *      contract;
 *   2. propose_edit REJECTS out-of-scope paths at queue time with an error
 *      message the agent can read and self-correct;
 *   3. the final response is re-audited fail-closed (any out-of-scope or
 *      undersized proposal aborts the cycle);
 *   4. the strategy attributes every edit to a scope component;
 *   5. the executor's scope guard audits the ACTUAL git diff.
 * This runtime is deliberately read+propose only: it never writes to disk and
 * never runs shell commands — the executor remains the sole writer, so the
 * verification pipeline cannot be bypassed by the agent.
 */

import { ChatMessage, ChatResponse, OllamaToolSchema, Provider } from "../../models/adapters/provider.js";
import {
  AgentEditProposal,
  AgentMutationError,
  AgentMutationRequest,
  AgentMutationResponse,
  AgentMutationStrategy,
  EngineeringAgentRuntime,
} from "./agent-mutation.js";
import { mutationScopeViolation } from "./path-scope.js";

// Re-export the provider class so callers can build clients without reaching
// into the provider module themselves.
export { Provider };

// ── Chat abstraction ────────────────────────────────────────────────────────

/**
 * Minimal chat surface the engineering loop needs. Satisfied by Nexum's
 * `Provider` (production) and by scripted fakes (tests / dry runs).
 */
export interface EngineeringChatClient {
  chat(messages: ChatMessage[], opts?: { tools?: OllamaToolSchema[] }): Promise<ChatResponse>;
}

/**
 * Wraps a Nexum Provider into the EngineeringChatClient surface, optionally
 * pinning a per-request model (so the evolution loop can use a different
 * model than the interactive agent without mutating the provider).
 */
export function chatClientFromProvider(provider: Provider, model?: string): EngineeringChatClient {
  return {
    chat: (messages, opts) => provider.chat(messages, { tools: opts?.tools, ...(model ? { model } : {}) }),
  };
}

// ── Runtime options ─────────────────────────────────────────────────────────

export interface NexumEngineeringAgentRuntimeOptions {
  /** Chat surface (production: chatClientFromProvider(new Provider(...))). */
  chat: EngineeringChatClient;
  /** Upper bound on chat turns; runaway loops abort with AgentMutationError. */
  maxTurns?: number;
  /** Upper bound on proposals for one mutation (mirrors the strategy cap). */
  maxProposals?: number;
  /** Upper bound on one proposed file's content, in bytes. */
  maxEditBytes?: number;
  /** Extra system-prompt guidance (repo conventions, target specifics). */
  systemPromptExtras?: string;
  /** Optional observability hook: fired once per completed turn. */
  onTurn?: (turn: number, toolCalls: string[]) => void;
}

// ── Tool protocol ───────────────────────────────────────────────────────────

/**
 * The propose-only tool schemas. Exported so the kernel-backed runtime
 * (kernel-agent-runtime.ts) can mount the SAME protocol as kernel tools —
 * one tool vocabulary, two supervision models.
 */
export const TOOLS: OllamaToolSchema[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List repository-relative file paths in the candidate worktree, recursively, sorted. Optionally restricted to a path prefix.",
      parameters: {
        type: "object",
        properties: { prefix: { type: "string", description: "Optional repo-relative path prefix filter." } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a repo-relative file from the candidate worktree. Returns its full text or an error.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative file path with forward slashes." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search file contents with a JavaScript regular expression. Returns matching lines as path:line: text (capped). Use it to locate code instead of reading whole files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: 'JavaScript regular expression, e.g. "InvalidMarket|market:".' },
          prefix: { type: "string", description: 'Optional repo-relative path prefix, e.g. "src/tools".' },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_edit",
      description:
        "Propose the FULL new content of a repo-relative file. You do not write to disk — the executor applies, verifies, and commits. Paths must be inside the allowed mutation paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path with forward slashes." },
          content: { type: "string", description: "The complete new file content." },
          rationale: { type: "string", description: "Why this edit moves the target metric." },
        },
        // rationale stays optional: requiring it rejected the only edits agents ever proposed.
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the investigation. Requires at least one accepted propose_edit.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "What was changed and why it moves the target." } },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "decline",
      description:
        "Decline to mutate: report why no safe, in-scope mutation exists for the target. No candidate is produced.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the mutation is unsafe or impossible." } },
        required: ["reason"],
      },
    },
  },
];

const MAX_SEARCH_MATCHES = 60;

/** Read-only content search over the worktree; returns `path:line: text` matches or an error. */
export async function searchFiles(
  worktree: Pick<AgentMutationRequest["worktree"], "listFiles" | "readFile">,
  args: Record<string, unknown>,
): Promise<{ matches: string[]; truncated: boolean } | { error: string }> {
  let regex: RegExp;
  try {
    regex = new RegExp(typeof args.pattern === "string" ? args.pattern : "");
  } catch (err) {
    return { error: `invalid regular expression: ${(err as Error).message}` };
  }
  const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
  const matches: string[] = [];
  for (const path of await worktree.listFiles(prefix)) {
    const lines = (await worktree.readFile(path))?.split("\n") ?? [];
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue;
      if (matches.length === MAX_SEARCH_MATCHES) return { matches, truncated: true };
      matches.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }
  return { matches, truncated: false };
}

// ── Runtime ─────────────────────────────────────────────────────────────────

interface QueuedEdit {
  proposal: AgentEditProposal;
  /** Raw tool-call id for echo-back ordering. */
  callIndex: number;
}

export class NexumEngineeringAgentRuntime implements EngineeringAgentRuntime {
  readonly name = "nexum-engineering";
  private readonly chat: EngineeringChatClient;
  private readonly maxTurns: number;
  private readonly maxProposals: number;
  private readonly maxEditBytes: number;
  private readonly systemPromptExtras?: string;
  private readonly onTurn?: (turn: number, toolCalls: string[]) => void;

  constructor(opts: NexumEngineeringAgentRuntimeOptions) {
    this.chat = opts.chat;
    this.maxTurns = opts.maxTurns ?? 24;
    this.maxProposals = opts.maxProposals ?? 25;
    this.maxEditBytes = opts.maxEditBytes ?? 512 * 1024;
    this.systemPromptExtras = opts.systemPromptExtras;
    this.onTurn = opts.onTurn;
  }

  async proposeMutation(request: AgentMutationRequest): Promise<AgentMutationResponse> {
    const { worktree } = request;

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt(request) },
      { role: "user", content: this.missionPrompt(request) },
    ];

    const proposals: QueuedEdit[] = [];
    const investigation: string[] = [];
    let finished: string | null = null;
    let declined: string | null = null;

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      const response = await this.chat.chat(messages, { tools: TOOLS });
      const toolCalls = this.toolCallsOf(response);

      // A pure-text turn (no tool calls) cannot advance the protocol; nudge.
      if (toolCalls.length === 0) {
        messages.push({ role: "assistant", content: response.message.content ?? "" });
        messages.push({
          role: "user",
          content: "Respond only through the provided tools. Call propose_edit to queue edits, then finish or decline.",
        });
        this.onTurn?.(turn, []);
        continue;
      }

      messages.push({
        role: "assistant",
        content: response.message.content ?? "",
        tool_calls: toolCalls,
      });

      const invoked: string[] = [];
      for (const call of toolCalls) {
        const { name, args } = this.parseCall(call);
        invoked.push(name);
        let result: Record<string, unknown>;

        if (name === "list_files") {
          const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
          const files = await worktree.listFiles(prefix);
          investigation.push(`list_files(${prefix ?? "*"}) → ${files.length} files`);
          result = { files };
        } else if (name === "read_file") {
          const path = typeof args.path === "string" ? args.path : "";
          const content = await worktree.readFile(path);
          investigation.push(`read_file(${path}) → ${content === null ? "MISSING" : `${content.length} chars`}`);
          result = content === null ? { error: `file not found or unreadable: ${path}` } : { path, content };
        } else if (name === "search_files") {
          result = await searchFiles(worktree, args);
          investigation.push(`search_files(${String(args.pattern)})`);
        } else if (name === "propose_edit") {
          const verdict = this.checkProposal(args, request, proposals.length);
          if (verdict.error !== null) {
            investigation.push(`propose_edit(${verdict.path ?? "?"}) → REJECTED: ${verdict.error}`);
            result = { error: verdict.error };
          } else {
            proposals.push({
              callIndex: proposals.length,
              proposal: { path: verdict.path!, content: verdict.content!, rationale: verdict.rationale ?? "" },
            });
            investigation.push(`propose_edit(${verdict.path}) → queued (${proposals.length}/${this.maxProposals})`);
            result = { ok: true, path: verdict.path, queued: proposals.length };
          }
        } else if (name === "finish") {
          finished = typeof args.summary === "string" && args.summary.length > 0 ? args.summary : "Mutation finished.";
          result = { ok: true };
        } else if (name === "decline") {
          declined =
            typeof args.reason === "string" && args.reason.length > 0 ? args.reason : "agent declined without a reason";
          result = { ok: true };
        } else {
          result = { error: `unknown tool: ${name}. Available: list_files, read_file, propose_edit, finish, decline.` };
        }

        messages.push({ role: "tool", content: JSON.stringify(result) });
      }

      this.onTurn?.(turn, invoked);

      if (declined !== null) {
        return { edits: [], investigation, summary: "Declined.", declined: { reason: declined } };
      }
      if (finished !== null) {
        // Fail-closed re-audit of everything actually queued: scope + size.
        for (const queued of proposals) {
          const violation = this.scopeViolationOf(queued.proposal.path, request);
          if (violation) {
            throw new AgentMutationError(
              `Queued proposal ${queued.proposal.path} is outside the allowed mutation paths (${violation}); aborting fail-closed.`,
            );
          }
        }
        if (proposals.length === 0) {
          // Honest outcome: the agent investigated but found nothing to change.
          return {
            edits: [],
            investigation,
            summary: finished,
            declined: { reason: `investigation finished without any proposed edit: ${finished}` },
          };
        }
        return {
          edits: proposals.map((p) => p.proposal),
          investigation,
          summary: finished,
        };
      }
    }

    throw new AgentMutationError(
      `Engineering agent exceeded the ${this.maxTurns}-turn budget without calling finish/decline.`,
    );
  }

  // ── Prompting ───────────────────────────────────────────────────────────

  private systemPrompt(request: AgentMutationRequest): string {
    const lines = [
      "You are Nexum's engineering agent executing a SELF-DEVELOPMENT mutation:",
      "you inspect the candidate worktree of the Nexum repository itself and propose",
      "concrete source edits that move the improvement target's must-move metrics.",
      "",
      "Contract:",
      "- You have NO direct write or shell access. Use propose_edit to queue the FULL",
      "  new content of a file; the executor applies, verifies, and commits it.",
      `- Allowed mutation paths (prefixes): ${request.allowedPaths.join(", ")}`,
      "- Proposing outside them is rejected; repeated violations abort the cycle.",
      "- Read before proposing: understand the existing implementation first.",
      "- Prefer the smallest in-scope change with a clear causal path to the target.",
      "- End with finish (edits queued) or decline (no safe mutation exists).",
      "",
      `Scope components: ${request.scope.components.join(", ")}.`,
      `Worktree parent commit: ${request.worktree.parentCommit}.`,
    ];
    if (request.experienceDigest) {
      lines.push("", "Relevant experience (evidence-grounded digests):", request.experienceDigest);
    }
    if (request.telemetryDigest) {
      lines.push("", "Operational telemetry of the active harness:", request.telemetryDigest);
    }
    if (this.systemPromptExtras) {
      lines.push("", this.systemPromptExtras);
    }
    return lines.join("\n");
  }

  private missionPrompt(request: AgentMutationRequest): string {
    const t = request.target;
    const lines = [
      `Improvement target: ${t.capability} — ${t.desiredOutcome}`,
      t.observableSymptoms.length ? `Symptoms: ${t.observableSymptoms.join("; ")}` : null,
      `Must-move metrics: ${t.measurableMetrics.join(", ")}`,
      t.affectedComponents.length ? `Affected components: ${t.affectedComponents.join(", ")}` : null,
      request.diagnosis
        ? `Diagnosis: ${request.diagnosis.failureClass} at ${request.diagnosis.component} (confidence ${request.diagnosis.confidence}). Root cause: ${request.diagnosis.rootCause} Proposed fix: ${request.diagnosis.proposedFix}`
        : null,
      "",
      "Investigate the worktree (list_files/read_file), then queue your edits with",
      "propose_edit and end with finish — or decline with a concrete reason.",
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
  }

  // ── Tool-call plumbing ──────────────────────────────────────────────────

  private toolCallsOf(response: ChatResponse): Array<{ function: { name: string; arguments: unknown } }> {
    const raw = response.message?.tool_calls;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is { function: { name: string; arguments: unknown } } =>
        typeof c === "object" &&
        c !== null &&
        "function" in c &&
        typeof (c as { function?: { name?: unknown } }).function?.name === "string",
    );
  }

  /** Tool arguments arrive as objects (Ollama) or JSON strings (others). */
  private parseCall(call: { function: { name: string; arguments: unknown } }): {
    name: string;
    args: Record<string, unknown>;
  } {
    const name = call.function.name;
    const raw = call.function.arguments;
    if (typeof raw === "object" && raw !== null) return { name, args: raw as Record<string, unknown> };
    if (typeof raw === "string") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) return { name, args: parsed as Record<string, unknown> };
      } catch {
        // fallthrough to malformed return
      }
      return { name, args: {} };
    }
    return { name, args: {} };
  }

  private scopeViolationOf(path: string, request: AgentMutationRequest): string | null {
    // Shared verdict (path-scope.ts): identical to the kernel runtime's
    // queue-time and fail-closed checks by construction.
    return mutationScopeViolation(path, request.allowedPaths);
  }

  private checkProposal(
    args: Record<string, unknown>,
    request: AgentMutationRequest,
    queuedCount: number,
  ): { path: string | null; content: string | null; rationale: string | null; error: string | null } {
    const path = typeof args.path === "string" ? args.path : null;
    const content = typeof args.content === "string" ? args.content : null;
    const rationale = typeof args.rationale === "string" ? args.rationale : null;

    if (!path || !content) return { path, content, rationale, error: "propose_edit requires path and content strings" };
    if (queuedCount >= this.maxProposals) {
      return { path, content, rationale, error: `proposal budget exhausted (${this.maxProposals})` };
    }
    if (Buffer.byteLength(content, "utf8") > this.maxEditBytes) {
      return {
        path,
        content,
        rationale,
        error: `content exceeds the ${this.maxEditBytes}-byte per-edit cap; split the change`,
      };
    }
    const violation = this.scopeViolationOf(path, request);
    if (violation) return { path, content, rationale, error: `rejected: ${violation}` };
    return { path, content, rationale, error: null };
  }
}

// ── Production factories ────────────────────────────────────────────────────

export interface AgentStrategyProviderOptions {
  tier?: "local" | "cloud";
  model?: string;
  host?: string;
  apiKey?: string;
  apiKeys?: string[];
  timeoutMs?: number;
  /** Per-request model override for the engineering loop. */
  agentModel?: string;
  maxTurns?: number;
  maxProposals?: number;
  maxEditBytes?: number;
  systemPromptExtras?: string;
}

/**
 * One-call production wiring: provider options → Nexum Engineering agent →
 * AgentMutationStrategy. Uses loadConfig() defaults for anything omitted, so
 * `--mutate --agent` inherits the interactive agent's model configuration.
 */
export async function agentMutationStrategyFromProviderOptions(
  overrides: AgentStrategyProviderOptions = {},
): Promise<AgentMutationStrategy> {
  const { loadConfig } = await import("../../cli/config.js");
  const cfg = loadConfig();
  const provider = new Provider({
    tier: overrides.tier ?? cfg.tier,
    model: overrides.model ?? cfg.model,
    ...(cfg.tier === "local" || overrides.tier === "local" ? { host: overrides.host ?? cfg.host } : {}),
    ...(cfg.apiKey || overrides.apiKey ? { apiKey: overrides.apiKey ?? cfg.apiKey } : {}),
    ...(cfg.apiKeys || overrides.apiKeys ? { apiKeys: overrides.apiKeys ?? cfg.apiKeys } : {}),
    ...(cfg.timeoutMs || overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs ?? cfg.timeoutMs } : {}),
  });
  const runtime = new NexumEngineeringAgentRuntime({
    chat: chatClientFromProvider(provider, overrides.agentModel),
    ...(overrides.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
    ...(overrides.maxProposals !== undefined ? { maxProposals: overrides.maxProposals } : {}),
    ...(overrides.maxEditBytes !== undefined ? { maxEditBytes: overrides.maxEditBytes } : {}),
    ...(overrides.systemPromptExtras !== undefined ? { systemPromptExtras: overrides.systemPromptExtras } : {}),
  });
  return new AgentMutationStrategy({ runtime });
}
