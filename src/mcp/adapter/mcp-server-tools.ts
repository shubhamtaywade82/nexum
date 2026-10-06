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
    ...(opts.elicitation ? { elicitation: opts.elicitation } : {}),
  });

  let security: McpSecurityOverride = { ...opts.security };
  if (opts.trust) {
    const fingerprint = mcpServerFingerprint(connection.descriptor);
    const decision = await opts.trust.decideServer(serverName, fingerprint);
    if (!decision.allowed) {
      await connection.close();
      throw new Error(`[mcp-trust] ${decision.reason}`);
    }
    security = { ...security, ...decision.rule?.security };
  }

  const tools: McpToolAdapter[] = [];
  for (const discovered of connection.tools) {
    // Effective risk first (inference + overrides) so the ceiling sees what the gateway will enforce.
    const metadata = mcpSecurityMetadata(discovered, security);
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
        security,
      ),
    );
  }
  return { tools, close: () => connection.close() };
}
