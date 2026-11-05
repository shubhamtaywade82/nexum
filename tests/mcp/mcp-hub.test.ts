import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHub } from "../../src/host/mcp-hub.js";
import { AgentToolManager } from "../../src/cli/agent-tools.js";
import { mcpTrustPolicyFromConfig } from "../../src/mcp/trust.js";
import { isUiInvocable } from "../../src/host/ui-tools.js";
import type { McpCliServerConfig } from "../../src/cli/config.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs");

function fixtureServer(overrides: Partial<McpCliServerConfig> = {}, pidFile?: string): McpCliServerConfig {
  return { name: "fixture", command: process.execPath, args: [FIXTURE, ...(pidFile ? [pidFile] : [])], ...overrides };
}

async function processExited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("McpHub", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-hub-"));
  const hubs: McpHub[] = [];
  afterAll(async () => {
    await Promise.all(hubs.map((h) => h.stop()));
    rmSync(dir, { recursive: true, force: true });
  });
  const startHub = async (servers: McpCliServerConfig[], trust?: ReturnType<typeof mcpTrustPolicyFromConfig>) => {
    const hub = new McpHub(servers, trust);
    hubs.push(hub);
    await hub.start();
    return hub;
  };

  it("should connect a configured server and report its state and tools", async () => {
    const hub = await startHub([fixtureServer()]);

    expect(hub.describe()).toEqual([{ name: "fixture", trust: "trusted", status: "connected", tools: 3 }]);
    expect(hub.tools().map((t) => t.name)).toEqual(["echo", "read_file", "wipe"]);
  });

  it("should report a server the trust policy refuses as denied, with no tools", async () => {
    const servers = [fixtureServer({ trust: "ask" })];

    const hub = await startHub(servers, mcpTrustPolicyFromConfig(servers));

    expect(hub.describe()).toEqual([{ name: "fixture", trust: "ask", status: "denied", tools: 0 }]);
    expect(hub.tools()).toEqual([]);
  });

  it("should keep running when one server cannot start, and not leak the error text", async () => {
    const hub = await startHub([
      fixtureServer({ name: "broken", command: join(dir, "no-such-binary"), args: ["--secret-token=hunter2"] }),
      fixtureServer(),
    ]);

    expect(hub.describe().map((s) => [s.name, s.status])).toEqual([
      ["broken", "failed"],
      ["fixture", "connected"],
    ]);
    expect(JSON.stringify(hub.describe())).not.toContain("hunter2");
    expect(hub.tools()).toHaveLength(3);
  });

  it("should end the server process when the hub stops", async () => {
    const pidFile = join(dir, "server.pid");
    const hub = await startHub([fixtureServer({}, pidFile)]);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(pid, 0)).not.toThrow();

    await hub.stop();

    await expect(processExited(pid)).resolves.toBe(true);
  });

  describe("registered into an agent's tool manager", () => {
    function agentTools(): AgentToolManager {
      const workspace = mkdtempSync(join(dir, "ws-"));
      writeFileSync(join(workspace, "notes.txt"), "real file content");
      const tools = new AgentToolManager();
      tools.registerBaseTools(workspace);
      return tools;
    }

    it("should never let an MCP tool replace a built-in tool of the same name", async () => {
      const hub = await startHub([fixtureServer()]);
      const tools = agentTools();

      const { registered, skipped } = tools.registerMcpTools(hub.tools());
      const read = await tools.gateway.invoke("read_file", { path: "notes.txt" });

      expect(skipped).toEqual(["read_file"]);
      expect(registered.map((t) => t.name)).toEqual(["echo", "wipe"]);
      expect(JSON.stringify(read.data)).toContain("real file content");
      expect(JSON.stringify(read.data)).not.toContain("FIXTURE");
    });

    it("should run an MCP tool through the gateway", async () => {
      const hub = await startHub([fixtureServer()]);
      const tools = agentTools();
      tools.registerMcpTools(hub.tools());

      const result = await tools.gateway.invoke("echo", { text: "hi" });

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.data)).toContain("echo:hi");
    });

    it("should enforce the risk the server's own hints imply, and keep every MCP tool agent-only", async () => {
      const hub = await startHub([fixtureServer()]);
      const tools = agentTools();
      tools.registerMcpTools(hub.tools());

      const definitions = Object.fromEntries(tools.gateway.discover().map((d) => [d.id, d]));

      expect(definitions.wipe.risk).toBe("high");
      expect(definitions.wipe.policy.confirmation).toBe("required");
      expect(definitions.echo.risk).toBe("low");
      expect([definitions.echo, definitions.wipe].some(isUiInvocable)).toBe(false);
    });
  });
});
