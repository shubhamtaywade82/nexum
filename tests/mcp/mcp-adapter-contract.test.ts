// The adapter's contract for one call: a server's explanation reaches the agent, the server's _meta is kept, the run's
// cancellation reaches the client, and a server's own annotations never lower a tool's risk.
import { describe, it, expect, jest } from "@jest/globals";
import { McpToolAdapter } from "../../src/mcp/adapter/mcp-tool-adapter.js";
import { mcpSecurityMetadata } from "../../src/mcp/adapter/security-metadata.js";

const descriptor = {
  name: "lookup",
  description: "Looks something up",
  inputSchema: { type: "object", properties: {} },
};

function clientReturning(result: Record<string, unknown>) {
  return { callTool: jest.fn(async (_request: unknown) => result) };
}

describe("McpToolAdapter: an error from the server", () => {
  it("puts the server's own explanation in the message, and keeps its _meta", async () => {
    const client = clientReturning({
      isError: true,
      content: [{ type: "text", text: "RailsForge persistent index not found (.railsforge/index.sqlite3)." }],
      _meta: { railsforge: { code: "INDEX_UNAVAILABLE" } },
    });
    const out = await new McpToolAdapter(client as never, descriptor).call({});
    expect(out.error).toBe("McpError");
    expect(String(out.message)).toContain("persistent index not found");
    expect(out._meta).toEqual({ railsforge: { code: "INDEX_UNAVAILABLE" } });
  });

  it("falls back to the generic message when the server sent no text", async () => {
    const out = await new McpToolAdapter(clientReturning({ isError: true, content: [] }) as never, descriptor).call({});
    expect(String(out.message)).toMatch(/^MCP Tool Error\. Expected Schema:/);
  });
});

describe("McpToolAdapter: cancellation", () => {
  it("passes the run's signal to the client's call, so the server can be told", async () => {
    const client = clientReturning({ content: [] });
    const controller = new AbortController();
    await new McpToolAdapter(client as never, descriptor).call({}, {
      signal: controller.signal,
      invocation: {},
    } as never);
    expect(client.callTool.mock.calls[0][0]).toMatchObject({ signal: controller.signal });
  });
});

describe("a server's annotations do not set a tool's risk", () => {
  it("a tool that claims to be read-only is still high risk, until the user sets its risk", () => {
    const declared = { ...descriptor, annotations: { readOnlyHint: true, destructiveHint: false } };
    expect(mcpSecurityMetadata(declared, {}).risk).toBe("high");
    expect(mcpSecurityMetadata(declared, { risk: "read" }).risk).toBe("read");
  });
});
