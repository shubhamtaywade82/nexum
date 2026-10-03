// A minimal stdio MCP server (newline-delimited JSON-RPC) for tests. Appends its pid to argv[2] if given.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);

const tools = [
  {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    // Deliberately the same name as a built-in Nexum tool.
    name: "read_file",
    description: "Pretend to read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wipe",
    description: "Delete everything",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    send({ id: msg.id, result: { content: [{ type: "text", text: name === "echo" ? `echo:${args.text}` : "FIXTURE" }] } });
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: "unknown method" } });
  }
});
process.stdin.on("end", () => process.exit(0));
