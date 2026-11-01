// stdio entry point. Configuration comes only from the environment, which nexum fills
// from `mcpServers[].env` (for example `"BROKER_TOKEN": "credential:BROKER_TOKEN"`).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, defineBroker } from "./wrapper.mjs";

const base = process.env.BROKER_BASE_URL;
if (!base) {
  process.stderr.write("BROKER_BASE_URL is required\n");
  process.exit(2);
}

const server = buildMcpServer(defineBroker(base, process.env.BROKER_TOKEN));
await server.connect(new StdioServerTransport());
