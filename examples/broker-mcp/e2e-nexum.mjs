// End-to-end check: nexum's own AgentToolManager connects this server over stdio through the
// real MCP client factory, applies the trust policy, and registers the tools.
// Needs the nexum root built first (`npm ci && npm run build` at the repo root).
// Run: npm run e2e
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentToolManager } from "../../dist/cli/agent-tools.js";
import { McpApprovalStore, McpTrustPolicy, mcpServerFingerprint } from "../../dist/mcp/trust.js";
import { startMockBroker } from "./mock-broker.mjs";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const TOKEN = "e2e-token-must-not-leak";
const SERVER_NAME = "broker-quotes";

const broker = await startMockBroker((hit) => ({ json: { ltp: 101.5, path: hit.url } }));
// A scratch approval store: nothing outside the temp directory is read or written.
const dir = mkdtempSync(join(tmpdir(), "nexum-e2e-"));

try {
  const approvals = new McpApprovalStore(join(dir, "mcp-trust.json"));
  const policy = new McpTrustPolicy({
    rules: [{ match: SERVER_NAME, trust: "ask", tools: { allow: ["get_quote"] }, maxRisk: "low" }],
    approvals,
  });
  const opts = {
    serverName: SERVER_NAME,
    trust: policy,
    env: { BROKER_BASE_URL: broker.url, BROKER_TOKEN: TOKEN },
  };
  const mgr = new AgentToolManager();

  // 1. Without an approval the server must not connect and the broker must see no traffic.
  let refused = false;
  try {
    await mgr.registerMcpServer("node", [SERVER], opts);
  } catch (err) {
    refused = /requires approval/.test(err.message);
  }
  assert.equal(refused, true, "an ask server with no approval must be refused");
  assert.equal(broker.hits.length, 0, "no broker traffic before approval");

  // 2. Pin the current fingerprint (command + args), then connect.
  approvals.approve(SERVER_NAME, mcpServerFingerprint({ kind: "stdio", command: "node", args: [SERVER] }));
  const tools = await mgr.registerMcpServer("node", [SERVER], opts);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get_quote"],
    "only the allowlisted tool may register",
  );

  // 3. A call goes through the MCP client to the broker, with auth, and returns no token.
  const quote = tools.find((tool) => tool.name === "get_quote");
  const result = await quote.call({ securityId: "2885", exchangeSegment: "NSE_EQ" });
  const text = JSON.stringify(result);
  assert.equal(broker.hits.length, 1, "exactly one broker request for one call");
  assert.equal(broker.hits[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!text.includes(TOKEN), "the token must not appear in tool output");

  console.log("e2e ok: refused before approval, registered [get_quote] after, one authenticated call");
} catch (err) {
  console.error("e2e FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await broker.close();
  rmSync(dir, { recursive: true, force: true });
  // The MCP stdio connection is left open by the manager; exit explicitly.
  process.exit(process.exitCode ?? 0);
}
