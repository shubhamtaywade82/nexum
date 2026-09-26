/**
 * MCP plane — isolated behind the adapter boundary (review items 19/20).
 *
 *   adapter/mcp-client-factory   the ONLY MCP-SDK import site (v2 split
 *                                packages: @modelcontextprotocol/client)
 *   adapter/mcp-tool-adapter     discovered tools as native Tools with
 *                                full security metadata
 *   adapter/security-metadata    MCP annotations → risk/side-effects/policy
 */

export {
  connectMcpServerV2,
  type McpTransportDescriptor,
  type McpServerConnection,
  type McpDiscoveredTool,
  type ConnectMcpServerOptions,
} from "./adapter/mcp-client-factory.js";
export { McpToolAdapter, type McpClientLike, type McpToolDescriptor } from "./adapter/mcp-tool-adapter.js";
export {
  mcpSecurityMetadata,
  type McpSecurityOverride,
  type McpSecurityOverride as McpServerSecurityOverride,
} from "./adapter/security-metadata.js";
export { connectMcpServer } from "./client.js";

// P2 trust tier — per-server trust levels, tool allow/deny, risk ceilings,
// fingerprinted TOFU approvals (see trust.ts).
export {
  McpTrustPolicy,
  McpApprovalStore,
  mcpTrustPolicyFromConfig,
  mcpServerFingerprint,
  matchesPattern,
  riskAtLeast,
  type McpTrustLevel,
  type McpToolRule,
  type McpServerTrustRule,
  type McpServerTrustConfig,
  type McpServerDecision,
  type McpToolDecision,
  type McpTrustSource,
  type McpTrustPolicyOptions,
  type McpApprovalEntry,
} from "./trust.js";
