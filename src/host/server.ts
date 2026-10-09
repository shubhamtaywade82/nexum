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
import type { Agent } from "../cli/agent.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { DISCOVERY_SESSION_ID, HostAgentRegistry } from "./agent-registry.js";
import { describeError, readJsonBody, writeJson } from "./http.js";
import { cancelRun, startRun, type Repos } from "./run-starter.js";
import { writeOpenAiError } from "./openai/errors.js";
import { handleOpenAiRequest } from "./openai/index.js";
import { SUPPORTED_PRESENTATIONS, OPENUI_SCHEMA_VERSION, isPresentationSupported } from "./presentation.js";
import { invokeUiTool } from "./ui-tools.js";
import { discoverCapabilities, type DiscoveredCapabilities } from "./capabilities.js";
import {
  CreateRunRequestSchema,
  InvokeToolRequestSchema,
  ResolveInteractionRequestSchema,
  PROTOCOL_VERSION,
  type NexumRunEvent,
  type NexumCapabilities,
  type NexumOutputFormat,
  type CreateRunRequest,
  type ErrorCode,
  ErrorCodes,
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
import { prometheusMetrics } from "../observability/process-telemetry.js";

export interface NexumHostOptions {
  createAgent: () => Agent;
  workspaceRoot: string;
  db: Database;
  eventBus: RedisEventBus;
  host?: string;
  port?: number;
  token?: string;
  /** How long an unanswered approval/clarification waits before failing closed. Default 5 min. */
  interactionTimeoutMs?: number;
}

export interface NexumHost {
  readonly server: Server;
  start(): Promise<{ host: string; port: number }>;
  stop(graceMs?: number): Promise<void>;
}

// Static across every session — every Agent in the registry is built from
// the same host-wide config, so this doesn't need a live Agent instance.

const STATIC_CAPABILITIES: Omit<NexumCapabilities, keyof DiscoveredCapabilities> = {
  agents: [devAgentDescriptor().id],
  strategies: defaultStrategyRegistry().names(),
  presentations: SUPPORTED_PRESENTATIONS,
  protocolVersion: PROTOCOL_VERSION,
};

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
    interactionTimeoutMs: opts.interactionTimeoutMs,
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
          // Connect MCP servers in the background so the first request rarely waits on them.
          void registry.getOrCreate(DISCOVERY_SESSION_ID).catch((err) => {
            process.stderr.write(`[nexum host] warm-up failed: ${describeError(err)}\n`);
          });
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
  let postgresOk: boolean;
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
      const entry = registry.peek(sessionId);
      if (entry) cancelRun(entry);
    }
    await Promise.allSettled([...activeRuns]);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (!isAuthorized(req, ctx.isLoopbackHost, ctx.token)) {
    const message = "invalid or missing authentication token";
    if (segments[0] === "v1") writeOpenAiError(res, 401, "authentication_error", message, { code: "invalid_api_key" });
    else writeJson(res, 401, { error: "unauthorized", message });
    return;
  }

  if (segments[0] === "v1") {
    await handleOpenAiRequest(req, res, segments, ctx);
    return;
  }

  if (method === "GET" && segments.length === 0) {
    writeJson(res, 200, { name: "nexum-host", protocolVersion: PROTOCOL_VERSION });
    return;
  }

  if (method === "GET" && segments[0] === "health") {
    writeJson(res, 200, { status: "ok", ts: Date.now() });
    return;
  }

  if (method === "GET" && segments[0] === "metrics") {
    const body = prometheusMetrics();
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (method === "GET" && segments[0] === "ready") {
    await handleReady(res, ctx.db, ctx.eventBus);
    return;
  }

  if (method === "GET" && segments[0] === "capabilities") {
    const { agent } = await ctx.registry.getOrCreate(DISCOVERY_SESSION_ID);
    const capabilities: NexumCapabilities = {
      ...STATIC_CAPABILITIES,
      ...(await discoverCapabilities(agent, { mcp: ctx.registry.mcpServers() })),
    };
    writeJson(res, 200, capabilities);
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
      } catch {
        // Optional session title; ignore parse failure
      }
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

    if (method === "POST" && segments.length === 4 && segments[2] === "tools" && sessionId) {
      await handleInvokeTool(req, res, sessionId, decodeURIComponent(segments[3]), ctx);
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
        output:
          run.output === null
            ? undefined
            : {
                format: (run.outputFormat as NexumOutputFormat) ?? "markdown",
                content: run.output,
                schemaVersion: run.outputFormat === "openui" ? OPENUI_SCHEMA_VERSION : undefined,
              },
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
      const cancelled = entry ? cancelRun(entry) : false;
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
          registry: ctx.registry,
          runOwners: ctx.runOwners,
          runId,
          interactionId,
        });
        return;
      }
    }
  }

  writeJson(res, 404, { error: "not_found", message: `no route for ${method} ${url.pathname}` });
}

async function handleResolveInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    repos: Repos;
    registry: HostAgentRegistry;
    runOwners: Map<string, string>;
    runId: string;
    interactionId: string;
  },
): Promise<void> {
  const run = await ctx.repos.runs.get(ctx.runId);
  if (!run) {
    writeJson(res, 404, { error: ErrorCodes.RUN_NOT_FOUND, message: `no run "${ctx.runId}"` });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, { error: ErrorCodes.INVALID_REQUEST, message: describeError(err) });
    return;
  }
  const parsed = ResolveInteractionRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: ErrorCodes.INVALID_REQUEST, message: parsed.error.message });
    return;
  }

  // Only a run still executing can have a pending interaction; a finished run has none.
  const sessionId = ctx.runOwners.get(ctx.runId);
  const bridge = sessionId ? ctx.registry.peek(sessionId)?.bridge : undefined;
  const outcome = bridge?.resolve(ctx.interactionId, parsed.data);
  if (outcome?.ok) {
    writeJson(res, 200, { resolved: true, interactionId: ctx.interactionId });
    return;
  }
  const failure = outcome ?? { reason: "not_found" as const, message: `no pending interaction "${ctx.interactionId}"` };
  const rejection = INTERACTION_REJECTIONS[failure.reason];
  writeJson(res, rejection.status, { error: rejection.code, message: failure.message });
}

const INTERACTION_REJECTIONS = {
  not_found: { status: 404, code: ErrorCodes.INTERACTION_NOT_FOUND },
  already_resolved: { status: 409, code: ErrorCodes.INTERACTION_ALREADY_RESOLVED },
  invalid: { status: 400, code: ErrorCodes.INVALID_REQUEST },
} as const;

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

async function handleInvokeTool(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  toolName: string,
  ctx: RequestContext,
): Promise<void> {
  if (!(await ctx.repos.sessions.get(sessionId))) {
    writeJson(res, 404, { error: "not_found", message: `no session "${sessionId}"` });
    return;
  }
  let parsed;
  try {
    parsed = InvokeToolRequestSchema.safeParse(await readJsonBody(req));
  } catch (err) {
    writeJson(res, 400, { error: ErrorCodes.INVALID_REQUEST, message: describeError(err) });
    return;
  }
  if (!parsed.success) {
    writeJson(res, 400, { error: ErrorCodes.INVALID_REQUEST, message: parsed.error.message });
    return;
  }

  const { agent } = await ctx.registry.getOrCreate(sessionId);
  const { status, body } = await invokeUiTool(agent.tools.gateway, toolName, parsed.data.args);
  writeJson(res, status, body);
}

async function parseCreateRunRequest(
  req: IncomingMessage,
): Promise<{ request?: CreateRunRequest; error?: string; code?: ErrorCode }> {
  try {
    const body = await readJsonBody(req);
    const parsed = CreateRunRequestSchema.safeParse(body);
    if (!parsed.success) return { error: parsed.error.message, code: ErrorCodes.INVALID_REQUEST };
    if (!isPresentationSupported(parsed.data.presentation)) {
      return {
        error: `presentation schemaVersion "${parsed.data.presentation.openui?.schemaVersion}" is not supported; use "${OPENUI_SCHEMA_VERSION}"`,
        code: ErrorCodes.UNSUPPORTED_PRESENTATION,
      };
    }
    return { request: parsed.data };
  } catch (err) {
    return { error: describeError(err), code: ErrorCodes.INVALID_REQUEST };
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

  const parsed = await parseCreateRunRequest(req);
  if (!parsed.request) {
    writeJson(res, 400, { error: parsed.code, message: parsed.error });
    return;
  }
  const runRequest = parsed.request;
  const started = await startRun(ctx, sessionId, runRequest);
  if (!started.ok) {
    writeJson(res, 409, {
      error: "run_in_progress",
      message: `session "${sessionId}" already has a run in progress`,
      runId: started.activeRunId,
    });
    return;
  }

  const { run: runRow } = started;
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
}
