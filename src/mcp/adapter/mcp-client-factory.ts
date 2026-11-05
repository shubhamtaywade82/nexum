/**
 * MCP client factory — the ONLY module that imports the MCP SDK
 * (review item 19).
 *
 * Migrated from the v1 monolithic `@modelcontextprotocol/sdk` to the
 * current split v2 packages: `@modelcontextprotocol/client` (+ its
 * `./stdio` subpath; core types ride along). Swapping SDK versions in the
 * future touches exactly this file — everything downstream consumes
 * Nexum's own contracts (McpServerConnection, McpToolDescriptor).
 *
 * Transports: stdio (local servers), SSE, and Streamable HTTP (remote
 * servers) behind one descriptor. Auth hooks pass through to the SDK where
 * the transport supports them.
 */

import { randomUUID } from "node:crypto";

import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  type Tool as McpSdkTool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpElicitationHandler, McpElicitationRequest } from "../../core/user-input.js";
import { normalizeMcpElicitationResponse, validateMcpElicitationRequest } from "../../core/user-input.js";

/** Where a server runs and how to reach it. */
export type McpTransportDescriptor =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: "sse"; url: string; requestInit?: Record<string, unknown> }
  | { kind: "http"; url: string; requestInit?: Record<string, unknown> };

/** One connected server: its client handle + discovered tools. */
export interface McpServerConnection {
  serverId: string;
  descriptor: McpTransportDescriptor;
  client: Client;
  tools: McpDiscoveredTool[];
  /** Close the transport (idempotent). */
  close(): Promise<void>;
}

/** A discovered tool normalized to Nexum's shape (SDK types stop here). */
export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  /** MCP annotations (readOnlyHint/destructiveHint/idempotentHint/openWorldHint). */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ConnectMcpServerOptions {
  /** Stable id for the connection (default: derived from descriptor). */
  serverId?: string;
  clientInfo?: { name: string; version: string };
  /** Per-server security overrides (review item 20) applied to every tool. */
  security?: Partial<{
    risk: "read" | "low" | "medium" | "high" | "critical";
    confirmation: "never" | "optional" | "required";
    timeoutMs: number;
    networkRequired: boolean;
    externalMutation: boolean;
  }>;
  signal?: AbortSignal;
  /** Handles server-initiated MCP elicitation/create requests. */
  elicitation?: McpElicitationHandler;
}

function descriptorId(descriptor: McpTransportDescriptor): string {
  switch (descriptor.kind) {
    case "stdio":
      return `stdio:${descriptor.command}`;
    case "sse":
      return `sse:${descriptor.url}`;
    case "http":
      return `http:${descriptor.url}`;
  }
}

function buildTransport(descriptor: McpTransportDescriptor): Transport {
  switch (descriptor.kind) {
    case "stdio":
      return new StdioClientTransport({
        command: descriptor.command,
        args: descriptor.args ?? [],
        env: descriptor.env,
        cwd: descriptor.cwd,
      });
    case "sse":
      return new SSEClientTransport(new URL(descriptor.url), (descriptor.requestInit ?? {}) as never);
    case "http":
      return new StreamableHTTPClientTransport(new URL(descriptor.url), (descriptor.requestInit ?? {}) as never);
  }
}

function normalizeTool(tool: McpSdkTool): McpDiscoveredTool {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    title: tool.title,
    annotations: tool.annotations
      ? {
          title: tool.annotations.title,
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        }
      : undefined,
  };
}

/**
 * Connect one MCP server (any transport), discover its tools, and return
 * a connection handle. The SDK's types never leak past this function's
 * return shape.
 */
export async function connectMcpServerV2(
  descriptor: McpTransportDescriptor,
  opts: ConnectMcpServerOptions = {},
): Promise<McpServerConnection> {
  const transport = buildTransport(descriptor);
  const serverId = opts.serverId ?? descriptorId(descriptor);
  const client = new Client(opts.clientInfo ?? { name: "nexum", version: "2.0.0" }, {
    capabilities: opts.elicitation ? { elicitation: { form: {}, url: {} } } : {},
  });

  const elicitationHandler = opts.elicitation;
  if (elicitationHandler) {
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as {
        mode?: "form" | "url";
        message?: string;
        requestedSchema?: Record<string, unknown>;
        url?: string;
      };
      const elicitation: McpElicitationRequest = {
        id: "mcp-elicit-" + randomUUID(),
        serverId,
        mode: params.mode === "url" ? "url" : "form",
        message: String(params.message ?? ""),
        ...(params.requestedSchema
          ? { requestedSchema: params.requestedSchema as unknown as McpElicitationRequest["requestedSchema"] }
          : {}),
        ...(params.url ? { url: params.url } : {}),
      };
      const problems = validateMcpElicitationRequest(elicitation);
      if (problems.length) throw new Error("invalid MCP elicitation request: " + problems.join("; "));
      const response = await elicitationHandler.request(elicitation);
      if (response.id !== elicitation.id) {
        throw new Error("MCP elicitation response id does not match the active request");
      }
      const normalized = normalizeMcpElicitationResponse(response);
      if (elicitation.mode === "url" && normalized.content) {
        throw new Error("url elicitation responses must not contain form content");
      }
      return normalized;
    });
  }
  await client.connect(transport);

  if (opts.signal?.aborted) {
    await client.close();
    throw new Error("MCP connect aborted before discovery");
  }

  const { tools } = await client.listTools();
  return {
    serverId,
    descriptor,
    client,
    tools: tools.map(normalizeTool),
    close: async () => {
      await client.close();
    },
  };
}
