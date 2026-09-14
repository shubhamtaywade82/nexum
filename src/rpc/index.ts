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

export type RpcMethodHandler = (
  params: unknown,
  context: RpcContext,
) => Promise<unknown> | unknown;

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

void randomUUID; // keep import for future correlation
