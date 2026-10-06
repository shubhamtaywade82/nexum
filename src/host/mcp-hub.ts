import type { McpCliServerConfig } from "../cli/config.js";
import type { McpElicitationHandler } from "../core/user-input.js";
import { connectMcpServerTools } from "../mcp/adapter/mcp-server-tools.js";
import type { McpTrustPolicy } from "../mcp/trust.js";
import type { NexumMcpServerInfo } from "../protocol/types.js";
import type { McpToolAdapter } from "../mcp/adapter/mcp-tool-adapter.js";

// The protocol cannot carry an MCP elicitation to a client yet, so every request is declined
// rather than left waiting for an answer nobody can give.
const DECLINE_ELICITATION: McpElicitationHandler = {
  request: async (request) => ({ id: request.id, action: "decline" }),
};

/**
 * Runs the configured MCP servers once for the whole host. Every session's agent shares these
 * connections instead of spawning its own copy of each server, and `stop()` closes them, which
 * evicting an agent never did.
 */
export class McpHub {
  private readonly connected: Array<{ name: string; tools: McpToolAdapter[]; close: () => Promise<void> }> = [];
  private readonly status = new Map<string, NexumMcpServerInfo["status"]>();

  constructor(
    private readonly servers: McpCliServerConfig[],
    private readonly trust?: McpTrustPolicy,
  ) {}

  /** Connects every server in parallel; a server that fails or is denied is reported, never fatal. */
  async start(): Promise<void> {
    await Promise.all(this.servers.map((server) => this.connect(server)));
  }

  private async connect(server: McpCliServerConfig): Promise<void> {
    try {
      const { tools, close } = await connectMcpServerTools(server.command, server.args ?? [], {
        serverName: server.name,
        trust: this.trust,
        elicitation: DECLINE_ELICITATION,
      });
      this.connected.push({ name: server.name, tools, close });
      this.status.set(server.name, "connected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.set(server.name, message.startsWith("[mcp-trust]") ? "denied" : "failed");
      process.stderr.write(`[nexum host] MCP server "${server.name}" is unavailable: ${message}\n`);
    }
  }

  tools(): McpToolAdapter[] {
    return this.connected.flatMap((server) => server.tools);
  }

  /** Name, trust level, state and tool count per configured server; never commands, args or errors. */
  describe(): NexumMcpServerInfo[] {
    return this.servers.map((server) => ({
      name: server.name,
      trust: server.trust ?? "trusted",
      status: this.status.get(server.name) ?? "failed",
      tools: this.connected.find((c) => c.name === server.name)?.tools.length ?? 0,
    }));
  }

  async stop(): Promise<void> {
    const servers = this.connected.splice(0);
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  }
}
