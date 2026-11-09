#!/usr/bin/env node
import { startStdioServer, startHttpServer } from "./server.js";

function parsePortArg(): number | null {
  const httpIndex = process.argv.findIndex((arg) => arg === "--http" || arg === "-p");
  if (httpIndex === -1) return null;
  const portVal = Number(process.argv[httpIndex + 1]);
  return !Number.isNaN(portVal) && portVal > 0 ? portVal : 3000;
}

const httpPort = parsePortArg();
if (httpPort !== null) {
  startHttpServer(httpPort).then(() => {
    process.stderr.write(`[binance-public-mcp] HTTP server listening on port ${httpPort}\n`);
  });
} else {
  startStdioServer();
}
