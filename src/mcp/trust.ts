/**
 * MCP trust policy (P2 trust tier).
 *
 * Security metadata (adapter/security-metadata.ts) classifies HOW risky a
 * discovered tool is; the trust policy decides whether a server may connect
 * at all and which of its tools may register — the missing gate in front of
 * `connectMcpServerV2` + `AgentToolManager.registerMcpServer`.
 *
 * Layers:
 *   1. Server trust level  — trusted (connect freely) · ask (connect only
 *      with a recorded approval, trust-on-first-use with fingerprint pinning)
 *      · untrusted (never connect).
 *   2. Tool rules          — per-server allow/deny patterns (`*` and `?`
 *      wildcards); deny always wins over allow.
 *   3. Risk ceiling        — tools whose (inferred or overridden) risk is
 *      above the server's maxRisk are denied even when pattern-allowed.
 *
 * Defaults are backward compatible: servers listed in the user's own config
 * are trusted (listing them IS consent), and an empty policy trusts
 * everything — tightening is explicit via rules or defaultTrust.
 *
 * "ask" resolution order: interactive approver callback → TOFU approval
 * store (fingerprinted). With neither available the decision is DENY — an
 * unapproved "ask" server never silently connects.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolRisk } from "../core/tools/tool-contract.js";
import type { McpSecurityOverride } from "./adapter/security-metadata.js";
import type { McpTransportDescriptor } from "./adapter/mcp-client-factory.js";

// ── Contracts ───────────────────────────────────────────────────────────────

export type McpTrustLevel = "trusted" | "ask" | "untrusted";

const RISK_LADDER: readonly ToolRisk[] = ["read", "low", "medium", "high", "critical"];

/** Allow/deny tool-name patterns. `*` matches any run, `?` one char. */
export interface McpToolRule {
  allow?: string[];
  deny?: string[];
}

export interface McpServerTrustRule {
  /** Server names / ids this rule matches (patterns). Empty = default rule. */
  match?: string | string[];
  trust?: McpTrustLevel;
  tools?: McpToolRule;
  /** Tools with risk above this ceiling are denied (default: no ceiling). */
  maxRisk?: ToolRisk;
  /** Security overrides merged into every allowed tool of matched servers. */
  security?: McpSecurityOverride;
}

export type McpTrustSource =
  | { kind: "server-rule"; rule: string }
  | { kind: "default" }
  | { kind: "tofu"; fingerprint: string }
  | { kind: "approver" };

export interface McpServerDecision {
  allowed: boolean;
  level: McpTrustLevel;
  reason: string;
  source: McpTrustSource;
  rule?: Omit<McpServerTrustRule, "match">;
}

export interface McpToolDecision {
  allowed: boolean;
  reason: string;
  source: McpTrustSource;
  /** Merged security override (rule security ∪ caller server override). */
  security?: McpSecurityOverride;
}

export interface McpTrustPolicyOptions {
  rules?: McpServerTrustRule[];
  /** Trust level for servers no rule matches. Default: "trusted" (backward compatible). */
  defaultTrust?: McpTrustLevel;
  /** Interactive approval hook for "ask" servers (UI prompt, etc.). */
  approver?: (server: string, fingerprint: string) => boolean | Promise<boolean>;
  /** Persistent approval store; when absent, "ask" without an approver denies. */
  approvals?: McpApprovalStore;
}

// ── Pattern matching (fnmatch-lite, no deps) ────────────────────────────────

export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("")
        .map((ch) => {
          if (ch === "*") return ".*";
          if (ch === "?") return ".";
          return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        })
        .join("") +
      "$",
  );
  return re.test(name);
}

function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(name, p));
}

/** Order-insensitive risk comparison: riskAtLeast("high", "medium") → true. */
export function riskAtLeast(risk: ToolRisk, floor: ToolRisk): boolean {
  return RISK_LADDER.indexOf(risk) >= RISK_LADDER.indexOf(floor);
}

/** Strictly above the ceiling (risk AT the ceiling is allowed). */
function riskAbove(risk: ToolRisk, ceiling: ToolRisk): boolean {
  return RISK_LADDER.indexOf(risk) > RISK_LADDER.indexOf(ceiling);
}

// ── Fingerprints ────────────────────────────────────────────────────────────

/** Stable identity of a server: command+args (stdio) or URL (sse/http). */
export function mcpServerFingerprint(descriptor: McpTransportDescriptor): string {
  const identity =
    descriptor.kind === "stdio"
      ? JSON.stringify([descriptor.command, descriptor.args ?? [], descriptor.cwd ?? null])
      : descriptor.url;
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

// ── TOFU approval store ─────────────────────────────────────────────────────

export interface McpApprovalEntry {
  fingerprint: string;
  approvedAt: string;
}

/** JSON-file store of first-use approvals, keyed by server name. */
export class McpApprovalStore {
  private readonly file: string;
  private cache: Record<string, McpApprovalEntry> | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private load(): Record<string, McpApprovalEntry> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = {};
      return this.cache;
    }
    try {
      this.cache = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, McpApprovalEntry>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  /** True when the server's CURRENT fingerprint is the approved one. */
  isApproved(server: string, fingerprint: string): boolean {
    const entry = this.load()[server];
    return entry?.fingerprint === fingerprint;
  }

  /** Record/refresh an approval (atomic write). */
  approve(server: string, fingerprint: string): void {
    const data = this.load();
    data[server] = { fingerprint, approvedAt: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = data;
  }

  /** Drop an approval (e.g. after a fingerprint change or explicit revoke). */
  revoke(server: string): boolean {
    const data = this.load();
    if (!(server in data)) return false;
    delete data[server];
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = data;
    return true;
  }

  approvedServers(): string[] {
    return Object.keys(this.load()).sort();
  }

  /** All approvals with their pinned fingerprints, sorted by server name. */
  list(): Array<{ server: string; fingerprint: string; approvedAt: string }> {
    return Object.entries(this.load())
      .map(([server, entry]) => ({
        server,
        fingerprint: entry.fingerprint,
        approvedAt: entry.approvedAt,
      }))
      .sort((a, b) => a.server.localeCompare(b.server));
  }
}

// ── The policy ──────────────────────────────────────────────────────────────

export class McpTrustPolicy {
  private readonly rules: McpServerTrustRule[];
  private readonly defaultTrust: McpTrustLevel;
  private readonly approver?: McpTrustPolicyOptions["approver"];
  private readonly approvals?: McpApprovalStore;

  constructor(opts: McpTrustPolicyOptions = {}) {
    this.rules = opts.rules ?? [];
    this.defaultTrust = opts.defaultTrust ?? "trusted";
    this.approver = opts.approver;
    this.approvals = opts.approvals;
  }

  /** First rule whose match patterns hit the server (default rule = no match list). */
  private ruleFor(server: string): { rule: McpServerTrustRule; label: string } | undefined {
    for (const rule of this.rules) {
      const patterns = rule.match === undefined ? [] : Array.isArray(rule.match) ? rule.match : [rule.match];
      if (patterns.length === 0 || matchesAny(server, patterns)) {
        return { rule, label: patterns.length ? patterns.join("|") : "(default rule)" };
      }
    }
    return undefined;
  }

  /** Decide whether a server may CONNECT. Async because "ask" may consult the
   * approver / approval store. */
  async decideServer(server: string, fingerprint: string): Promise<McpServerDecision> {
    const hit = this.ruleFor(server);
    const level = hit?.rule.trust ?? this.defaultTrust;
    const ruleFields = hit
      ? { trust: hit.rule.trust, tools: hit.rule.tools, maxRisk: hit.rule.maxRisk, security: hit.rule.security }
      : undefined;

    if (level === "trusted") {
      return {
        allowed: true,
        level,
        reason: `server "${server}" is trusted`,
        source: hit ? { kind: "server-rule", rule: hit.label } : { kind: "default" },
        rule: ruleFields,
      };
    }
    if (level === "untrusted") {
      return {
        allowed: false,
        level,
        reason: `server "${server}" is untrusted by policy`,
        source: hit ? { kind: "server-rule", rule: hit.label } : { kind: "default" },
        rule: ruleFields,
      };
    }

    // "ask": TOFU store first (no prompt for already-approved fingerprints)…
    if (this.approvals?.isApproved(server, fingerprint)) {
      return {
        allowed: true,
        level,
        reason: `server "${server}" approved earlier (fingerprint ${fingerprint})`,
        source: { kind: "tofu", fingerprint },
        rule: ruleFields,
      };
    }
    // …then the interactive approver, if one is wired…
    if (this.approver) {
      const ok = await this.approver(server, fingerprint);
      if (ok) {
        this.approvals?.approve(server, fingerprint);
        return {
          allowed: true,
          level,
          reason: `server "${server}" approved interactively`,
          source: { kind: "approver" },
          rule: ruleFields,
        };
      }
      return {
        allowed: false,
        level,
        reason: `server "${server}" requires approval and was denied`,
        source: { kind: "approver" },
        rule: ruleFields,
      };
    }
    // …never silently connect an unapproved "ask" server.
    return {
      allowed: false,
      level,
      reason:
        `server "${server}" requires approval (trust: ask). Approve it once — e.g. via the UI or ` +
        `the approval store — to connect; the approval is pinned to the server's current fingerprint.`,
      source: hit ? { kind: "server-rule", rule: hit.label } : { kind: "default" },
      rule: ruleFields,
    };
  }

  /** Decide whether a discovered TOOL of `server` may register. */
  decideTool(server: string, toolName: string, risk: ToolRisk): McpToolDecision {
    const hit = this.ruleFor(server);
    const tools = hit?.rule.tools;
    const security = hit?.rule.security;

    if (tools?.deny && matchesAny(toolName, tools.deny)) {
      return {
        allowed: false,
        reason: `tool "${toolName}" matches a deny pattern`,
        source: { kind: "server-rule", rule: hit!.label },
      };
    }
    if (tools?.allow && !matchesAny(toolName, tools.allow)) {
      return {
        allowed: false,
        reason: `tool "${toolName}" matches no allow pattern`,
        source: { kind: "server-rule", rule: hit!.label },
      };
    }
    const maxRisk = hit?.rule.maxRisk;
    if (maxRisk && riskAbove(risk, maxRisk)) {
      return {
        allowed: false,
        reason: `tool "${toolName}" risk "${risk}" exceeds the server's maxRisk "${maxRisk}"`,
        source: { kind: "server-rule", rule: hit!.label },
      };
    }
    return {
      allowed: true,
      reason: `tool "${toolName}" allowed`,
      source: hit ? { kind: "server-rule", rule: hit.label } : { kind: "default" },
      security,
    };
  }
}

// ── Config → policy ─────────────────────────────────────────────────────────

/** Per-server trust knobs on a config `mcpServers` entry (all optional). */
export interface McpServerTrustConfig {
  /** Trust level; servers listed in the user's config default to "trusted". */
  trust?: McpTrustLevel;
  /** Tool allow/deny patterns for this server. */
  tools?: McpToolRule;
  /** Risk ceiling for this server's tools. */
  maxRisk?: ToolRisk;
}

/** Build a policy from config entries. Entries without a trust field are
 * explicitly listed by the user in their own config — that listing is
 * consent, so they default to "trusted" (current behavior preserved). */
export function mcpTrustPolicyFromConfig(
  servers: Array<{ name: string; trust?: McpTrustLevel; tools?: McpToolRule; maxRisk?: ToolRisk }>,
  opts: Pick<McpTrustPolicyOptions, "approver" | "approvals"> = {},
): McpTrustPolicy {
  return new McpTrustPolicy({
    rules: servers
      .filter((s) => s.trust !== undefined || s.tools !== undefined || s.maxRisk !== undefined)
      .map((s) => ({ match: s.name, trust: s.trust, tools: s.tools, maxRisk: s.maxRisk })),
    // Config-listed servers without rules keep today's connect-freely behavior.
    defaultTrust: "trusted",
    ...opts,
  });
}
