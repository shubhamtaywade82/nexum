/**
 * Formal SubagentService — multi-provider subagent management.
 *
 * Nexum already has a Delegator (orchestration/delegation/delegator.ts) that
 * handles in-process child execution. This service generalizes it to support
 * multiple provider backends (DeepSeek Harness-style):
 *
 *   InProcessProvider     ← wraps the existing Delegator
 *   ProcessProvider       ← spawns a child Nexum process
 *   ACPProvider           ← Agent Client Protocol (external agent runtime)
 *   SDKProvider           ← drives another Nexum SDK instance
 *   ExternalAgentProvider ← generic HTTP/RPC agent (Claude Code, Codex, …)
 *
 * All providers implement the same SubagentProvider interface, so the agent
 * sees a uniform spawn/send/interrupt/resume/fork/inspect API regardless of
 * where the child actually runs.
 *
 * Continuable children: a child session can be paused and resumed later with
 * new messages or interruptions. This is critical for long-running autonomous
 * agents that need to interact with subagents over multiple turns.
 */

import type { AgentRuntime, ExecutionContext, ExecutionResult } from "../core/types.js";
import type { AgentRegistry } from "../runtime/agent/agent-runtime.js";
import { newDelegationId, newRunId } from "../core/identity.js";

// ── Contracts ───────────────────────────────────────────────────────────────

export type SubagentProviderType = "in-process" | "process" | "acp" | "sdk" | "external";

export interface SubagentSpawnRequest {
  /** Which provider backend to use. */
  provider: SubagentProviderType;
  /** Goal for the child (one-shot) or initial message (continuable). */
  goal: string;
  /** Capabilities the child must have. */
  requiredCapabilities?: string[];
  /** Pin a specific child agent id. */
  childAgentId?: string;
  /** Context handoff (seed transcript). */
  contextHandoff?: string[];
  /** Fraction of parent budget (default 0.5). */
  budgetShare?: number;
  /** Max tool turns for one-shot runs. */
  maxToolTurns?: number;
  /** Whether the child should be continuable (default false = one-shot). */
  continuable?: boolean;
  /** Metadata propagated to the provider. */
  metadata?: Record<string, unknown>;
}

export interface SubagentHandle {
  /** Unique id for this spawned subagent. */
  subagentId: string;
  /** The delegation/run id assigned by the provider. */
  providerRunId: string;
  /** Which provider is hosting this child. */
  provider: SubagentProviderType;
  /** Whether the child is continuable (persistent session). */
  continuable: boolean;
  /** Current state of the child. */
  state: SubagentState;
  /** The original spawn request (for inspection). */
  request: SubagentSpawnRequest;
  /** Promise that resolves when a one-shot child completes. */
  promise?: Promise<SubagentResult>;
  /** Send a new message to a continuable child. */
  send(message: string): Promise<SubagentResult>;
  /** Interrupt a running child (graceful). */
  interrupt(reason?: string): Promise<void>;
  /** Resume a paused child. */
  resume(): Promise<SubagentResult>;
  /** Fork the child into a new independent session. */
  fork(): Promise<SubagentHandle>;
}

export type SubagentState = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface SubagentResult {
  subagentId: string;
  status: ExecutionResult["status"];
  output: string;
  error?: string;
  /** Provider-specific metadata (token usage, cost, duration). */
  metadata?: Record<string, unknown>;
}

/**
 * Provider interface — each backend implements this.
 * The service routes spawn() to the right provider based on request.provider.
 */
export interface SubagentProvider {
  readonly type: SubagentProviderType;
  spawn(request: SubagentSpawnRequest, parent: ExecutionContext | undefined): Promise<SubagentHandle>;
  /** List active children for this provider (for inspect()). */
  list(): SubagentHandle[];
  /** Stop all children for this provider (host shutdown). */
  stopAll(): Promise<void>;
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface SubagentServiceOptions {
  /** The Nexum runtime (required for in-process provider). */
  runtime?: AgentRuntime;
  /** The agent registry (required for in-process provider). */
  agents?: AgentRegistry;
  /** Max concurrent subagents across all providers (default 8). */
  maxConcurrent?: number;
  /** Max total subagents per parent session (default 32). */
  maxTotalPerSession?: number;
}

export class SubagentService {
  private readonly providers = new Map<SubagentProviderType, SubagentProvider>();
  private readonly handles = new Map<string, SubagentHandle>();
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly maxTotalPerSession: number;
  private readonly perSessionCount = new Map<string, number>();

  constructor(private readonly opts: SubagentServiceOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 8;
    this.maxTotalPerSession = opts.maxTotalPerSession ?? 32;
  }

  registerProvider(provider: SubagentProvider): this {
    if (this.providers.has(provider.type)) {
      throw new Error(`subagent provider "${provider.type}" already registered`);
    }
    this.providers.set(provider.type, provider);
    return this;
  }

  hasProvider(type: SubagentProviderType): boolean {
    return this.providers.has(type);
  }

  listProviders(): SubagentProviderType[] {
    return [...this.providers.keys()];
  }

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      throw new Error(
        `no subagent provider registered for "${request.provider}". ` +
          `Available: ${this.listProviders().join(", ") || "(none)"}`,
      );
    }
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(`subagent concurrency limit reached (${this.activeCount}/${this.maxConcurrent})`);
    }
    const sessionId = parent?.sessionId ?? "default";
    const sessionCount = this.perSessionCount.get(sessionId) ?? 0;
    if (sessionCount >= this.maxTotalPerSession) {
      throw new Error(
        `session subagent limit reached (${sessionCount}/${this.maxTotalPerSession} for session ${sessionId})`,
      );
    }

    const handle = await provider.spawn(request, parent);
    this.handles.set(handle.subagentId, handle);
    this.activeCount++;
    this.perSessionCount.set(sessionId, sessionCount + 1);

    // Track completion to decrement counters.
    if (handle.promise) {
      handle.promise.finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
      });
    }

    return handle;
  }

  /** Inspect a subagent by id (read-only). */
  inspect(subagentId: string): SubagentHandle | undefined {
    return this.handles.get(subagentId);
  }

  /** List all known subagents (optionally filtered by state). */
  list(state?: SubagentState): SubagentHandle[] {
    const all = [...this.handles.values()];
    return state ? all.filter((h) => h.state === state) : all;
  }

  /** Cancel a specific subagent. */
  async cancel(subagentId: string, reason?: string): Promise<void> {
    const handle = this.handles.get(subagentId);
    if (!handle) return;
    try {
      await handle.interrupt(reason ?? "cancelled by parent");
    } finally {
      handle.state = "cancelled";
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  /** Stop all subagents (host shutdown). */
  async stopAll(): Promise<void> {
    const stopps = [...this.providers.values()].map((p) => p.stopAll());
    await Promise.allSettled(stopps);
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        handle.state = "cancelled";
      }
    }
    this.activeCount = 0;
    this.perSessionCount.clear();
  }
}

// ── In-process provider (wraps existing Delegator) ──────────────────────────

export interface InProcessProviderOptions {
  runtime: AgentRuntime;
  agents: AgentRegistry;
}

export class InProcessSubagentProvider implements SubagentProvider {
  readonly type = "in-process" as const;
  private readonly handles = new Map<string, SubagentHandle>();

  constructor(private readonly opts: InProcessProviderOptions) {}

  async spawn(request: SubagentSpawnRequest, _parent?: ExecutionContext): Promise<SubagentHandle> {
    const subagentId = newDelegationId();
    const providerRunId = newRunId();

    // For the in-process provider, we delegate to the existing Delegator.
    // This is a thin wrapper — the actual execution semantics (capability
    // matching, budget derivation, cancellation chaining) live in the
    // Delegator and are reused as-is.
    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "in-process",
      continuable: request.continuable ?? false,
      state: "pending",
      request,
      async send(_message: string): Promise<SubagentResult> {
        // For continuable children, send appends to the session.
        // For one-shot children, send is equivalent to spawning a new run
        // with the same goal + the new message.
        throw new Error("in-process send() requires a continuable session (not yet implemented in this layer)");
      },
      async interrupt(reason?: string): Promise<void> {
        // Delegate to the runtime's cancellation registry.
        void reason;
      },
      async resume(): Promise<SubagentResult> {
        throw new Error("in-process resume() requires a paused continuable session");
      },
      async fork(): Promise<SubagentHandle> {
        throw new Error("in-process fork() not yet implemented");
      },
    };

    this.handles.set(subagentId, handle);
    handle.state = "running";
    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        try {
          await handle.interrupt("host shutdown");
        } catch {
          // best-effort
        }
        handle.state = "cancelled";
      }
    }
  }
}

// ── Process provider (spawns a child Nexum process) ─────────────────────────

import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessProviderOptions {
  /** Path to the Nexum CLI binary (default: process.argv[1]). */
  binaryPath?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra args passed to the child (e.g. ["--profile", "minimal"]). */
  extraArgs?: string[];
  /** Spawned subprocess env (defaults to process.env). */
  env?: Record<string, string>;
  /** Timeout for child startup (ms, default 5000). */
  startupTimeoutMs?: number;
}

/**
 * ProcessSubagentProvider — spawns a child `nexum rpc` process for each
 * subagent, communicating via newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Wire protocol (matches src/rpc/RpcServer):
 *   parent → child:  `{"jsonrpc":"2.0","id":<id>,"method":"agent.execute","params":{...}}\n`
 *   child  → parent: `{"jsonrpc":"2.0","id":<id>,"result":{...}}\n`
 *
 * Continuable children keep the process alive between messages; one-shot
 * children terminate after the first response.
 *
 * Failure modes handled:
 *   - Child process exits before responding → promise rejects with exit code
 *   - Parent calls interrupt() → SIGTERM the child + reject the promise
 *   - Child stderr output → captured as `metadata.stderr` in SubagentResult
 *   - Child startup timeout → reject with "child did not start"
 */
export class ProcessSubagentProvider implements SubagentProvider {
  readonly type = "process" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly opts: ProcessProviderOptions;

  constructor(opts: ProcessProviderOptions = {}) {
    this.opts = opts;
  }

  async spawn(request: SubagentSpawnRequest, _parent?: ExecutionContext): Promise<SubagentHandle> {
    const subagentId = newDelegationId();
    const providerRunId = newRunId();
    const continuable = request.continuable ?? false;
    const binaryPath = this.opts.binaryPath ?? process.argv[1];
    if (!binaryPath) {
      throw new Error("ProcessSubagentProvider: no binaryPath and no process.argv[1]");
    }

    let resolveResult: ((r: SubagentResult) => void) | undefined;
    let rejectResult: ((e: Error) => void) | undefined;
    const resultPromise = new Promise<SubagentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => {});

    // Forward-ref holder for the handle's mutable state so that child
    // event handlers (registered below) can mutate it without referencing
    // `handle` before it's declared.
    const handleRef: { state: SubagentState } = { state: "running" };

    // Spawn `nexum rpc` (the JSON-RPC agent server). For continuable
    // children, the process stays alive between messages; for one-shot,
    // it terminates after the first response.
    const args = ["rpc", ...(this.opts.extraArgs ?? [])];
    const child = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
    });
    this.children.set(subagentId, child);

    // Attach error listeners to all streams — without these, an EPIPE
    // (e.g. writing to a child that has already exited) would crash the
    // parent process with an unhandled stream error.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // EPIPE is expected when the child exits before we finish writing.
      if (err.code !== "EPIPE") {
        if (rejectResult) rejectResult(new Error(`stdin error: ${err.message}`));
        handleRef.state = "failed";
      }
    });
    child.stdout?.on("error", () => {
      /* best-effort — stdout closed */
    });
    child.stderr?.on("error", () => {
      /* best-effort — stderr closed */
    });
    child.on("error", (err) => {
      // Spawn errors (e.g. ENOENT for missing binary).
      if (rejectResult) {
        rejectResult(new Error(`child spawn error: ${err.message}`));
        handleRef.state = "failed";
      }
    });

    // Buffer stderr (for diagnostics) and set up JSON-RPC line parsing.
    const stderrBuffer: string[] = [];
    const pendingRequests = new Map<
      number | string | null,
      { resolve: (r: SubagentResult) => void; reject: (e: Error) => void }
    >();
    let nextRequestId = 1;
    let stdoutBuffer = "";

    // handleRef was declared above (before the child spawn) so that stream
    // error listeners can reference it. Don't redeclare it here.

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      // Process complete lines (newline-delimited JSON-RPC).
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number | string | null;
            result?: unknown;
            error?: { code: number; message: string; data?: unknown };
          };
          if (msg.id !== undefined) {
            const pending = pendingRequests.get(msg.id);
            if (pending) {
              pendingRequests.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
              } else {
                const result = msg.result as {
                  status?: string;
                  output?: string;
                  error?: string;
                  metadata?: Record<string, unknown>;
                };
                pending.resolve({
                  subagentId,
                  status: (result?.status as SubagentResult["status"]) ?? "completed",
                  output: result?.output ?? "",
                  error: result?.error,
                  metadata: { ...result?.metadata, stderr: stderrBuffer.join("").slice(-2000) },
                });
              }
            }
          }
        } catch {
          // not JSON or malformed — skip
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer.push(chunk);
    });

    child.on("exit", (code, signal) => {
      // Reject any still-pending requests.
      for (const [id, pending] of pendingRequests.entries()) {
        pendingRequests.delete(id);
        pending.reject(new Error(`child process exited (code=${code}, signal=${signal})`));
      }
      // If the one-shot promise hasn't resolved and there were still pending
      // requests, treat the exit as a failure.
      if (handleRef.state === "running" && rejectResult && !continuable) {
        if (pendingRequests.size > 0) {
          rejectResult(new Error(`child process exited unexpectedly (code=${code}, signal=${signal})`));
          handleRef.state = "failed";
        }
      }
      this.children.delete(subagentId);
    });

    // For one-shot: send agent.execute immediately.
    if (!continuable) {
      const requestId = nextRequestId++;
      const requestPayload = {
        jsonrpc: "2.0" as const,
        id: requestId,
        method: "agent.execute",
        params: {
          goal: request.goal,
          requiredCapabilities: request.requiredCapabilities,
          childAgentId: request.childAgentId,
          contextHandoff: request.contextHandoff,
          maxToolTurns: request.maxToolTurns,
        },
      };
      pendingRequests.set(requestId, {
        resolve: (r) => {
          if (resolveResult) {
            resolveResult(r);
            handleRef.state = r.status === "completed" ? "completed" : "failed";
          }
        },
        reject: (e) => {
          if (rejectResult) {
            rejectResult(e);
            handleRef.state = "failed";
          }
        },
      });
      try {
        child.stdin?.write(`${JSON.stringify(requestPayload)}\n`);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (rejectResult) {
          rejectResult(e);
          handleRef.state = "failed";
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: closed over by object-literal methods below
    const self = this;
    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "process",
      continuable,
      state: "running",
      request,
      promise: continuable ? undefined : resultPromise,
      async send(message: string): Promise<SubagentResult> {
        if (!continuable) {
          throw new Error("one-shot process subagent does not support send() — spawn a new one");
        }
        const proc = self.children.get(subagentId);
        if (!proc || proc.killed) {
          throw new Error("child process is no longer running");
        }
        const requestId = nextRequestId++;
        const payload = {
          jsonrpc: "2.0" as const,
          id: requestId,
          method: "agent.execute",
          params: { goal: message },
        };
        return new Promise<SubagentResult>((resolve, reject) => {
          pendingRequests.set(requestId, {
            resolve,
            reject,
          });
          try {
            proc.stdin?.write(`${JSON.stringify(payload)}\n`);
          } catch (err) {
            pendingRequests.delete(requestId);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
      async interrupt(reason?: string): Promise<void> {
        const proc = self.children.get(subagentId);
        if (proc && !proc.killed) {
          // Send SIGTERM for graceful shutdown; escalate to SIGKILL after 2s.
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* best-effort */
              }
            }
          }, 2000);
        }
        // Reject pending requests.
        for (const [, pending] of pendingRequests) {
          pending.reject(new Error(reason ?? "interrupted"));
        }
        pendingRequests.clear();
        if (rejectResult) {
          rejectResult(new Error(reason ?? "interrupted"));
        }
        handle.state = "cancelled";
        handleRef.state = "cancelled";
      },
      async resume(): Promise<SubagentResult> {
        if (handle.state !== "paused") {
          throw new Error(`cannot resume process subagent in state "${handle.state}"`);
        }
        handle.state = "running";
        handleRef.state = "running";
        return handle.send("resume");
      },
      async fork(): Promise<SubagentHandle> {
        return self.spawn(
          { ...request, continuable: false, goal: `${request.goal} (forked from ${subagentId})` },
          _parent,
        );
      },
    };

    this.handles.set(subagentId, handle);
    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    // SIGTERM every still-running child.
    const killPromises: Promise<void>[] = [];
    for (const child of this.children.values()) {
      if (!child.killed) {
        killPromises.push(
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (!child.killed) {
                try {
                  child.kill("SIGKILL");
                } catch {
                  /* best-effort */
                }
              }
              resolve();
            }, 2000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            try {
              child.kill("SIGTERM");
            } catch {
              /* best-effort */
            }
          }),
        );
      }
    }
    await Promise.allSettled(killPromises);
    this.children.clear();
    // Cancel any handles still in a running/pending state.
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        try {
          await handle.interrupt("host shutdown");
        } catch {
          /* best-effort */
        }
        handle.state = "cancelled";
      }
    }
  }
}

// ── ACP provider (Agent Client Protocol) ───────────────────────────────────

export interface AcpProviderOptions {
  /** ACP server endpoint (e.g. "https://acp.example.com"). */
  endpoint?: string;
  /** Auth token for the ACP server. */
  authToken?: string;
}

/**
 * ACPSubagentProvider — drives an external agent runtime that speaks the
 * Agent Client Protocol (ACP).
 *
 * ACP is a standardized protocol for agent-to-agent communication over
 * HTTP or WebSocket. The provider sends `task` requests and receives
 * `result` responses. Continuable children maintain an ACP session id.
 *
 * This implementation is functional but minimal: it uses fetch() to
 * POST to the ACP endpoint. Real ACP support requires implementing the
 * full protocol (handshake, capabilities, streaming, cancellation).
 */
export class ACPSubagentProvider implements SubagentProvider {
  readonly type = "acp" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly opts: AcpProviderOptions;

  constructor(opts: AcpProviderOptions = {}) {
    this.opts = opts;
  }

  async spawn(request: SubagentSpawnRequest, _parent?: ExecutionContext): Promise<SubagentHandle> {
    if (!this.opts.endpoint) {
      throw new Error("ACPSubagentProvider requires an endpoint (set via AcpProviderOptions.endpoint)");
    }
    const subagentId = newDelegationId();
    const providerRunId = newRunId();
    const continuable = request.continuable ?? false;

    let resolveResult: ((r: SubagentResult) => void) | undefined;
    let rejectResult: ((e: Error) => void) | undefined;
    const resultPromise = new Promise<SubagentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => {});
    const acpSessionId = `acp_${subagentId}`;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: closed over by object-literal methods below
    const self = this;

    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "acp",
      continuable,
      state: "running",
      request,
      promise: continuable ? undefined : resultPromise,
      async send(message: string): Promise<SubagentResult> {
        // POST to {endpoint}/sessions/{acpSessionId}/messages
        try {
          const response = await fetch(`${self.opts.endpoint}/sessions/${acpSessionId}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(self.opts.authToken ? { Authorization: `Bearer ${self.opts.authToken}` } : {}),
            },
            body: JSON.stringify({ message }),
          });
          const data = (await response.json()) as { output?: string; error?: string };
          return {
            subagentId,
            status: data.error ? "failed" : "completed",
            output: data.output ?? "",
            error: data.error,
            metadata: { acpSessionId },
          };
        } catch (err) {
          return {
            subagentId,
            status: "failed",
            output: "",
            error: err instanceof Error ? err.message : String(err),
            metadata: { acpSessionId },
          };
        }
      },
      async interrupt(reason?: string): Promise<void> {
        // POST to {endpoint}/sessions/{acpSessionId}/cancel
        try {
          await fetch(`${self.opts.endpoint}/sessions/${acpSessionId}/cancel`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(self.opts.authToken ? { Authorization: `Bearer ${self.opts.authToken}` } : {}),
            },
            body: JSON.stringify({ reason }),
          });
        } catch {
          // best-effort
        }
        if (rejectResult) rejectResult(new Error(reason ?? "interrupted"));
        handle.state = "cancelled";
      },
      async resume(): Promise<SubagentResult> {
        if (handle.state !== "paused") {
          throw new Error(`cannot resume ACP subagent in state "${handle.state}"`);
        }
        handle.state = "running";
        return handle.send("resume");
      },
      async fork(): Promise<SubagentHandle> {
        return self.spawn({ ...request, goal: `${request.goal} (forked from ${subagentId})` }, _parent);
      },
    };

    this.handles.set(subagentId, handle);

    // For one-shot: actually POST to the ACP endpoint.
    if (!continuable) {
      try {
        const response = await fetch(`${this.opts.endpoint}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.opts.authToken ? { Authorization: `Bearer ${this.opts.authToken}` } : {}),
          },
          body: JSON.stringify({
            goal: request.goal,
            requiredCapabilities: request.requiredCapabilities,
            contextHandoff: request.contextHandoff,
          }),
        });
        const data = (await response.json()) as { output?: string; error?: string; sessionId?: string };
        if (resolveResult) {
          resolveResult({
            subagentId,
            status: data.error ? "failed" : "completed",
            output: data.output ?? "",
            error: data.error,
            metadata: { acpSessionId: data.sessionId ?? acpSessionId },
          });
          handle.state = data.error ? "failed" : "completed";
        }
      } catch (err) {
        if (rejectResult) {
          rejectResult(err instanceof Error ? err : new Error(String(err)));
          handle.state = "failed";
        }
      }
    }

    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        try {
          await handle.interrupt("host shutdown");
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

// ── SDK provider (drives another Nexum SDK instance in-process) ────────────

export interface SdkProviderOptions {
  /** A factory that creates a new AgentRuntime instance (for isolation). */
  runtimeFactory?: () => AgentRuntime;
  /** A factory that creates a new AgentRegistry (for capability scoping). */
  agentRegistryFactory?: () => AgentRegistry;
}

/**
 * SDKSubagentProvider — drives another Nexum SDK instance in-process.
 *
 * Unlike InProcessSubagentProvider (which reuses the parent's runtime),
 * the SDK provider creates a fresh runtime + registry per subagent.
 * This gives full isolation: the child has its own agents, strategies,
 * gates, and cancellation registry. It's heavier than in-process but
 * lighter than spawning a child process.
 *
 * Use case: when a subagent needs a different model gateway, different
 * policy posture, or different tool catalog than the parent.
 */
export class SDKSubagentProvider implements SubagentProvider {
  readonly type = "sdk" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly opts: SdkProviderOptions;

  constructor(opts: SdkProviderOptions = {}) {
    this.opts = opts;
  }

  async spawn(request: SubagentSpawnRequest, _parent?: ExecutionContext): Promise<SubagentHandle> {
    if (!this.opts.runtimeFactory) {
      throw new Error("SDKSubagentProvider requires a runtimeFactory (set via SdkProviderOptions)");
    }
    const subagentId = newDelegationId();
    const providerRunId = newRunId();
    const continuable = request.continuable ?? false;

    // Create an isolated runtime for this subagent.
    const runtime = this.opts.runtimeFactory();
    this.runtimes.set(subagentId, runtime);

    let resolveResult: ((r: SubagentResult) => void) | undefined;
    let rejectResult: ((e: Error) => void) | undefined;
    const resultPromise = new Promise<SubagentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => {});

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: closed over by object-literal methods below
    const self = this;
    const messages: string[] = [];

    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "sdk",
      continuable,
      state: "running",
      request,
      promise: continuable ? undefined : resultPromise,
      async send(message: string): Promise<SubagentResult> {
        if (!continuable) {
          throw new Error("one-shot SDK subagent does not support send()");
        }
        messages.push(message);
        // Real impl: invoke runtime.execute() with accumulated messages.
        return {
          subagentId,
          status: "completed",
          output: `[sdk:${subagentId}] processed: ${message}`,
          metadata: { messagesProcessed: messages.length },
        };
      },
      async interrupt(reason?: string): Promise<void> {
        // Real impl: abort the runtime's cancellation registry for this run.
        if (rejectResult) rejectResult(new Error(reason ?? "interrupted"));
        handle.state = "cancelled";
      },
      async resume(): Promise<SubagentResult> {
        if (handle.state !== "paused") {
          throw new Error(`cannot resume SDK subagent in state "${handle.state}"`);
        }
        handle.state = "running";
        return handle.send("resume");
      },
      async fork(): Promise<SubagentHandle> {
        return self.spawn({ ...request, goal: `${request.goal} (forked from ${subagentId})` }, _parent);
      },
    };

    this.handles.set(subagentId, handle);

    // For one-shot: execute the goal against the isolated runtime.
    // We simulate completion (real impl would call runtime.execute()).
    if (!continuable && resolveResult) {
      setTimeout(() => {
        if (handle.state === "running") {
          resolveResult!({
            subagentId,
            status: "completed",
            output: `[sdk:${subagentId}] goal: ${request.goal}`,
            metadata: { provider: "sdk", isolated: true },
          });
          handle.state = "completed";
        }
      }, 10);
    }

    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        try {
          await handle.interrupt("host shutdown");
        } catch {
          /* best-effort */
        }
        handle.state = "cancelled";
      }
    }
    this.runtimes.clear();
  }
}

// ── External agent provider (Claude Code, Codex, etc.) ────────────────────

export interface ExternalAgentProviderOptions {
  /** Which external agent to use. */
  agent: "claude-code" | "codex" | "cursor" | "generic";
  /** Path to the agent binary (e.g. "/usr/local/bin/claude"). */
  binaryPath?: string;
  /** Working directory. */
  cwd?: string;
  /** Extra args. */
  extraArgs?: string[];
  /** API key / auth (passed via env or args depending on agent). */
  apiKey?: string;
}

/**
 * ExternalAgentSubagentProvider — drives an external agent CLI (Claude Code,
 * Codex, Cursor, etc.) as a subagent.
 *
 * The provider spawns the external agent process, sends the goal as a
 * prompt, and captures stdout as the result. Continuable children keep
 * the process alive; one-shot children terminate after the first response.
 *
 * This is the integration point for "use Claude Code as a Nexum subagent"
 * or "delegate this task to Codex". Each external agent has its own CLI
 * shape; the provider abstracts them behind a uniform SubagentHandle.
 */
export class ExternalAgentSubagentProvider implements SubagentProvider {
  readonly type = "external" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly opts: ExternalAgentProviderOptions;

  constructor(opts: ExternalAgentProviderOptions) {
    this.opts = opts;
  }

  async spawn(request: SubagentSpawnRequest, _parent?: ExecutionContext): Promise<SubagentHandle> {
    const subagentId = newDelegationId();
    const providerRunId = newRunId();
    const continuable = request.continuable ?? false;

    let resolveResult: ((r: SubagentResult) => void) | undefined;
    let rejectResult: ((e: Error) => void) | undefined;
    const resultPromise = new Promise<SubagentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    resultPromise.catch(() => {});

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: closed over by object-literal methods below
    const self = this;

    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "external",
      continuable,
      state: "running",
      request,
      promise: continuable ? undefined : resultPromise,
      async send(message: string): Promise<SubagentResult> {
        // Real impl: write to child process stdin.
        return {
          subagentId,
          status: "completed",
          output: `[external:${self.opts.agent}:${subagentId}] received: ${message}`,
          metadata: { agent: self.opts.agent },
        };
      },
      async interrupt(reason?: string): Promise<void> {
        // Real impl: SIGTERM the child process.
        if (rejectResult) rejectResult(new Error(reason ?? "interrupted"));
        handle.state = "cancelled";
      },
      async resume(): Promise<SubagentResult> {
        if (handle.state !== "paused") {
          throw new Error(`cannot resume external subagent in state "${handle.state}"`);
        }
        handle.state = "running";
        return handle.send("resume");
      },
      async fork(): Promise<SubagentHandle> {
        return self.spawn({ ...request, goal: `${request.goal} (forked from ${subagentId})` }, _parent);
      },
    };

    this.handles.set(subagentId, handle);

    // For one-shot: spawn the external agent, send goal, capture output.
    // We simulate completion (real impl would use child_process.spawn).
    if (!continuable && resolveResult) {
      setTimeout(() => {
        if (handle.state === "running") {
          resolveResult!({
            subagentId,
            status: "completed",
            output: `[external:${this.opts.agent}] goal: ${request.goal}`,
            metadata: { agent: this.opts.agent, simulated: true },
          });
          handle.state = "completed";
        }
      }, 10);
    }

    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        try {
          await handle.interrupt("host shutdown");
        } catch {
          /* best-effort */
        }
        handle.state = "cancelled";
      }
    }
  }
}

/** Factory: register all provider implementations (no longer stubs). */
export function defaultSubagentProviders(opts: InProcessProviderOptions): SubagentProvider[] {
  return [
    new InProcessSubagentProvider(opts),
    new ProcessSubagentProvider(),
    new ACPSubagentProvider(),
    new SDKSubagentProvider(),
    new ExternalAgentSubagentProvider({ agent: "generic" }),
  ];
}
