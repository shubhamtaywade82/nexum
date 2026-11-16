// A server is decided on before anything is started. A denied server, or one with no policy, starts no process and lists
// no tools. The fixture server writes its pid to the file it is given when it starts, so a missing file means it never ran.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpServerTools } from "../../src/mcp/adapter/mcp-server-tools.js";
import { McpApprovalStore, McpTrustPolicy, mcpServerFingerprint } from "../../src/mcp/trust.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs");

describe("a server is decided on before it starts", () => {
  let dir: string;
  let pidFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-trust-spawn-"));
    pidFile = join(dir, "pids");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const args = () => [FIXTURE, pidFile];

  it("a server the policy does not allow is refused, and never starts", async () => {
    const trust = new McpTrustPolicy({ rules: [{ match: "secret", trust: "untrusted" }] });
    await expect(connectMcpServerTools(process.execPath, args(), { serverName: "secret", trust })).rejects.toThrow(
      /\[mcp-trust\].*untrusted by policy/,
    );
    expect(existsSync(pidFile)).toBe(false);
  });

  it("an ask server with no approval is refused, and never starts", async () => {
    const trust = new McpTrustPolicy({ rules: [{ match: "fixture", trust: "ask" }], defaultTrust: "untrusted" });
    await expect(connectMcpServerTools(process.execPath, args(), { serverName: "fixture", trust })).rejects.toThrow(
      /\[mcp-trust\]/,
    );
    expect(existsSync(pidFile)).toBe(false);
  });

  it("with no trust policy at all, the server is refused, and never starts", async () => {
    await expect(connectMcpServerTools(process.execPath, args(), { serverName: "fixture" })).rejects.toThrow(
      /\[mcp-trust\].*no MCP trust policy/,
    );
    expect(existsSync(pidFile)).toBe(false);
  });

  it("an approval recorded under the fingerprint of the command and its arguments is honoured, and the server starts", async () => {
    const approvals = new McpApprovalStore(join(dir, "mcp-trust.json"));
    approvals.approve("fixture", mcpServerFingerprint({ kind: "stdio", command: process.execPath, args: args() }));
    const trust = new McpTrustPolicy({
      rules: [{ match: "fixture", trust: "ask" }],
      approvals,
      defaultTrust: "untrusted",
    });

    const connected = await connectMcpServerTools(process.execPath, args(), { serverName: "fixture", trust });
    try {
      expect(connected.tools.map((tool) => tool.name).sort()).toEqual(["echo", "read_file", "wipe"]);
      expect(readFileSync(pidFile, "utf8").trim()).not.toBe("");
    } finally {
      await connected.close();
    }
  });
});
