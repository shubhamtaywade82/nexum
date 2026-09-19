/**
 * Nexum Local Host — the first network transport for the Nexum runtime
 * (docs/plan: "Phase 1 — Nexum Host"). Binds to localhost and exposes the
 * Session/Run/Event API (src/protocol/types.ts) over plain HTTP + SSE, on
 * top of the existing in-process Agent (src/cli/agent.ts).
 *
 * Deliberately no framework dependency (express/fastify/etc.) — this is a
 * handful of routes over node:http, and the project has no HTTP framework
 * in its dependency graph yet. Revisit if/when the route surface grows
 * past what raw http comfortably handles.
 *
 * Concurrency model: one Agent instance backs the whole host process (see
 * AGENTS.md — the TUI/CLI already assume a single active conversation).
 * "Sessions" are Agent's own persisted transcripts (SessionStore); starting
 * a run against a different session swaps which transcript is loaded. Only
 * one run may be in flight at a time — a second POST /sessions/:id/runs
 * while one is running gets 409 Conflict. This is an accepted limitation
 * of the first vertical slice, not a design goal.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Agent } from "../cli/agent.js";
import { RunEventBridge } from "./event-bridge.js";
import { CreateRunRequestSchema, PROTOCOL_VERSION, type NexumRunEvent } from "../protocol/types.js";

export interface NexumHostOptions {
  agent: Agent;
  host?: string;
  port?: number;
}

export interface NexumHost {
  readonly server: Server;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB — chat goals/history, not file uploads

export function createNexumHost(opts: NexumHostOptions): NexumHost {
  const { agent } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3777;
  const bridge = new RunEventBridge(agent);

  const server = createServer((req, res) => {
    handleRequest(req, res, agent, bridge).catch((err) => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal_error", message: describeError(err) });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    start(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve({ host, port });
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Agent,
  bridge: RunEventBridge,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && segments.length === 0) {
    writeJson(res, 200, { name: "nexum-host", protocolVersion: PROTOCOL_VERSION });
    return;
  }

  if (method === "GET" && segments[0] === "health") {
    writeJson(res, 200, { status: "ok", ts: Date.now() });
    return;
  }

  if (method === "GET" && segments[0] === "capabilities") {
    writeJson(res, 200, {
      agents: agent.runtime.agents.ids(),
      strategies: agent.runtime.strategies.names(),
      protocolVersion: PROTOCOL_VERSION,
    });
    return;
  }

  if (segments[0] === "sessions") {
    // POST /sessions — start a fresh session
    if (method === "POST" && segments.length === 1) {
      agent.resetContext();
      writeJson(res, 201, { id: agent.sessions.sessionId });
      return;
    }

    // GET /sessions — list known sessions
    if (method === "GET" && segments.length === 1) {
      writeJson(res, 200, { sessions: agent.listSessions() });
      return;
    }

    const sessionId = segments[1];

    // GET /sessions/:id — load a session's transcript
    if (method === "GET" && segments.length === 2 && sessionId) {
      const messages = agent.resumeSessionById(sessionId);
      if (!messages) {
        writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
        return;
      }
      writeJson(res, 200, { id: sessionId, messages });
      return;
    }

    // POST /sessions/:id/runs — start a run and stream its events
    if (method === "POST" && segments.length === 3 && segments[2] === "runs" && sessionId) {
      await handleCreateRun(req, res, agent, bridge, sessionId);
      return;
    }
  }

  // POST /runs/:runId/cancel — best-effort cancel of whatever run is active
  if (method === "POST" && segments[0] === "runs" && segments.length === 3 && segments[2] === "cancel") {
    const cancelled = agent.cancelExecutionRun();
    writeJson(res, 200, { cancelled });
    return;
  }

  writeJson(res, 404, { error: "not_found", message: `no route for ${method} ${url.pathname}` });
}

async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Agent,
  bridge: RunEventBridge,
  sessionId: string,
): Promise<void> {
  if (bridge.isBusy) {
    writeJson(res, 409, { error: "run_in_progress", message: "another run is already active on this host" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, { error: "invalid_body", message: describeError(err) });
    return;
  }

  const parsed = CreateRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: "invalid_request", message: parsed.error.message });
    return;
  }

  // Switch the active session if the caller asked for one that isn't already loaded.
  // Callers must POST /sessions first — there is no implicit "current session" sentinel.
  if (sessionId !== agent.sessions.sessionId && !agent.resumeSessionById(sessionId)) {
    writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
    return;
  }

  const runId = agent.startExecutionRun();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (event: NexumRunEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  bridge.begin({ runId, write });
  write({ type: "run.started", runId, sessionId: agent.sessions.sessionId, goal: parsed.data.goal, ts: Date.now() });

  const onClientDisconnect = (): void => {
    agent.cancelExecutionRun();
  };
  req.on("close", onClientDisconnect);

  try {
    const output = await agent.runUserMessage(parsed.data.goal);
    bridge.flushThinking();
    write({ type: "run.completed", runId, output, ts: Date.now() });
  } catch (err) {
    bridge.flushThinking();
    write({ type: "run.failed", runId, error: describeError(err), ts: Date.now() });
  } finally {
    req.removeListener("close", onClientDisconnect);
    bridge.end();
    agent.endExecutionRun();
    res.end();
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
