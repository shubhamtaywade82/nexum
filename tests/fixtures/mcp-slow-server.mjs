// A stdio MCP server with one slow tool, for cancellation tests. `slow` answers after 20 s unless the client cancels it.
// A cancellation writes "cancelled" to the file given as argv[2], so a test can see that the server was told.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const markerFile = process.argv[2];
const tools = [{ name: "slow", description: "Waits for 20 seconds unless cancelled", inputSchema: { type: "object", properties: {} } }];
const pending = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "slow", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const timer = setTimeout(() => {
      pending.delete(msg.id);
      send({ id: msg.id, result: { content: [{ type: "text", text: "finished" }] } });
    }, 20_000);
    pending.set(msg.id, timer);
  } else if (msg.method === "notifications/cancelled") {
    const timer = pending.get(msg.params?.requestId);
    if (timer) {
      clearTimeout(timer);
      pending.delete(msg.params.requestId);
      if (markerFile) writeFileSync(markerFile, "cancelled");
    }
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: "unknown method" } });
  }
});
process.stdin.on("end", () => process.exit(0));
