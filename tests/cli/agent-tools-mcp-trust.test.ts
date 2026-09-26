/**
 * Wiring tests: AgentToolManager.registerMcpServer with the trust policy
 * (P2 trust tier). The MCP client factory is mocked — no real subprocesses.
 *
 * Pins:
 *   - no opts → legacy connect-freely path, all discovered tools register
 *   - trust:untrusted → connection refused + closed, nothing registers
 *   - trust:ask + TOFU approval → registers
 *   - tool deny patterns + risk ceilings filter registration
 *   - security overrides reach the adapters
 */
import { jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.unstable_mockModule("../../src/mcp/adapter/mcp-client-factory.js", () => ({
  connectMcpServerV2: jest.fn(),
}));

const { connectMcpServerV2 } = await import("../../src/mcp/adapter/mcp-client-factory.js");
const { AgentToolManager } = await import("../../src/cli/agent-tools.js");
const { McpTrustPolicy, McpApprovalStore, mcpServerFingerprint } = await import("../../src/mcp/trust.js");
const { McpToolAdapter } = await import("../../src/mcp/adapter/mcp-tool-adapter.js");

const mockConnect = connectMcpServerV2 as jest.Mock;

function discovered(name: string, annotations?: Record<string, boolean>) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(annotations ? { annotations } : {}),
  };
}

function fakeConnection(tools: ReturnType<typeof discovered>[]) {
  return {
    serverId: "stdio:npx",
    descriptor: { kind: "stdio" as const, command: "npx", args: ["srv"] },
    client: { callTool: async (req: { name: string }) => ({ ok: true, tool: req.name }) },
    tools,
    close: jest.fn(async () => {}),
  };
}

beforeEach(() => {
  mockConnect.mockReset();
});

describe("AgentToolManager.registerMcpServer — trust gating", () => {
  it("no opts → legacy path registers every discovered tool", async () => {
    const conn = fakeConnection([discovered("alpha"), discovered("beta")]);
    mockConnect.mockResolvedValueOnce(conn);

    const mgr = new AgentToolManager();
    const tools = await mgr.registerMcpServer("npx", ["srv"]);

    expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
    expect(conn.close).not.toHaveBeenCalled();
  });

  it("trust:untrusted → refuses, closes the connection, registers nothing", async () => {
    const conn = fakeConnection([discovered("alpha")]);
    mockConnect.mockResolvedValueOnce(conn);

    const mgr = new AgentToolManager();
    const policy = new McpTrustPolicy({ rules: [{ match: "evil", trust: "untrusted" }] });

    await expect(mgr.registerMcpServer("npx", ["srv"], { serverName: "evil", trust: policy })).rejects.toThrow(
      /untrusted by policy/,
    );
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it("trust:ask → denied without approval, allowed with a TOFU record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-mcp-wire-"));
    try {
      const policy = (approvals?: McpApprovalStore) =>
        new McpTrustPolicy({ rules: [{ match: "askme", trust: "ask" }], ...(approvals ? { approvals } : {}) });

      const mgr = new AgentToolManager();

      // 1. no approval → refuse
      mockConnect.mockResolvedValueOnce(fakeConnection([discovered("alpha")]));
      await expect(mgr.registerMcpServer("npx", ["srv"], { serverName: "askme", trust: policy() })).rejects.toThrow(
        /requires approval/,
      );

      // 2. approved fingerprint → registers (TOFU)
      const store = new McpApprovalStore(join(dir, "trust.json"));
      store.approve("askme", mcpServerFingerprint({ kind: "stdio", command: "npx", args: ["srv"] }));
      const conn = fakeConnection([discovered("alpha")]);
      mockConnect.mockResolvedValueOnce(conn);
      const tools = await mgr.registerMcpServer("npx", ["srv"], { serverName: "askme", trust: policy(store) });
      expect(tools.map((t) => t.name)).toEqual(["alpha"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deny patterns and risk ceilings filter the registered set", async () => {
    const conn = fakeConnection([
      discovered("query_rows", { readOnlyHint: true }), // → low risk
      discovered("drop_table"), // → medium (unknown default)
      discovered("nuke_all", { destructiveHint: true }), // → high
    ]);
    mockConnect.mockResolvedValueOnce(conn);

    const mgr = new AgentToolManager();
    const policy = new McpTrustPolicy({
      rules: [{ match: "db", tools: { deny: ["drop_*"] }, maxRisk: "medium" }],
    });

    const tools = await mgr.registerMcpServer("npx", ["srv"], { serverName: "db", trust: policy });
    // drop_table: denied by pattern; nuke_all: risk high > medium ceiling
    expect(tools.map((t) => t.name)).toEqual(["query_rows"]);
  });

  it("security overrides reach the adapters", async () => {
    const conn = fakeConnection([discovered("create_issue")]);
    mockConnect.mockResolvedValueOnce(conn);

    const mgr = new AgentToolManager();
    const tools = await mgr.registerMcpServer("npx", ["srv"], {
      serverName: "github",
      security: { risk: "critical", confirmation: "required" },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toBeInstanceOf(McpToolAdapter);
    const adapter = tools[0] as McpToolAdapter;
    expect(adapter.security.risk).toBe("critical");
    expect(adapter.security.policy.confirmation).toBe("required");
  });

  it("rule security merges with caller overrides (rule wins per-field)", async () => {
    const conn = fakeConnection([discovered("create_issue")]);
    mockConnect.mockResolvedValueOnce(conn);

    const mgr = new AgentToolManager();
    const policy = new McpTrustPolicy({
      rules: [{ match: "github", security: { confirmation: "required" } }],
    });
    const tools = await mgr.registerMcpServer("npx", ["srv"], {
      serverName: "github",
      trust: policy,
      security: { timeoutMs: 1234, confirmation: "never" },
    });

    const adapter = tools[0] as McpToolAdapter;
    expect(adapter.security.execution.timeoutMs).toBe(1234); // caller field kept
    expect(adapter.security.policy.confirmation).toBe("required"); // rule field wins
  });
});
