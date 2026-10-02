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
import type { RunEventBridge } from "./event-bridge.js";
import {
  CreateRunRequestSchema,
  ResolveInteractionRequestSchema,
  type ResolveInteractionRequest,
  PROTOCOL_VERSION,
  type NexumRunEvent,
  type NexumCapabilities,
} from "../protocol/types.js";
import { defaultStrategyRegistry, devAgentDescriptor } from "../runtime/agent/agent-runtime.js";
import { sql } from "drizzle-orm";
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
  token?: string;
}

export interface NexumHost {
  readonly server: Server;
  start(): Promise<{ host: string; port: number }>;
  stop(graceMs?: number): Promise<void>;
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

interface RequestContext {
  registry: HostAgentRegistry;
  repos: Repos;
  db: Database;
  eventBus: RedisEventBus;
  workspaceRoot: string;
  runOwners: Map<string, string>;
  activeRuns: Set<Promise<void>>;
  busySessions: Set<string>;
  idempotencyCache: Map<string, { status: number; body: unknown; ts: number }>;
  isLoopbackHost: boolean;
  token?: string;
}

export function createNexumHost(opts: NexumHostOptions): NexumHost {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3777;
  const token = opts.token ?? process.env.NEXUM_SERVER_TOKEN;
  const isLoopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";

  const repos: Repos = {
    sessions: new SessionRepository(opts.db),
    messages: new MessageRepository(opts.db),
    runs: new RunRepository(opts.db),
    events: new EventRepository(opts.db),
  };
  const registry = new HostAgentRegistry({
    createAgent: opts.createAgent,
    messages: repos.messages,
  });
  const runOwners = new Map<string, string>();
  const activeRuns = new Set<Promise<void>>();
  const busySessions = new Set<string>();
  const idempotencyCache = new Map<string, { status: number; body: unknown; ts: number }>();

  const ctx: RequestContext = {
    registry,
    repos,
    db: opts.db,
    eventBus: opts.eventBus,
    workspaceRoot: opts.workspaceRoot,
    runOwners,
    activeRuns,
    busySessions,
    idempotencyCache,
    isLoopbackHost,
    token,
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal_error", message: describeError(err) });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    async start(): Promise<{ host: string; port: number }> {
      if (!isLoopbackHost && !token) {
        throw new Error("NEXUM_SERVER_TOKEN must be set when binding to non-loopback address");
      }
      await reconcileOrphanedRuns(repos);
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolve({ host, port: actualPort });
        });
      });
    },
    async stop(graceMs?: number): Promise<void> {
      await closeHttpServer(server);
      await drainActiveRuns(activeRuns, runOwners, registry, graceMs);
      await registry.stopAll();
    },
  };
}

function isAuthorized(req: IncomingMessage, isLoopbackHost: boolean, expectedToken?: string): boolean {
  const urlPath = req.url?.split("?")[0] ?? "";
  if (urlPath === "/health" || urlPath === "/ready") {
    return true;
  }
  if (isLoopbackHost && !expectedToken) {
    return true;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const [scheme, clientToken] = authHeader.split(" ");
  return scheme === "Bearer" && clientToken === expectedToken;
}

function getIdempotencyKey(req: IncomingMessage): string | undefined {
  const header = req.headers["idempotency-key"];
  if (!header) return undefined;
  return Array.isArray(header) ? header[0] : header;
}

async function handleReady(res: ServerResponse, db: Database, eventBus: RedisEventBus): Promise<void> {
  let postgresOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    postgresOk = true;
  } catch {
    postgresOk = false;
  }

  const redisOk = await eventBus.ping();
  const allOk = postgresOk && redisOk;

  writeJson(res, allOk ? 200 : 503, {
    status: allOk ? "ready" : "degraded",
    checks: {
      postgres: postgresOk ? "ok" : "error",
      redis: redisOk ? "ok" : "error",
      runtime: "ok",
    },
  });
}

async function reconcileOrphanedRuns(repos: Repos): Promise<number> {
  const orphaned = await repos.runs.findOrphaned();
  for (const run of orphaned) {
    const ts = Date.now();
    const event: NexumRunEvent = {
      type: "run.interrupted",
      runId: run.id,
      reason: "server_restart",
      ts,
    };
    await repos.events.append(event);
    await repos.runs.updateStatus(run.id, "interrupted", {
      error: "Server restarted during execution",
    });
  }
  return orphaned.length;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function drainActiveRuns(
  activeRuns: Set<Promise<void>>,
  runOwners: Map<string, string>,
  registry: HostAgentRegistry,
  graceMs?: number,
): Promise<void> {
  if (activeRuns.size === 0) return;
  const timeoutMs = graceMs ?? Number(process.env.NEXUM_SHUTDOWN_GRACE_MS ?? "5000");
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const drainPromise = Promise.allSettled([...activeRuns]).then(() => false);
  const timedOut = await Promise.race([drainPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    for (const sessionId of runOwners.values()) {
      registry.peek(sessionId)?.agent.cancelExecutionRun();
    }
    await Promise.allSettled([...activeRuns]);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  if (!isAuthorized(req, ctx.isLoopbackHost, ctx.token)) {
    writeJson(res, 401, { error: "unauthorized", message: "invalid or missing authentication token" });
    return;
  }

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

  if (method === "GET" && segments[0] === "ready") {
    await handleReady(res, ctx.db, ctx.eventBus);
    return;
  }

  if (method === "GET" && segments[0] === "capabilities") {
    writeJson(res, 200, STATIC_CAPABILITIES);
    return;
  }

  if (segments[0] === "sessions") {
    if (method === "POST" && segments.length === 1) {
      const idempotencyKey = getIdempotencyKey(req);
      if (idempotencyKey && ctx.idempotencyCache.has(idempotencyKey)) {
        const cached = ctx.idempotencyCache.get(idempotencyKey)!;
        writeJson(res, cached.status, cached.body);
        return;
      }
      let title: string | undefined;
      try {
        const body = (await readJsonBody(req)) as { title?: string };
        if (body && typeof body.title === "string") title = body.title;
      } catch {}
      const id = randomUUID();
      const row = await ctx.repos.sessions.create(id, ctx.workspaceRoot, title);
      const resBody = { id: row.id, createdAt: row.createdAt };
      if (idempotencyKey) {
        ctx.idempotencyCache.set(idempotencyKey, { status: 201, body: resBody, ts: Date.now() });
      }
      writeJson(res, 201, resBody);
      return;
    }

    if (method === "GET" && segments.length === 1) {
      const rows = await ctx.repos.sessions.list();
      writeJson(res, 200, { sessions: rows });
      return;
    }

    const sessionId = segments[1];

    if (method === "GET" && segments.length === 2 && sessionId) {
      const row = await ctx.repos.sessions.get(sessionId);
      if (!row) {
        writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
        return;
      }
      const messages = await ctx.repos.messages.listBySession(sessionId);
      writeJson(res, 200, { session: row, messages });
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[2] === "runs" && sessionId) {
      await handleCreateRun(req, res, sessionId, ctx);
      return;
    }
  }

  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = segments[1];

    if (method === "GET" && segments.length === 2 && runId) {
      const run = await ctx.repos.runs.get(runId);
      if (!run) {
        writeJson(res, 404, { error: "not_found", message: `no run "${runId}"` });
        return;
      }
      writeJson(res, 200, {
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
        goal: run.goal,
        startedAt: run.startedAt.getTime(),
        finishedAt: run.finishedAt ? run.finishedAt.getTime() : undefined,
        output: run.output ?? undefined,
        error: run.error ?? undefined,
      });
      return;
    }

    if (method === "GET" && segments.length === 3 && segments[2] === "events" && runId) {
      await handleRunEvents(req, res, runId, { repos: ctx.repos, eventBus: ctx.eventBus, url });
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[2] === "cancel" && runId) {
      const sessionId = ctx.runOwners.get(runId);
      const entry = sessionId ? ctx.registry.peek(sessionId) : null;
      const cancelled = entry ? entry.agent.cancelExecutionRun() : false;
      writeJson(res, 200, { cancelled });
      return;
    }

    if (
      method === "POST" &&
      segments.length === 5 &&
      segments[2] === "interactions" &&
      segments[4] === "resolve" &&
      runId
    ) {
      const interactionId = segments[3];
      if (interactionId) {
        await handleResolveInteraction(req, res, {
          repos: ctx.repos,
          eventBus: ctx.eventBus,
          runId,
          interactionId,
        });
        return;
      }
    }
  }

  writeJson(res, 404, { error: "not_found", message: `no route for ${method} ${url.pathname}` });
}

function buildInteractionResolvedEvent(
  runId: string,
  interactionId: string,
  data: ResolveInteractionRequest,
): NexumRunEvent {
  const ts = Date.now();
  if (data.selectedId !== undefined) {
    return { type: "run.clarification.resolved", runId, interactionId, selectedId: data.selectedId, ts };
  }
  if (data.response !== undefined) {
    return { type: "run.mcp_elicitation.resolved", runId, interactionId, response: data.response, ts };
  }
  return { type: "run.approval.resolved", runId, interactionId, approved: data.approved ?? true, ts };
}

async function handleResolveInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { repos: Repos; eventBus: RedisEventBus; runId: string; interactionId: string },
): Promise<void> {
  const run = await ctx.repos.runs.get(ctx.runId);
  if (!run) {
    writeJson(res, 404, { error: "not_found", message: `no run "${ctx.runId}"` });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, { error: "invalid_body", message: describeError(err) });
    return;
  }

  const parsed = ResolveInteractionRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: "invalid_request", message: parsed.error.message });
    return;
  }

  const event = buildInteractionResolvedEvent(ctx.runId, ctx.interactionId, parsed.data);
  const seq = await ctx.repos.events.append(event);
  await ctx.eventBus.publish(runChannel(ctx.runId), { seq, ...event });

  writeJson(res, 200, { resolved: true, interactionId: ctx.interactionId });
}

async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  ctx: { repos: Repos; eventBus: RedisEventBus; url: URL },
): Promise<void> {
  const accept = req.headers.accept ?? "";
  const isSse = accept.includes("text/event-stream") || ctx.url.searchParams.has("stream");

  if (!isSse) {
    const rows = await ctx.repos.events.listByRun(runId);
    writeJson(res, 200, { runId, events: rows.map((r) => r.event) });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const lastEventId = req.headers["last-event-id"];
  const afterParam = ctx.url.searchParams.get("after");
  const afterSeq = Number((Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? afterParam ?? "0") || 0;
  let highestSeq = afterSeq;
  let replaying = true;
  const liveBuffer: Array<{ seq: number; event: NexumRunEvent }> = [];
  let unsubscribed = false;

  const channel = runChannel(runId);

  const deliver = (seq: number, event: NexumRunEvent): void => {
    if (seq > 0 && seq <= highestSeq) return; // deduplicate
    if (seq > 0) highestSeq = seq;

    res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ seq, ...event })}\n\n`);

    if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) {
      unsubscribed = true;
      void unsubscribe().then(() => res.end());
    }
  };

  // 1. Subscribe to Redis live stream FIRST so no live event is dropped during Postgres query
  const unsubscribe = await ctx.eventBus.subscribe<{ seq?: number } & NexumRunEvent>(channel, (event) => {
    const seq = event.seq ?? 0;
    if (replaying) {
      liveBuffer.push({ seq, event });
    } else {
      deliver(seq, event);
    }
  });

  // 2. Replay durable history from PostgreSQL
  const pastEvents = await ctx.repos.events.listByRun(runId, afterSeq);
  for (const item of pastEvents) {
    highestSeq = Math.max(highestSeq, item.seq);
    const payload = { seq: item.seq, ...item.event };
    res.write(`id: ${item.seq}\nevent: ${item.event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  // 3. Flush buffered events with deduplication
  replaying = false;
  for (const buffered of liveBuffer) {
    deliver(buffered.seq, buffered.event);
  }

  // 4. Check if run is already finished in DB
  const runRow = await ctx.repos.runs.get(runId);
  const isFinished = runRow && ["completed", "failed", "cancelled", "interrupted"].includes(runRow.status);
  if (isFinished && !unsubscribed) {
    unsubscribed = true;
    await unsubscribe();
    res.end();
  }

  req.on("close", () => {
    if (!unsubscribed) void unsubscribe();
  });
}

async function parseCreateRunGoal(req: IncomingMessage): Promise<{ goal?: string; error?: string }> {
  try {
    const body = await readJsonBody(req);
    const parsed = CreateRunRequestSchema.safeParse(body);
    if (!parsed.success) return { error: parsed.error.message };
    return { goal: parsed.data.goal };
  } catch (err) {
    return { error: describeError(err) };
  }
}

async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  ctx: RequestContext,
): Promise<void> {
  const idempotencyKey = getIdempotencyKey(req);
  if (idempotencyKey && ctx.idempotencyCache.has(idempotencyKey)) {
    const cached = ctx.idempotencyCache.get(idempotencyKey)!;
    writeJson(res, cached.status, cached.body);
    return;
  }

  const sessionRow = await ctx.repos.sessions.get(sessionId);
  if (!sessionRow) {
    writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
    return;
  }

  const parsed = await parseCreateRunGoal(req);
  if (parsed.error || !parsed.goal) {
    writeJson(res, 400, { error: "invalid_request", message: parsed.error });
    return;
  }

  const { agent, bridge }: AgentEntry = await ctx.registry.getOrCreate(sessionId);
  if (bridge.isBusy || ctx.busySessions.has(sessionId)) {
    writeJson(res, 409, { error: "run_in_progress", message: `session "${sessionId}" already has a run in progress` });
    return;
  }

  ctx.busySessions.add(sessionId);
  const runId = agent.startExecutionRun();
  ctx.runOwners.set(runId, sessionId);
  const runRow = await ctx.repos.runs.create(runId, sessionId, parsed.goal, "running");

  const resBody = {
    run: {
      id: runRow.id,
      sessionId: runRow.sessionId,
      status: runRow.status,
      goal: runRow.goal,
      createdAt: runRow.startedAt.getTime(),
    },
  };

  if (idempotencyKey) {
    ctx.idempotencyCache.set(idempotencyKey, { status: 201, body: resBody, ts: Date.now() });
  }

  writeJson(res, 201, resBody);

  const runPromise = runAgentInBackground(agent, bridge, parsed.goal, {
    repos: ctx.repos,
    eventBus: ctx.eventBus,
    sessionId,
    runId,
    runOwners: ctx.runOwners,
    busySessions: ctx.busySessions,
  });
  ctx.activeRuns.add(runPromise);
  void runPromise.finally(() => {
    ctx.activeRuns.delete(runPromise);
  });
}

async function runAgentInBackground(
  agent: Agent,
  bridge: RunEventBridge,
  goal: string,
  ctx: {
    repos: Repos;
    eventBus: RedisEventBus;
    sessionId: string;
    runId: string;
    runOwners: Map<string, string>;
    busySessions: Set<string>;
  },
): Promise<void> {
  const channel = runChannel(ctx.runId);
  let publishChain: Promise<void> = Promise.resolve();

  const publish = (event: NexumRunEvent): void => {
    publishChain = publishChain
      .then(async () => {
        const seq = await ctx.repos.events.append(event);
        await ctx.eventBus.publish(channel, { seq, ...event });
      })
      .catch((err) => {
        process.stderr.write(
          `[nexum host] failed to persist/publish ${event.type} for ${ctx.runId}: ${describeError(err)}\n`,
        );
      });
  };

  bridge.begin({ runId: ctx.runId, write: publish });
  publish({ type: "run.started", runId: ctx.runId, sessionId: ctx.sessionId, goal, ts: Date.now() });

  const messageCountBefore = agent.conversation.getMessages().length;

  try {
    const output = await agent.runUserMessage(goal);
    bridge.flushThinking();
    publish({ type: "run.completed", runId: ctx.runId, output, ts: Date.now() });
    await publishChain;
    await ctx.repos.runs.complete(ctx.runId, "completed", { output });
  } catch (err) {
    bridge.flushThinking();
    const cancelled = agent.execution.signal?.aborted ?? false;
    const message = describeError(err);
    publish(
      cancelled
        ? { type: "run.cancelled", runId: ctx.runId, ts: Date.now() }
        : { type: "run.failed", runId: ctx.runId, error: message, ts: Date.now() },
    );
    await publishChain;
    await ctx.repos.runs.complete(ctx.runId, cancelled ? "cancelled" : "failed", { error: message });
  } finally {
    bridge.end();
    agent.endExecutionRun();
    ctx.runOwners.delete(ctx.runId);
    ctx.busySessions.delete(ctx.sessionId);

    const allMessages = agent.conversation.getMessages();
    const newMessages = allMessages.slice(messageCountBefore);
    if (newMessages.length > 0) {
      await ctx.repos.messages
        .append(
          ctx.sessionId,
          newMessages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          })),
        )
        .catch((err) =>
          process.stderr.write(`[nexum host] failed to persist messages for ${ctx.sessionId}: ${describeError(err)}\n`),
        );
    }
    await ctx.repos.sessions.touch(ctx.sessionId, allMessages.length).catch(() => {});
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
