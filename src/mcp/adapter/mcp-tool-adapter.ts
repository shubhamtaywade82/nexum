/**
 * MCPToolAdapter v2 (review items 19 + 20).
 *
 * Wraps one MCP-discovered tool as a native Nexum Tool WITH full security
 * metadata (risk, side effects, idempotency, timeout, network,
 * confirmation — see security-metadata.ts). The ToolGateway therefore
 * polices MCP tools through the same capability/policy/budget stages as
 * native tools; there is no bypass.
 *
 * Cancellation (review item 16): the call context's AbortSignal races the
 * SDK call — an aborted run can't leave an MCP request hanging.
 */

import { Tool } from "../../tools/tool.js";
import type { ToolCallContext, ToolDefinition } from "../../core/tools/tool-contract.js";
import { mcpSecurityMetadata, mcpServerHints, McpSecurityOverride } from "./security-metadata.js";
import type { McpDiscoveredTool } from "./mcp-client-factory.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpDiscoveredTool["annotations"];
}

/** The call surface a connected MCP client exposes (SDK types stay behind the factory). */
export interface McpClientLike {
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
    timeoutMs?: number;
    /** Aborted when the run is cancelled; the server is told, so it stops its work. */
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
}

export class McpToolAdapter extends Tool {
  readonly security: Pick<ToolDefinition, "risk" | "sideEffects" | "execution" | "policy" | "network">;
  /** The server's own annotations, for display only. Authorization never reads them (see security-metadata.ts). */
  readonly serverHints: Readonly<Record<string, boolean>>;

  constructor(
    private readonly client: McpClientLike,
    private readonly descriptor: McpToolDescriptor,
    serverOverride: McpSecurityOverride = {},
  ) {
    super();
    this.serverHints = mcpServerHints(descriptor.annotations);
    this.security = mcpSecurityMetadata(
      {
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: descriptor.annotations,
      },
      serverOverride,
    );
  }

  get name(): string {
    return this.descriptor.name;
  }

  get description(): string {
    return this.descriptor.description;
  }

  get parameters(): Record<string, unknown> {
    return this.descriptor.inputSchema;
  }

  override get capabilities(): string[] {
    return ["mcp"];
  }

  async call(args: Record<string, unknown>, callCtx?: ToolCallContext): Promise<Record<string, unknown>> {
    const timeoutMs = this.security.execution.timeoutMs;
    const request = this.client.callTool({
      name: this.descriptor.name,
      arguments: args,
      timeoutMs,
      signal: callCtx?.signal,
    });

    try {
      const res = (await raceAbort(request, callCtx?.signal, timeoutMs)) as Record<string, unknown>;
      if (res && (res.isError || res.error)) {
        const schemaString = JSON.stringify(this.descriptor.inputSchema ?? {});
        // The server's own explanation is in its text content. The result's _meta (for example a stable error code) is
        // kept whole, because the spread below carries it.
        return {
          error: "McpError",
          message: `${serverText(res) || res.message || res.error || "MCP Tool Error"}. Expected Schema: ${schemaString}`,
          ...res,
        };
      }
      return res;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const msg = e?.message ?? String(err);
      const schemaString = JSON.stringify(this.descriptor.inputSchema ?? {});
      return {
        error: e?.name === "AbortError" ? "McpCancelled" : "McpError",
        message: e?.name === "AbortError" ? `MCP call cancelled: ${msg}` : `${msg}. Expected Schema: ${schemaString}`,
      };
    }
  }
}

/** The text of an MCP result's text content, joined, or "" when the server sent none. */
function serverText(res: Record<string, unknown>): string {
  const content = Array.isArray(res.content) ? res.content : [];
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Race a call against the abort signal + a hard timeout. */
async function raceAbort<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<T> {
  const racers: Promise<T>[] = [request];
  if (signal) {
    racers.push(
      new Promise<T>((_, reject) => {
        const onAbort = () => reject(Object.assign(new Error("run cancelled"), { name: "AbortError" }));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  if (timeoutMs && timeoutMs > 0) {
    racers.push(
      new Promise<T>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`MCP tool "${""}" timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof t.unref === "function") t.unref();
      }),
    );
  }
  return Promise.race(racers) as Promise<T>;
}
