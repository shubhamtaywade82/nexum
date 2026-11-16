/**
 * Compatibility shim (review item 19): the legacy `connectMcpServer`
 * signature now routes through the v2 adapter boundary. New code should
 * import from mcp/adapter/mcp-client-factory.js (transports, auth,
 * security overrides).
 */

import { connectMcpServerTools, type McpServerToolsOptions } from "./adapter/mcp-server-tools.js";
import type { Tool } from "../tools/tool.js";

/**
 * Connects one stdio server. It requires a trust policy in `opts.trust`; without one, or when the policy does not allow
 * the server, it refuses before the server process starts.
 */
export async function connectMcpServer(
  command: string,
  args: string[] = [],
  opts: McpServerToolsOptions = {},
): Promise<Tool[]> {
  const { tools } = await connectMcpServerTools(command, args, opts);
  return tools;
}

export {
  connectMcpServerV2,
  type McpTransportDescriptor,
  type McpServerConnection,
  type McpDiscoveredTool,
} from "./adapter/mcp-client-factory.js";
export { McpToolAdapter, type McpClientLike, type McpToolDescriptor } from "./adapter/mcp-tool-adapter.js";
export { mcpSecurityMetadata, type McpSecurityOverride } from "./adapter/security-metadata.js";
