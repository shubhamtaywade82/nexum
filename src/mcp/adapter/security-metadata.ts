/**
 * MCP security metadata (review item 20, hardened).
 *
 * Authorization metadata for an MCP tool is decided ONLY by the local configuration. The server that
 * owns the tool is a remote party: its annotations (readOnlyHint, destructiveHint, idempotentHint,
 * openWorldHint) are advisory and must never be the reason a call runs without confirmation. A server
 * that lies about readOnlyHint would otherwise lower risk, drop confirmation and clear external
 * mutation in one stroke.
 *
 * Defaults for an unclassified tool are the strictest the gateway understands: high risk, confirmation
 * required, external mutation, no idempotency. Only an explicit local override (the user's trust
 * configuration) can lower any of them. Annotations stay available as display hints; see
 * `mcpServerHints`.
 */

import type { ToolDefinition, ToolRisk } from "../../core/tools/tool-contract.js";
import type { McpDiscoveredTool } from "./mcp-client-factory.js";
import type { ConnectMcpServerOptions } from "./mcp-client-factory.js";

/** Locally declared classification for an MCP tool or every tool of a server. */
export interface McpSecurityOverride {
  risk?: ToolRisk;
  confirmation?: "never" | "optional" | "required";
  timeoutMs?: number;
  networkRequired?: boolean;
  externalMutation?: boolean;
  /** Locally declared idempotency. A server's idempotentHint is never trusted for this. */
  idempotent?: boolean;
}

/**
 * Authorization metadata for an MCP tool. The discovered tool's annotations are deliberately NOT read:
 * `_tool` is accepted so callers keep one signature, and so that a future reader cannot quietly start
 * using hints for authorization without changing this function.
 */
export function mcpSecurityMetadata(
  _tool: McpDiscoveredTool,
  localOverride: McpSecurityOverride = {},
): Pick<ToolDefinition, "risk" | "sideEffects" | "execution" | "policy" | "network"> {
  const risk: ToolRisk = localOverride.risk ?? "high";
  const confirmation = localOverride.confirmation ?? "required";
  const networkRequired = localOverride.networkRequired ?? true;
  const externalMutation = localOverride.externalMutation ?? true;
  const idempotent = localOverride.idempotent === true;

  return {
    risk,
    sideEffects: {
      filesystem: false, // MCP servers mutate THEIR OWN state, not our workspace
      process: false,
      network: networkRequired,
      externalMutation,
      financial: false,
    },
    execution: {
      timeoutMs: localOverride.timeoutMs ?? 60_000,
      concurrency: 2, // remote servers: be gentle
      idempotent,
      reversible: false,
      idempotencyKey: idempotent ? "auto" : "none",
    },
    policy: { confirmation },
    network: {
      required: networkRequired,
      egress: [], // unknown hosts by default; profiles decide
      proxyable: true,
    },
  };
}

/**
 * The server's own annotations, for display only (UI badges, audit logs). Never an input to
 * authorization: `mcpSecurityMetadata` does not read them.
 */
export function mcpServerHints(annotations: McpDiscoveredTool["annotations"]): Readonly<Record<string, boolean>> {
  if (!annotations) return {};
  const hints: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(annotations as Record<string, unknown>)) {
    if (typeof value === "boolean") hints[key] = value;
  }
  return Object.freeze(hints);
}

export type { ConnectMcpServerOptions };
