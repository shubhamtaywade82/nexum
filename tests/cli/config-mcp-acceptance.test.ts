// The .nexum/config.json loader, end to end with MCP servers: a workspace's own config can add a server only once the
// user trusts that workspace; an approved server starts with only its allowed tools; an unapproved one never starts.
// It loads the real configuration, builds the policy the agent builds from it, and registers through AgentToolManager.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config.js";
import { AgentToolManager } from "../../src/cli/agent-tools.js";
import { WorkspaceTrustStore, trustWorkspace } from "../../src/cli/workspace-trust.js";
import { McpApprovalStore, mcpServerFingerprint, mcpTrustPolicyFromConfig } from "../../src/mcp/trust.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs");

describe("the .nexum/config.json loader, with MCP servers", () => {
  let home: string;
  let root: string;
  let pidFile: string;
  let trustStore: WorkspaceTrustStore;
  const entry = () => ({
    name: "fixture",
    command: process.execPath,
    args: [FIXTURE, pidFile],
    trust: "ask" as const,
    tools: { allow: ["echo"] },
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nexum-cfg-home-"));
    root = mkdtempSync(join(tmpdir(), "nexum-cfg-ws-"));
    pidFile = join(home, "pids");
    mkdirSync(join(root, ".nexum"));
    writeFileSync(join(root, ".nexum", "config.json"), JSON.stringify({ mcpServers: [entry()] }));
    trustStore = WorkspaceTrustStore.at(join(home, "trusted-workspaces.json"));
  });

  afterEach(() => {
    // The agent keeps a server's connection for the session, and the manager does not expose a way to close it. Stop
    // any fixture the test started, using the pid the fixture recorded.
    if (existsSync(pidFile)) {
      for (const pid of readFileSync(pidFile, "utf8").split("\n").map(Number).filter(Boolean)) {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("an untrusted workspace's config cannot add a server: the key is withheld, and nothing starts", () => {
    const cfg = loadConfig({ workspaceRoot: root, trustStore });
    expect(cfg.mcpServers ?? []).toEqual([]);
    expect(cfg.workspaceTrust.withheldKeys).toContain("mcpServers");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("a trusted workspace's server is loaded, and an ask server without approval is refused before it starts", async () => {
    trustWorkspace(root, trustStore); // the same working directory the loader uses
    const cfg = loadConfig({ workspaceRoot: root, trustStore });
    expect(cfg.mcpServers).toEqual([expect.objectContaining({ name: "fixture", trust: "ask" })]);

    const policy = mcpTrustPolicyFromConfig(cfg.mcpServers ?? [], {
      approvals: new McpApprovalStore(join(home, "mcp-trust.json")),
    });
    const server = entry();
    await expect(
      new AgentToolManager().registerMcpServer(server.command, server.args, { serverName: server.name, trust: policy }),
    ).rejects.toThrow(/\[mcp-trust\].*requires approval/);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("with the server approved for its fingerprint, it starts and offers only the tools the config allows", async () => {
    trustWorkspace(root, trustStore); // the same working directory the loader uses
    const cfg = loadConfig({ workspaceRoot: root, trustStore });
    const approvals = new McpApprovalStore(join(home, "mcp-trust.json"));
    const server = entry();
    approvals.approve(server.name, mcpServerFingerprint({ kind: "stdio", command: server.command, args: server.args }));
    const policy = mcpTrustPolicyFromConfig(cfg.mcpServers ?? [], { approvals });

    const registered = await new AgentToolManager().registerMcpServer(server.command, server.args, {
      serverName: server.name,
      trust: policy,
    });
    // An MCP tool keeps the name its server gave it. Only the allowed one is offered.
    expect(registered.map((tool) => tool.name)).toEqual(["echo"]);
    expect(existsSync(pidFile)).toBe(true);
  }, 30_000);
});
