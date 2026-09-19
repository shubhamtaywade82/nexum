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
 * PostgreSQL is the durable source of truth for sessions/runs/events;
 * Redis is the live fan-out layer (docs/plan §1: "Redis should never
 * become the authoritative state store"). A run's SSE response subscribes
 * to Redis rather than reading the event bridge directly, so a future
 * second subscriber (CLI attach to a Web-started run) can join the same
 * channel without touching this handler.
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
import type { Database } from "../persistence/database.js";
import { SessionRepository } from "../persistence/repositories/session-repository.js";
import { RunRepository } from "../persistence/repositories/run-repository.js";
import { EventRepository } from "../persistence/repositories/event-repository.js";
import type { RedisEventBus } from "../infrastructure/redis/pubsub.js";
import { runChannel } from "../infrastructure/redis/channels.js";

export interface NexumHostOptions {
  agent: Agent;
  db: Database;
  eventBus: RedisEventBus;
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
  const { agent, db, eventBus } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3777;
  const bridge = new RunEventBridge(agent);
  const repos = {
    sessions: new SessionRepository(db),
    runs: new RunRepository(db),
    events: new EventRepository(db),
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, agent, bridge, repos, eventBus).catch((err) => {
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

interface Repos {
  sessions: SessionRepository;
  runs: RunRepository;
  events: EventRepository;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Agent,
  bridge: RunEventBridge,
  repos: Repos,
  eventBus: RedisEventBus,
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
    // POST /sessions — start a fresh session, durably recorded in Postgres
    if (method === "POST" && segments.length === 1) {
      agent.resetContext();
      const id = agent.sessions.sessionId;
      const row = await repos.sessions.create(id, agent.workspaceRoot);
      writeJson(res, 201, { id: row.id, createdAt: row.createdAt });
      return;
    }

    // GET /sessions — list from Postgres (the durable listing)
    if (method === "GET" && segments.length === 1) {
      const rows = await repos.sessions.list();
      writeJson(res, 200, { sessions: rows });
      return;
    }

    const sessionId = segments[1];

    // GET /sessions/:id — Postgres record + Agent's transcript
    if (method === "GET" && segments.length === 2 && sessionId) {
      const row = await repos.sessions.get(sessionId);
      if (!row) {
        writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
        return;
      }
      const messages = agent.resumeSessionById(sessionId) ?? [];
      writeJson(res, 200, { session: row, messages });
      return;
    }

    // POST /sessions/:id/runs — start a run and stream its events
    if (method === "POST" && segments.length === 3 && segments[2] === "runs" && sessionId) {
      await handleCreateRun(req, res, agent, bridge, repos, eventBus, sessionId);
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
  repos: Repos,
  eventBus: RedisEventBus,
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

  // The session must already exist in Postgres — callers POST /sessions first.
  const sessionRow = await repos.sessions.get(sessionId);
  if (!sessionRow) {
    writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
    return;
  }

  // Switch the active session if the caller asked for one that isn't already loaded.
  if (sessionId !== agent.sessions.sessionId && !agent.resumeSessionById(sessionId)) {
    // A session can exist in Postgres before Agent's own SessionStore has
    // ever saved a transcript for it (freshly created, zero turns so far).
    // That's fine only when it's still the currently-loaded session.
    if (sessionId !== agent.sessions.sessionId) {
      writeJson(res, 404, { error: "not_found", message: `session "${sessionId}" has no transcript yet on this host` });
      return;
    }
  }

  const runId = agent.startExecutionRun();
  await repos.runs.create(runId, sessionId, parsed.data.goal);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const channel = runChannel(runId);

  // Subscribe BEFORE publishing anything so the very first event (run.started)
  // is never dropped — ioredis's SUBSCRIBE ack guarantees delivery ordering
  // for messages published on this same connection after the await resolves.
  const unsubscribe = await eventBus.subscribe<NexumRunEvent>(channel, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Durability (Postgres) + live fan-out (Redis) both happen off the
  // response-write path, and are sequenced so out-of-order persistence
  // can never reorder what a subscriber sees, even though each publish is
  // itself async (two round trips: insert, then PUBLISH).
  let publishChain: Promise<void> = Promise.resolve();
  const publish = (event: NexumRunEvent): void => {
    publishChain = publishChain
      .then(() => repos.events.append(event))
      .then(() => eventBus.publish(channel, event))
      .catch((err) => {
        process.stderr.write(`[nexum host] failed to persist/publish ${event.type} for ${runId}: ${describeError(err)}\n`);
      });
  };

  bridge.begin({ runId, write: publish });
  publish({ type: "run.started", runId, sessionId, goal: parsed.data.goal, ts: Date.now() });

  const onClientDisconnect = (): void => {
    agent.cancelExecutionRun();
  };
  req.on("close", onClientDisconnect);

  try {
    const output = await agent.runUserMessage(parsed.data.goal);
    bridge.flushThinking();
    publish({ type: "run.completed", runId, output, ts: Date.now() });
    await publishChain;
    await repos.runs.complete(runId, "completed", { output });
  } catch (err) {
    bridge.flushThinking();
    const cancelled = agent.execution.signal?.aborted ?? false;
    const message = describeError(err);
    publish(
      cancelled
        ? { type: "run.cancelled", runId, ts: Date.now() }
        : { type: "run.failed", runId, error: message, ts: Date.now() },
    );
    await publishChain;
    await repos.runs.complete(runId, cancelled ? "cancelled" : "failed", { error: message });
  } finally {
    req.removeListener("close", onClientDisconnect);
    bridge.end();
    agent.endExecutionRun();
    await unsubscribe();
    const meta = agent.listSessions().find((s) => s.id === sessionId);
    if (meta) await repos.sessions.touch(sessionId, meta.messageCount);
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
