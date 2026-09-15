/**
 * RpcServer — newline-delimited JSON-RPC server over stdio.
 *
 * DeepSeek Harness has a formal Host/Client architecture and an SDK
 * JSON-RPC server that allows external clients to drive Harness agents
 * through newline-delimited JSON-RPC over stdio.
 *
 * Nexum currently exposes a TypeScript runtime SDK (library-oriented).
 * This module adds the RPC boundary so that external clients — Chat UI,
 * Web UI, IDE, CI, remote orchestrator, other agents — can all drive a
 * Nexum host process.
 *
 * Protocol:
 *   - Newline-delimited JSON-RPC 2.0 over stdio (stdin/stdout).
 *   - Each request is one JSON object on one line.
 *   - Each response is one JSON object on one line.
 *   - Notifications (no id) get no response.
 *   - Errors use standard JSON-RPC error codes.
 *
 * Methods:
 *   - "agent.execute"     → run an agent on a task, return result
 *   - "agent.cancel"      → cancel a running execution
 *   - "agent.list"        → list registered agents
 *   - "session.create"    → create a new session
 *   - "session.list"      → list sessions
 *   - "session.load"      → load a session's messages
 *   - "tools.list"        → list registered tools
 *   - "tools.invoke"      → invoke a tool directly
 *   - "plugins.list"      → list mounted plugins
 *   - "jobs.submit"       → submit a background job
 *   - "jobs.status"       → get job status
 *   - "skills.list"       → list discovered skills
 *   - "skills.select"     → select skills for a prompt
 *
 * The server is transport-agnostic: it reads from a Readable stream and
 * writes to a Writable stream. This lets it work over stdio, TCP, or any
 * other transport.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

// ── JSON-RPC types ──────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// Standard error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ── Method handler ──────────────────────────────────────────────────────────

export type RpcMethodHandler = (params: unknown, context: RpcContext) => Promise<unknown> | unknown;

export interface RpcContext {
  /** The raw request (for accessing id, etc.). */
  request: JsonRpcRequest;
  /** Send a notification back to the client (no response expected). */
  notify: (method: string, params?: unknown) => void;
  /** The server instance (for accessing registered services). */
  server: RpcServer;
}

// ── RpcServer ───────────────────────────────────────────────────────────────

export interface RpcServerOptions {
  /** Input stream (default: process.stdin). */
  input?: Readable;
  /** Output stream (default: process.stdout). */
  output?: Writable;
  /** Whether to start reading immediately (default: true). */
  autostart?: boolean;
}

export class RpcServer {
  private readonly methods = new Map<string, RpcMethodHandler>();
  private readonly input: Readable;
  private readonly output: Writable;
  private readline?: ReadlineInterface;
  private running = false;

  constructor(opts: RpcServerOptions = {}) {
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    if (opts.autostart ?? true) {
      // Defer start to next tick so constructors can register methods.
      setTimeout(() => this.start(), 0);
    }
  }

  /** Register a method handler. */
  method(name: string, handler: RpcMethodHandler): this {
    if (this.methods.has(name)) {
      throw new Error(`RPC method "${name}" already registered`);
    }
    this.methods.set(name, handler);
    return this;
  }

  /** Unregister a method. */
  removeMethod(name: string): boolean {
    return this.methods.delete(name);
  }

  /** List registered methods. */
  listMethods(): string[] {
    return [...this.methods.keys()].sort();
  }

  /** Check if a method is registered. */
  hasMethod(name: string): boolean {
    return this.methods.has(name);
  }

  /** Start reading from the input stream. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.readline = createInterface({ input: this.input, terminal: false });
    this.readline.on("line", (line) => {
      void this.handleLine(line);
    });
    this.readline.on("close", () => {
      this.running = false;
    });
  }

  /** Stop reading. */
  stop(): void {
    this.readline?.close();
    this.running = false;
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Send a response to a specific request id. */
  respond(id: string | number | null, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  /** Send an error response. */
  error(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  /** Handle a single line of input. */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      this.error(null, PARSE_ERROR, "Parse error");
      return;
    }

    if (!isValidRequest(request)) {
      this.error(null, INVALID_REQUEST, "Invalid Request");
      return;
    }

    // Notification (no id) — no response.
    if (request.id === undefined || request.id === null) {
      try {
        const handler = this.methods.get(request.method);
        if (handler) {
          await handler(request.params, { request, notify: this.notify.bind(this), server: this });
        }
      } catch {
        // best-effort for notifications
      }
      return;
    }

    // Request with id — expect response.
    const handler = this.methods.get(request.method);
    if (!handler) {
      this.error(request.id, METHOD_NOT_FOUND, `Method not found: ${request.method}`);
      return;
    }

    try {
      const result = await handler(request.params, {
        request,
        notify: this.notify.bind(this),
        server: this,
      });
      this.respond(request.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: number })?.code ?? INTERNAL_ERROR;
      this.error(request.id, code, message);
    }
  }

  private send(message: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}

function isValidRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && typeof v.method === "string";
}

// ── Built-in method handlers (optional — server starts empty) ───────────────

/**
 * Register a basic set of methods that expose plugin host state.
 * The embedding application provides the host; these handlers read from it.
 */
export function registerCoreMethods(
  server: RpcServer,
  host: {
    plugins?: { all(): Array<{ manifest: { id: string; name: string; version: string }; state: string }> };
    agents?: { ids(): string[] };
    tools?: { all(): Array<{ id: string; description?: string }> };
    skills?: { list(): Promise<Array<{ id: string; name: string; description: string }>> };
  },
): void {
  if (host.plugins) {
    server.method("plugins.list", () => {
      return host.plugins!.all().map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        state: p.state,
      }));
    });
  }

  if (host.agents) {
    server.method("agent.list", () => {
      return host.agents!.ids();
    });
  }

  if (host.tools) {
    server.method("tools.list", () => {
      return host.tools!.all().map((t) => ({ id: t.id, description: t.description }));
    });
  }

  if (host.skills) {
    server.method("skills.list", async () => {
      return host.skills!.list();
    });
  }
}

// ── Service-exposing method handlers ────────────────────────────────────────

/**
 * Register RPC methods for the JobService. Exposes:
 *   jobs.submit, jobs.status, jobs.output, jobs.cancel, jobs.kill,
 *   jobs.list, jobs.counts
 *
 * All methods accept params matching the JobService's TypeScript API and
 * return JSON-serializable results. Errors are surfaced as JSON-RPC errors
 * with the original message preserved.
 *
 * @param server  the RPC server
 * @param jobs    the JobService instance (from agent.jobs)
 */
export function registerJobMethods(
  server: RpcServer,
  jobs: {
    submit<T = unknown>(spec: {
      description: string;
      run: (signal: AbortSignal) => Promise<T>;
      timeoutMs?: number;
      priority?: string;
      tags?: string[];
      maxOutputLines?: number;
      scope?: { sessionId?: string; runId?: string };
    }): string;
    status(jobId: string):
      | {
          id: string;
          description: string;
          state: string;
          priority: string;
          tags: string[];
          createdAt: string;
          startedAt?: string;
          finishedAt?: string;
          output: string[];
          error?: string;
          result?: unknown;
          scope?: { sessionId?: string; runId?: string };
        }
      | undefined;
    output(jobId: string): string[];
    cancel(jobId: string, reason?: string): Promise<void>;
    kill(jobId: string, reason?: string): Promise<void>;
    list(filter?: {
      state?: string;
      tag?: string;
      sessionId?: string;
      runId?: string;
    }): Array<{ id: string; description: string; state: string; tags: string[] }>;
    counts(): Record<string, number>;
  },
): void {
  // jobs.submit — submit a background job.
  // Note: the `run` function is NOT serializable. RPC clients must pass
  // the job spec as a JSON object; the embedding app translates it to a
  // real JobSpec before calling jobs.submit. For a generic RPC boundary,
  // we accept a "deferred" spec that the host resolves later.
  server.method("jobs.submit", (params) => {
    const p = params as
      | {
          description: string;
          timeoutMs?: number;
          priority?: string;
          tags?: string[];
          scope?: { sessionId?: string; runId?: string };
        }
      | undefined;
    if (!p || typeof p.description !== "string") {
      throw new Error("jobs.submit requires { description: string }");
    }
    // Submit a job that resolves the description (the embedding app should
    // register a custom submit handler if it wants to execute real work).
    const id = jobs.submit({
      description: p.description,
      priority: (p.priority as "critical" | "normal" | "low" | undefined) ?? "normal",
      tags: p.tags,
      timeoutMs: p.timeoutMs,
      scope: p.scope,
      run: async () => ({
        description: p.description,
        status: "completed",
        note: "rpc-submitted job ran a no-op; supply a real run fn on the host",
      }),
    });
    return { id };
  });

  server.method("jobs.status", (params) => {
    const p = params as { id: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("jobs.status requires { id: string }");
    return jobs.status(p.id) ?? null;
  });

  server.method("jobs.output", (params) => {
    const p = params as { id: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("jobs.output requires { id: string }");
    return jobs.output(p.id);
  });

  server.method("jobs.cancel", (params) => {
    const p = params as { id: string; reason?: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("jobs.cancel requires { id: string }");
    return jobs.cancel(p.id, p.reason);
  });

  server.method("jobs.kill", (params) => {
    const p = params as { id: string; reason?: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("jobs.kill requires { id: string }");
    return jobs.kill(p.id, p.reason);
  });

  server.method("jobs.list", (params) => {
    const p = (params as { state?: string; tag?: string; sessionId?: string; runId?: string } | undefined) ?? {};
    return jobs.list({
      state: p.state as never,
      tag: p.tag,
      sessionId: p.sessionId,
      runId: p.runId,
    });
  });

  server.method("jobs.counts", () => {
    return jobs.counts();
  });
}

/**
 * Register RPC methods for the SubagentService. Exposes:
 *   subagents.spawn, subagents.inspect, subagents.list, subagents.cancel,
 *   subagents.send (for continuable subagents)
 *
 * The `send` and `interrupt` operations take a subagentId and return the
 * updated handle state. Spawn requires a `provider` field matching one of
 * the registered SubagentProvider implementations.
 *
 * @param server  the RPC server
 * @param subs    the SubagentService instance (from agent.subagents)
 */
export function registerSubagentMethods(
  server: RpcServer,
  subs: {
    spawn(
      request: {
        provider: string;
        goal: string;
        requiredCapabilities?: string[];
        childAgentId?: string;
        contextHandoff?: string[];
        budgetShare?: number;
        maxToolTurns?: number;
        continuable?: boolean;
        metadata?: Record<string, unknown>;
      },
      parent?: unknown,
    ): Promise<{
      subagentId: string;
      providerRunId: string;
      provider: string;
      continuable: boolean;
      state: string;
      request: unknown;
    }>;
    inspect(
      subagentId: string,
    ): { subagentId: string; provider: string; state: string; continuable: boolean; request: unknown } | undefined;
    list(state?: string): Array<{ subagentId: string; provider: string; state: string; continuable: boolean }>;
    cancel(subagentId: string, reason?: string): Promise<void>;
  },
): void {
  server.method("subagents.spawn", async (params) => {
    const p = params as
      | {
          provider?: string;
          goal?: string;
          requiredCapabilities?: string[];
          childAgentId?: string;
          contextHandoff?: string[];
          budgetShare?: number;
          maxToolTurns?: number;
          continuable?: boolean;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    if (!p || typeof p.goal !== "string" || typeof p.provider !== "string") {
      throw new Error("subagents.spawn requires { provider: string; goal: string }");
    }
    const handle = await subs.spawn({
      provider: p.provider as never,
      goal: p.goal,
      requiredCapabilities: p.requiredCapabilities,
      childAgentId: p.childAgentId,
      contextHandoff: p.contextHandoff,
      budgetShare: p.budgetShare,
      maxToolTurns: p.maxToolTurns,
      continuable: p.continuable,
      metadata: p.metadata,
    });
    return {
      subagentId: handle.subagentId,
      providerRunId: handle.providerRunId,
      provider: handle.provider,
      continuable: handle.continuable,
      state: handle.state,
    };
  });

  server.method("subagents.inspect", (params) => {
    const p = params as { id: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("subagents.inspect requires { id: string }");
    return subs.inspect(p.id) ?? null;
  });

  server.method("subagents.list", (params) => {
    const p = (params as { state?: string } | undefined) ?? {};
    return subs.list(p.state as never);
  });

  server.method("subagents.cancel", (params) => {
    const p = params as { id: string; reason?: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("subagents.cancel requires { id: string }");
    return subs.cancel(p.id, p.reason);
  });
}

/**
 * Register RPC methods for the WorkflowService. Exposes:
 *   workflows.register, workflows.createInstance, workflows.start,
 *   workflows.pause, workflows.cancel, workflows.resume, workflows.get,
 *   workflows.list, workflows.events
 */
export function registerWorkflowMethods(
  server: RpcServer,
  wfs: {
    register(definition: unknown): unknown;
    createInstance(
      workflowId: string,
      trigger?: unknown,
    ): {
      id: string;
      workflowId: string;
      status: string;
      stepStates: Record<string, unknown>;
      stepOutputs: Record<string, unknown>;
      state: Record<string, unknown>;
      createdAt: string;
    };
    start(
      instanceId: string,
    ): Promise<{ id: string; workflowId: string; status: string; error?: string; finishedAt?: string }>;
    pause(instanceId: string): Promise<void>;
    cancel(instanceId: string, reason?: string): Promise<void>;
    resume(instanceId: string): Promise<unknown>;
    getInstance(instanceId: string): unknown;
    listInstances(filter?: {
      workflowId?: string;
      status?: string;
    }): Array<{ id: string; workflowId: string; status: string; createdAt: string }>;
    eventsFor(instanceId: string): Array<unknown>;
  },
): void {
  server.method("workflows.register", (params) => {
    const p = params as
      { definition?: { id?: string; name?: string; version?: string; steps?: unknown[] } } | undefined;
    if (!p || !p.definition) throw new Error("workflows.register requires { definition }");
    return wfs.register(p.definition);
  });

  server.method("workflows.createInstance", (params) => {
    const p = params as { workflowId?: string; trigger?: unknown } | undefined;
    if (!p || typeof p.workflowId !== "string")
      throw new Error("workflows.createInstance requires { workflowId: string }");
    return wfs.createInstance(p.workflowId, p.trigger);
  });

  server.method("workflows.start", (params) => {
    const p = params as { instanceId?: string } | undefined;
    if (!p || typeof p.instanceId !== "string") throw new Error("workflows.start requires { instanceId: string }");
    return wfs.start(p.instanceId);
  });

  server.method("workflows.pause", (params) => {
    const p = params as { instanceId?: string } | undefined;
    if (!p || typeof p.instanceId !== "string") throw new Error("workflows.pause requires { instanceId: string }");
    return wfs.pause(p.instanceId);
  });

  server.method("workflows.cancel", (params) => {
    const p = params as { instanceId?: string; reason?: string } | undefined;
    if (!p || typeof p.instanceId !== "string") throw new Error("workflows.cancel requires { instanceId: string }");
    return wfs.cancel(p.instanceId, p.reason);
  });

  server.method("workflows.resume", (params) => {
    const p = params as { instanceId?: string } | undefined;
    if (!p || typeof p.instanceId !== "string") throw new Error("workflows.resume requires { instanceId: string }");
    return wfs.resume(p.instanceId);
  });

  server.method("workflows.get", (params) => {
    const p = params as { instanceId?: string } | undefined;
    if (!p || typeof p.instanceId !== "string") throw new Error("workflows.get requires { instanceId: string }");
    return wfs.getInstance(p.instanceId) ?? null;
  });

  server.method("workflows.list", (params) => {
    const p = (params as { workflowId?: string; status?: string } | undefined) ?? {};
    return wfs.listInstances({ workflowId: p.workflowId, status: p.status as never });
  });

  server.method("workflows.events", (params) => {
    const p = params as { instanceId?: string } | undefined;
    if (!p || typeof p.instanceId !== "string") throw new Error("workflows.events requires { instanceId: string }");
    return wfs.eventsFor(p.instanceId);
  });
}

/**
 * Register RPC methods for the WebhookService. Exposes:
 *   webhooks.registerEndpoint, webhooks.unregisterEndpoint, webhooks.listEndpoints,
 *   webhooks.addRule, webhooks.receive (test ingress), webhooks.listEvents,
 *   webhooks.counts
 */
export function registerWebhookMethods(
  server: RpcServer,
  whs: {
    registerEndpoint(endpoint: unknown): unknown;
    unregisterEndpoint(id: string): boolean;
    listEndpoints(): Array<{ id: string; path: string; active: boolean; tags?: string[] }>;
    addRule(rule: unknown): unknown;
    receive(input: {
      endpointId: string;
      type: string;
      payload: unknown;
      rawBody: string;
      headers: Record<string, string>;
    }): Promise<unknown>;
    listEvents(filter?: { endpointId?: string; verified?: boolean; type?: string }): Array<unknown>;
    counts(): { verified: number; unverified: number; delivered: number; total: number };
  },
): void {
  server.method("webhooks.registerEndpoint", (params) => {
    const p = params as { endpoint?: { id?: string; path?: string; secret?: string } } | undefined;
    if (!p || !p.endpoint) throw new Error("webhooks.registerEndpoint requires { endpoint }");
    return whs.registerEndpoint(p.endpoint);
  });

  server.method("webhooks.unregisterEndpoint", (params) => {
    const p = params as { id?: string } | undefined;
    if (!p || typeof p.id !== "string") throw new Error("webhooks.unregisterEndpoint requires { id: string }");
    return whs.unregisterEndpoint(p.id);
  });

  server.method("webhooks.listEndpoints", () => {
    return whs.listEndpoints();
  });

  server.method("webhooks.addRule", (params) => {
    const p = params as { rule?: unknown } | undefined;
    if (!p || !p.rule) throw new Error("webhooks.addRule requires { rule }");
    return whs.addRule(p.rule);
  });

  server.method("webhooks.receive", (params) => {
    const p = params as
      | { endpointId?: string; type?: string; payload?: unknown; rawBody?: string; headers?: Record<string, string> }
      | undefined;
    if (!p || typeof p.endpointId !== "string" || typeof p.type !== "string" || typeof p.rawBody !== "string") {
      throw new Error("webhooks.receive requires { endpointId, type, rawBody, headers }");
    }
    return whs.receive({
      endpointId: p.endpointId,
      type: p.type,
      payload: p.payload,
      rawBody: p.rawBody,
      headers: p.headers ?? {},
    });
  });

  server.method("webhooks.listEvents", (params) => {
    const p = (params as { endpointId?: string; verified?: boolean; type?: string } | undefined) ?? {};
    return whs.listEvents({
      endpointId: p.endpointId,
      verified: p.verified,
      type: p.type,
    });
  });

  server.method("webhooks.counts", () => {
    return whs.counts();
  });
}

/**
 * Register RPC methods for the ControlPlaneService. Exposes:
 *   control.status, control.health, control.metrics, control.control,
 *   control.phase
 */
export function registerControlPlaneMethods(
  server: RpcServer,
  cp: {
    status(statusInput?: { activeRuns?: number; queuedJobs?: number; activeSubagents?: number }): {
      phase: string;
      activeRuns: number;
      queuedJobs: number;
      activeSubagents: number;
      memoryUsageMb: number;
      uptimeMs: number;
      startedAt: string;
    };
    health(): Promise<{
      overall: string;
      checks: Array<{ name: string; status: string; message?: string; checkedAt?: string }>;
    }>;
    metricsSnapshot(): Array<{ name: string; type: string; value: number; labels?: Record<string, string> }>;
    control(request: { action: string; target?: string; reason?: string }): {
      action: string;
      accepted: boolean;
      message?: string;
    };
    getPhase(): string;
  },
): void {
  server.method("control.status", (params) => {
    const p = (params as { activeRuns?: number; queuedJobs?: number; activeSubagents?: number } | undefined) ?? {};
    return cp.status(p);
  });

  server.method("control.health", () => {
    return cp.health();
  });

  server.method("control.metrics", () => {
    return cp.metricsSnapshot();
  });

  server.method("control.control", (params) => {
    const p = params as { action?: string; target?: string; reason?: string } | undefined;
    if (!p || typeof p.action !== "string") throw new Error("control.control requires { action: string }");
    return cp.control({ action: p.action as never, target: p.target, reason: p.reason });
  });

  server.method("control.phase", () => {
    return { phase: cp.getPhase() };
  });
}

/**
 * Convenience: register ALL service methods at once. The embedding app
 * passes the Agent instance (which has all the services as fields); this
 * wires every JSON-RPC method handler in one call.
 *
 * @param server the RPC server
 * @param agent  the Agent instance (or any object with the right fields)
 */
export function registerAllServiceMethods(
  server: RpcServer,
  agent: {
    jobs?: Parameters<typeof registerJobMethods>[1];
    subagents?: Parameters<typeof registerSubagentMethods>[1];
    workflows?: Parameters<typeof registerWorkflowMethods>[1];
    webhooks?: Parameters<typeof registerWebhookMethods>[1];
    controlPlane?: Parameters<typeof registerControlPlaneMethods>[1];
    pluginHost?: { all(): Array<{ manifest: { id: string; name: string; version: string }; state: string }> };
  },
): void {
  if (agent.pluginHost) {
    registerCoreMethods(server, { plugins: agent.pluginHost });
  }
  if (agent.jobs) registerJobMethods(server, agent.jobs);
  if (agent.subagents) registerSubagentMethods(server, agent.subagents);
  if (agent.workflows) registerWorkflowMethods(server, agent.workflows);
  if (agent.webhooks) registerWebhookMethods(server, agent.webhooks);
  if (agent.controlPlane) registerControlPlaneMethods(server, agent.controlPlane);
}

void randomUUID; // keep import for future correlation
