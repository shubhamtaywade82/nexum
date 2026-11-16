import type { McpElicitationHandler } from "../../core/user-input.js";
import { mcpServerFingerprint, type McpTrustPolicy } from "../trust.js";
import { connectMcpServerV2 } from "./mcp-client-factory.js";
import { McpToolAdapter } from "./mcp-tool-adapter.js";
import { mcpSecurityMetadata, type McpSecurityOverride } from "./security-metadata.js";

/** Trust-gated MCP connection options (P2 trust tier). */
export interface McpServerToolsOptions {
  /** Server name used for rule matching + approvals (default: `stdio:<command>`). */
  serverName?: string;
  /** Trust policy; when set, the server and each of its tools must pass it. */
  trust?: McpTrustPolicy;
  /** Per-server security overrides applied to every tool. */
  security?: McpSecurityOverride;
  elicitation?: McpElicitationHandler;
  /** Resolved environment for the server process (merged over the SDK's safe defaults). */
  env?: Record<string, string>;
}

export interface ConnectedMcpServer {
  tools: McpToolAdapter[];
  close(): Promise<void>;
}

/**
 * Connects one stdio MCP server, applies the trust policy, and wraps the tools it may expose as
 * Nexum tools. Throws `[mcp-trust] <reason>` (after closing the connection) when the server is not allowed.
 */
export async function connectMcpServerTools(
  command: string,
  args: string[] = [],
  opts: McpServerToolsOptions = {},
): Promise<ConnectedMcpServer> {
  const serverName = opts.serverName ?? `stdio:${command}`;
  const connection = await connectMcpServerV2({
    kind: "stdio",
    command,
    args,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.elicitation ? { elicitation: opts.elicitation } : {}),
  });

  let security: McpSecurityOverride = { ...opts.security };
  let toolSecurity: Record<string, McpSecurityOverride> = {};
  if (opts.trust) {
    const fingerprint = mcpServerFingerprint(connection.descriptor);
    const decision = await opts.trust.decideServer(serverName, fingerprint);
    if (!decision.allowed) {
      await connection.close();
      throw new Error(`[mcp-trust] ${decision.reason}`);
    }
    security = { ...security, ...decision.rule?.security };
    toolSecurity = decision.rule?.toolSecurity ?? {};
  }

  const tools: McpToolAdapter[] = [];
  for (const discovered of connection.tools) {
    // Local classification only: the server's annotations never reach authorization. Effective risk
    // (server-wide override, then the per-tool override) is what the ceiling and the gateway enforce.
    const override: McpSecurityOverride = Object.hasOwn(toolSecurity, discovered.name)
      ? { ...security, ...toolSecurity[discovered.name] }
      : security;
    const metadata = mcpSecurityMetadata(discovered, override);
    if (opts.trust && !opts.trust.decideTool(serverName, discovered.name, metadata.risk).allowed) continue;
    tools.push(
      new McpToolAdapter(
        {
          callTool: async (request) => {
            const result = await connection.client.callTool({ name: request.name, arguments: request.arguments });
            return result as unknown as Record<string, unknown>;
          },
        },
        {
          name: discovered.name,
          description: discovered.description,
          inputSchema: discovered.inputSchema,
          annotations: discovered.annotations,
        },
        override,
      ),
    );
  }
  return { tools, close: () => connection.close() };
}
