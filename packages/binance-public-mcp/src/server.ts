import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { FuturesPublicClient } from "./client.js";
import { TOOLS, executeTool } from "./tools.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const SERVER_NAME = "binance-public-mcp";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

export async function handleRpcMessage(
  client: FuturesPublicClient,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const { method, params = {} } = message;

  // JSON-RPC notifications do not expect a response.
  if (message.id === undefined && (method.startsWith("notifications/") || method === "initialized")) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    return handleToolCall(client, id, params);
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

async function handleToolCall(
  client: FuturesPublicClient,
  id: string | number | null,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const name = String(params.name ?? "");
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
    string,
    unknown
  >;

  try {
    const data = await executeTool(client, name, args);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: (err as Error).message }],
      },
    };
  }
}

export function startStdioServer(client: FuturesPublicClient = new FuturesPublicClient()): void {
  const send = (res: JsonRpcResponse) => process.stdout.write(JSON.stringify(res) + "\n");
  const reader = createInterface({ input: process.stdin, terminal: false });

  let inFlight = 0;
  let isStdinEnded = false;

  const maybeExit = () => {
    if (isStdinEnded && inFlight === 0) {
      process.exit(0);
    }
  };

  reader.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    inFlight++;
    try {
      const msg = JSON.parse(trimmed) as JsonRpcRequest;
      const res = await handleRpcMessage(client, msg);
      if (res) send(res);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    } finally {
      inFlight--;
      maybeExit();
    }
  });

  process.stdin.on("end", () => {
    isStdinEnded = true;
    maybeExit();
  });
}

export function startHttpServer(
  port: number,
  client: FuturesPublicClient = new FuturesPublicClient(),
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Only POST is supported" }));
        return;
      }
      const body = await readRequestBody(req);
      try {
        const msg = JSON.parse(body) as JsonRpcRequest;
        const rpcRes = await handleRpcMessage(client, msg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rpcRes ?? {}));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      }
    });

    server.listen(port, () => resolve(server));
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
