/**
 * Nexum Local Host — the first network transport for the Nexum runtime
 * (docs/plan: "Phase 1 — Nexum Host"; multi-session support: "Phase 5 —
 * Unified Sessions + Runs"). Binds to localhost and exposes the
 * Session/Run/Event API (src/protocol/types.ts) over plain HTTP + SSE.
 *
 * Deliberately no framework dependency (express/fastify/etc.) — this is a
 * handful of routes over node:http, and the project has no HTTP framework
 * in its dependency graph yet. Revisit if/when the route surface grows
 * past what raw http comfortably handles.
 *
 * PostgreSQL is the durable source of truth for sessions/messages/runs/
 * events; Redis is the live fan-out layer (docs/plan §1: "Redis should
 * never become the authoritative state store"). A run's SSE response
 * subscribes to Redis rather than reading the event bridge directly, so a
 * second subscriber (CLI attach to a Web-started run) can join the same
 * channel without touching this handler; GET /runs/:id/events replays the
 * durable Postgres history for a subscriber that missed the live stream
 * (a dropped connection, or a client attaching after the run finished).
 *
 * Concurrency model: a HostAgentRegistry (src/host/agent-registry.ts) owns
 * one Agent per session, constructed lazily and evicted when idle — each
 * session still serializes its own runs (one ReAct loop per session at a
 * time, matching a single conversation's turn-taking), but independent
 * sessions run concurrently. A run against a session already mid-run gets
 * 409 Conflict.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Agent } from "../cli/agent.js";
import { HostAgentRegistry, type AgentEntry } from "./agent-registry.js";
import {
  CreateRunRequestSchema,
  PROTOCOL_VERSION,
  type NexumRunEvent,
  type NexumCapabilities,
} from "../protocol/types.js";
import { defaultStrategyRegistry, devAgentDescriptor } from "../runtime/agent/agent-runtime.js";
import type { Database } from "../persistence/database.js";
import { SessionRepository } from "../persistence/repositories/session-repository.js";
import { MessageRepository } from "../persistence/repositories/message-repository.js";
import { RunRepository } from "../persistence/repositories/run-repository.js";
import { EventRepository } from "../persistence/repositories/event-repository.js";
import type { RedisEventBus } from "../infrastructure/redis/pubsub.js";
import { runChannel } from "../infrastructure/redis/channels.js";

export interface NexumHostOptions {
  createAgent: () => Agent;
  workspaceRoot: string;
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

// Static across every session — every Agent in the registry is built from
// the same host-wide config, so this doesn't need a live Agent instance.
const STATIC_CAPABILITIES: NexumCapabilities = {
  agents: [devAgentDescriptor().id],
  strategies: defaultStrategyRegistry().names(),
  protocolVersion: PROTOCOL_VERSION,
};

interface Repos {
  sessions: SessionRepository;
  messages: MessageRepository;
  runs: RunRepository;
  events: EventRepository;
}

export function createNexumHost(opts: NexumHostOptions): NexumHost {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3777;
  const registry = new HostAgentRegistry({ createAgent: opts.createAgent });
  const repos: Repos = {
    sessions: new SessionRepository(opts.db),
    messages: new MessageRepository(opts.db),
    runs: new RunRepository(opts.db),
    events: new EventRepository(opts.db),
  };
  // runId -> sessionId, so /runs/:id/cancel can find the right Agent
  // without every route needing to know a run's session up front.
  const runOwners = new Map<string, string>();

  const server = createServer((req, res) => {
    handleRequest(req, res, registry, repos, opts.eventBus, opts.workspaceRoot, runOwners).catch((err) => {
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
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await registry.stopAll();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: HostAgentRegistry,
  repos: Repos,
  eventBus: RedisEventBus,
  workspaceRoot: string,
  runOwners: Map<string, string>,
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
    writeJson(res, 200, STATIC_CAPABILITIES);
    return;
  }

  if (segments[0] === "sessions") {
    // POST /sessions — mint a new session id, durably recorded in Postgres.
    // The Agent itself is constructed lazily on first run (HostAgentRegistry) —
    // creating a session shouldn't pay for LSP/browser/plugin-host startup.
    if (method === "POST" && segments.length === 1) {
      const id = randomUUID();
      const row = await repos.sessions.create(id, workspaceRoot);
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

    // GET /sessions/:id — Postgres record + durable message history
    if (method === "GET" && segments.length === 2 && sessionId) {
      const row = await repos.sessions.get(sessionId);
      if (!row) {
        writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
        return;
      }
      const messages = await repos.messages.listBySession(sessionId);
      writeJson(res, 200, { session: row, messages });
      return;
    }

    // POST /sessions/:id/runs — start a run and stream its events
    if (method === "POST" && segments.length === 3 && segments[2] === "runs" && sessionId) {
      await handleCreateRun(req, res, registry, repos, eventBus, sessionId, runOwners);
      return;
    }
  }

  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = segments[1];

    // GET /runs/:id/events — durable replay (reconnect, or attach after the run finished)
    if (method === "GET" && segments.length === 3 && segments[2] === "events") {
      const events = await repos.events.listByRun(runId);
      writeJson(res, 200, { runId, events });
      return;
    }

    // POST /runs/:id/cancel — cancel this specific run's session, if it's still active
    if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
      const sessionId = runOwners.get(runId);
      const entry = sessionId ? registry.peek(sessionId) : null;
      const cancelled = entry ? entry.agent.cancelExecutionRun() : false;
      writeJson(res, 200, { cancelled });
      return;
    }
  }

  writeJson(res, 404, { error: "not_found", message: `no route for ${method} ${url.pathname}` });
}

async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  registry: HostAgentRegistry,
  repos: Repos,
  eventBus: RedisEventBus,
  sessionId: string,
  runOwners: Map<string, string>,
): Promise<void> {
  const sessionRow = await repos.sessions.get(sessionId);
  if (!sessionRow) {
    writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
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

  const { agent, bridge }: AgentEntry = await registry.getOrCreate(sessionId);

  if (bridge.isBusy) {
    writeJson(res, 409, { error: "run_in_progress", message: `session "${sessionId}" already has a run in progress` });
    return;
  }

  const runId = agent.startExecutionRun();
  runOwners.set(runId, sessionId);
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
  // itself async (two round trips: insert, then PUBLISH). If the Postgres
  // insert itself fails, the .then chain short-circuits and Redis never
  // sees an event Postgres doesn't have — durable history can never lag
  // behind what a live subscriber saw.
  let publishChain: Promise<void> = Promise.resolve();
  const publish = (event: NexumRunEvent): void => {
    publishChain = publishChain
      .then(() => repos.events.append(event))
      .then(() => eventBus.publish(channel, event))
      .catch((err) => {
        process.stderr.write(
          `[nexum host] failed to persist/publish ${event.type} for ${runId}: ${describeError(err)}\n`,
        );
      });
  };

  bridge.begin({ runId, write: publish });
  publish({ type: "run.started", runId, sessionId, goal: parsed.data.goal, ts: Date.now() });

  const onClientDisconnect = (): void => {
    agent.cancelExecutionRun();
  };
  req.on("close", onClientDisconnect);

  const messageCountBefore = agent.conversation.getMessages().length;

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
    runOwners.delete(runId);
    await unsubscribe();

    // Durable message history: append only what's new since before this
    // run (Agent's in-memory conversation already carries prior turns).
    const allMessages = agent.conversation.getMessages();
    const newMessages = allMessages.slice(messageCountBefore);
    if (newMessages.length > 0) {
      await repos.messages
        .append(
          sessionId,
          newMessages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          })),
        )
        .catch((err) =>
          process.stderr.write(`[nexum host] failed to persist messages for ${sessionId}: ${describeError(err)}\n`),
        );
    }
    await repos.sessions.touch(sessionId, allMessages.length).catch(() => {});

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
