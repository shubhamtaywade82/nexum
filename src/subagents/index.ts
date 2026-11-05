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
import { Delegator, type DelegationPolicy } from "../orchestration/delegation/delegator.js";

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
  /** Slots held: reserved spawns in flight + live children. Each slot is released exactly once. */
  private activeCount = 0;
  private readonly released = new Set<string>();
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

    // Reserve before awaiting so concurrent spawn() calls cannot overshoot the limits.
    this.activeCount++;
    this.perSessionCount.set(sessionId, sessionCount + 1);
    let handle: SubagentHandle;
    try {
      handle = await provider.spawn(request, parent);
    } catch (e) {
      this.activeCount--;
      this.perSessionCount.set(sessionId, (this.perSessionCount.get(sessionId) ?? 1) - 1);
      throw e;
    }
    this.handles.set(handle.subagentId, handle);

    // One-shot children free their slot on settlement; continuable ones hold it until cancel()/stopAll().
    // then(f, f) rather than finally(): finally() re-rejects into an unhandled promise.
    if (handle.promise) {
      const release = () => this.release(handle.subagentId);
      handle.promise.then(release, release);
    }

    return handle;
  }

  /** Number of slots currently held (reserved or live children). */
  activeSlots(): number {
    return this.activeCount;
  }

  private release(subagentId: string): void {
    if (this.released.has(subagentId)) return;
    this.released.add(subagentId);
    this.activeCount--;
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
    const terminal = handle.state === "completed" || handle.state === "failed" || handle.state === "cancelled";
    try {
      if (!terminal) await handle.interrupt(reason ?? "cancelled by parent");
    } finally {
      if (!terminal) handle.state = "cancelled";
      this.release(subagentId);
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
      this.release(handle.subagentId);
    }
    this.perSessionCount.clear();
  }
}

// ── In-process provider (wraps existing Delegator) ──────────────────────────

export interface InProcessProviderOptions {
  runtime: AgentRuntime;
  agents: AgentRegistry;
}

/** The SubagentService enforces concurrency/total limits; the Delegator must not add its own lower caps. */
const SERVICE_GOVERNED_POLICY: DelegationPolicy = {
  maxConcurrentChildren: Number.MAX_SAFE_INTEGER,
  maxTotalChildren: Number.MAX_SAFE_INTEGER,
};

function stateForStatus(status: ExecutionResult["status"]): SubagentState {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * Run a one-shot child through a Delegator: isolated child context (own runId,
 * derived budget, cancellation) executed by the Delegator's runtime.
 */
function spawnDelegated(
  type: "in-process" | "sdk",
  delegator: Delegator,
  request: SubagentSpawnRequest,
  parent: ExecutionContext | undefined,
  respawn: (request: SubagentSpawnRequest) => Promise<SubagentHandle>,
): SubagentHandle {
  if (!parent) {
    throw new Error(`${type} subagents require the parent ExecutionContext (they run under its gateways and budget)`);
  }
  if (request.continuable) {
    throw new Error(`${type} subagents are one-shot; continuable sessions are not supported by this provider`);
  }
  const subagentId = newDelegationId();
  const child = delegator.delegate(
    parent,
    {
      goal: request.goal,
      requiredCapabilities: request.requiredCapabilities,
      childAgentId: request.childAgentId,
      input: request.contextHandoff?.join("\n"),
      budgetShare: request.budgetShare,
      maxToolTurns: request.maxToolTurns,
      metadata: request.metadata,
    },
    SERVICE_GOVERNED_POLICY,
  );

  let state: SubagentState = "running";
  const promise = child.promise.then(
    (result): SubagentResult => {
      if (state === "running") state = stateForStatus(result.status);
      return {
        subagentId,
        status: result.status,
        output: result.output,
        error: result.error,
        metadata: { runId: result.runId, agentId: result.agentId, usage: result.usage },
      };
    },
    (e: unknown) => {
      if (state === "running") state = "failed";
      throw e instanceof Error ? e : new Error(String(e));
    },
  );
  promise.catch(() => {});

  return {
    subagentId,
    providerRunId: child.childRunId,
    provider: type,
    continuable: false,
    get state() {
      return state;
    },
    set state(next: SubagentState) {
      state = next;
    },
    request,
    promise,
    async send(): Promise<SubagentResult> {
      throw new Error(`one-shot ${type} subagent does not support send() — spawn a new one`);
    },
    async interrupt(): Promise<void> {
      if (state !== "running") return;
      state = "cancelled";
      child.cancel();
    },
    async resume(): Promise<SubagentResult> {
      throw new Error(`one-shot ${type} subagent cannot be resumed`);
    },
    async fork(): Promise<SubagentHandle> {
      return respawn({ ...request, goal: `${request.goal} (forked from ${subagentId})` });
    },
  };
}

/**
 * InProcessSubagentProvider — one-shot children executed by the parent's
 * AgentRuntime via the Delegator (capability matching, derived budget,
 * cancellation). Requires the parent ExecutionContext.
 */
export class InProcessSubagentProvider implements SubagentProvider {
  readonly type = "in-process" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly delegator: Delegator;

  constructor(opts: InProcessProviderOptions) {
    this.delegator = new Delegator({ runtime: opts.runtime, agents: opts.agents });
  }

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    const handle = spawnDelegated("in-process", this.delegator, request, parent, (r) => this.spawn(r, parent));
    this.handles.set(handle.subagentId, handle);
    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        await handle.interrupt("host shutdown");
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
      get state() {
        return handleRef.state;
      },
      set state(next: SubagentState) {
        handleRef.state = next;
      },
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
        handleRef.state = "cancelled";
        if (rejectResult) {
          rejectResult(new Error(reason ?? "interrupted"));
        }
      },
      async resume(): Promise<SubagentResult> {
        if (handle.state !== "paused") {
          throw new Error(`cannot resume process subagent in state "${handle.state}"`);
        }
        handle.state = "running";
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
 * ACPSubagentProvider — drives a remote agent over a simple HTTP task API.
 *
 * NOTE: this is NOT an Agent Client Protocol implementation (ACP is JSON-RPC
 * over stdio: initialize / session/new / session/prompt / session/cancel).
 * The provider speaks only this Nexum-specific HTTP shape:
 *   POST {endpoint}/tasks                          { goal, ... } → { output?, error?, sessionId? }
 *   POST {endpoint}/sessions/{id}/messages         { message }   → { output?, error? }
 *   POST {endpoint}/sessions/{id}/cancel           { reason }
 * No handshake, capability negotiation, or streaming. Not registered by
 * defaultSubagentProviders() unless an endpoint is configured.
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
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${this.opts.endpoint}/tasks`);
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

// ── SDK provider (fresh AgentRuntime per subagent) ─────────────────────────

export interface SdkProviderOptions {
  /** Creates a new AgentRuntime per subagent (own strategies, gates, cancellation). */
  runtimeFactory?: () => AgentRuntime;
  /** Creates the child's AgentRegistry. Defaults to the runtime's own `agents` registry when it exposes one. */
  agentRegistryFactory?: () => AgentRegistry;
}

/**
 * SDKSubagentProvider — one-shot children executed by a FRESH AgentRuntime
 * per subagent (own agents, strategies, gates, cancellation registry).
 *
 * The child context is still derived from the parent's ExecutionContext, so
 * it inherits the parent's model/tool gateways and policy engine and draws
 * from a derived share of the parent's budget. Isolation here is runtime
 * state isolation, not a security boundary.
 */
export class SDKSubagentProvider implements SubagentProvider {
  readonly type = "sdk" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly opts: SdkProviderOptions;

  constructor(opts: SdkProviderOptions = {}) {
    this.opts = opts;
  }

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    if (!this.opts.runtimeFactory) {
      throw new Error("SDKSubagentProvider requires a runtimeFactory (set via SdkProviderOptions)");
    }
    const runtime = this.opts.runtimeFactory();
    const agents = this.opts.agentRegistryFactory?.() ?? (runtime as { agents?: AgentRegistry }).agents;
    if (!agents) {
      throw new Error("SDKSubagentProvider requires an agentRegistryFactory when the runtime exposes no `agents`");
    }
    const delegator = new Delegator({ runtime, agents });
    const handle = spawnDelegated("sdk", delegator, request, parent, (r) => this.spawn(r, parent));
    this.handles.set(handle.subagentId, handle);
    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        await handle.interrupt("host shutdown");
      }
    }
  }
}

// ── External agent provider (Claude Code, Codex, any CLI agent) ───────────

export interface ExternalAgentProviderOptions {
  /**
   * Which external agent. "claude-code" and "codex" have built-in invocations
   * (`claude -p <goal>`, `codex exec <goal>`); "cursor" and "generic" require
   * `binaryPath` and use `extraArgs` as the full argument list.
   */
  agent: "claude-code" | "codex" | "cursor" | "generic";
  /** Agent binary. Defaults to "claude" / "codex" for the built-in agents. */
  binaryPath?: string;
  /** Working directory for the agent process. */
  cwd?: string;
  /**
   * Extra args. For built-in agents they are inserted before the goal. For
   * cursor/generic they are the whole argument list: a "{goal}" element is
   * replaced with the goal, otherwise the goal is appended.
   */
  extraArgs?: string[];
  /** API key exported to the agent via `apiKeyEnv`. */
  apiKey?: string;
  /** Env var carrying `apiKey`. Defaults: ANTHROPIC_API_KEY (claude-code), OPENAI_API_KEY (codex). */
  apiKeyEnv?: string;
  /** Extra environment for the agent process (merged over process.env). */
  env?: Record<string, string>;
  /** Wall-clock limit per run (default 15 min). */
  timeoutMs?: number;
  /** Max stdout bytes retained as output (default 1 MiB); excess is dropped and flagged. */
  maxOutputBytes?: number;
}

const EXTERNAL_PRESETS: Partial<
  Record<ExternalAgentProviderOptions["agent"], { binary: string; args: string[]; apiKeyEnv: string }>
> = {
  "claude-code": { binary: "claude", args: ["-p"], apiKeyEnv: "ANTHROPIC_API_KEY" },
  codex: { binary: "codex", args: ["exec"], apiKeyEnv: "OPENAI_API_KEY" },
};

/**
 * ExternalAgentSubagentProvider — runs an external agent CLI as a one-shot
 * subagent: spawns the process (no shell), passes the goal as an argument,
 * captures stdout as the output. Exit 0 → completed; non-zero → failed with
 * the stderr tail. Spawn errors, timeouts and interrupts reject the promise.
 * Continuable sessions are not supported.
 */
export class ExternalAgentSubagentProvider implements SubagentProvider {
  readonly type = "external" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly opts: ExternalAgentProviderOptions;

  constructor(opts: ExternalAgentProviderOptions) {
    this.opts = opts;
  }

  private invocation(goal: string): { binary: string; args: string[]; env: Record<string, string> } {
    const preset = EXTERNAL_PRESETS[this.opts.agent];
    const binary = this.opts.binaryPath ?? preset?.binary;
    if (!binary) {
      throw new Error(`external agent "${this.opts.agent}" has no built-in invocation; set binaryPath`);
    }
    const extra = this.opts.extraArgs ?? [];
    let args: string[];
    if (preset) {
      args = [...preset.args, ...extra, goal];
    } else if (extra.includes("{goal}")) {
      args = extra.map((a) => (a === "{goal}" ? goal : a));
    } else {
      args = [...extra, goal];
    }
    const env: Record<string, string> = { ...this.opts.env };
    if (this.opts.apiKey) {
      const keyEnv = this.opts.apiKeyEnv ?? preset?.apiKeyEnv;
      if (!keyEnv) throw new Error(`external agent "${this.opts.agent}": apiKey requires apiKeyEnv`);
      env[keyEnv] = this.opts.apiKey;
    }
    return { binary, args, env };
  }

  async spawn(request: SubagentSpawnRequest, _parent?: ExecutionContext): Promise<SubagentHandle> {
    if (request.continuable) {
      throw new Error("external subagents are one-shot; continuable sessions are not supported");
    }
    const { binary, args, env } = this.invocation(request.goal);
    const subagentId = newDelegationId();
    const providerRunId = newRunId();
    const timeoutMs = this.opts.timeoutMs ?? 15 * 60_000;
    const maxOutputBytes = this.opts.maxOutputBytes ?? 1024 * 1024;

    let state: SubagentState = "running";
    let rejectRun: (e: Error) => void = () => {};
    const child = spawn(binary, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(subagentId, child);

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    };

    const promise = new Promise<SubagentResult>((resolve, reject) => {
      rejectRun = reject;
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let truncated = false;
      let stderrTail = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const room = maxOutputBytes - stdoutBytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (kept.length < chunk.length) truncated = true;
        stdout.push(kept);
        stdoutBytes += kept.length;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
      });

      const timer = setTimeout(() => {
        state = "failed";
        terminate();
        reject(new Error(`external agent timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();

      child.on("error", (err) => {
        clearTimeout(timer);
        if (state === "running") state = "failed";
        reject(new Error(`failed to start external agent "${binary}": ${err.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(subagentId);
        if (state !== "running") return;
        const output = Buffer.concat(stdout).toString("utf8");
        const ok = code === 0;
        state = ok ? "completed" : "failed";
        resolve({
          subagentId,
          status: ok ? "completed" : "failed",
          output,
          error: ok
            ? undefined
            : `exit code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}: ${stderrTail.trim()}`,
          metadata: { agent: this.opts.agent, exitCode: code, truncated },
        });
      });
    });
    promise.catch(() => {});

    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "external",
      continuable: false,
      get state() {
        return state;
      },
      set state(next: SubagentState) {
        state = next;
      },
      request,
      promise,
      async send(): Promise<SubagentResult> {
        throw new Error("one-shot external subagent does not support send() — spawn a new one");
      },
      async interrupt(reason?: string): Promise<void> {
        if (state !== "running") return;
        state = "cancelled";
        terminate();
        rejectRun(new Error(reason ?? "interrupted"));
      },
      async resume(): Promise<SubagentResult> {
        throw new Error("one-shot external subagent cannot be resumed");
      },
      fork: async (): Promise<SubagentHandle> =>
        this.spawn({ ...request, goal: `${request.goal} (forked from ${subagentId})` }, _parent),
    };

    this.handles.set(subagentId, handle);
    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        await handle.interrupt("host shutdown");
      }
    }
  }
}

export interface DefaultSubagentProvidersOptions extends InProcessProviderOptions {
  /** Register the process provider (spawns `<binaryPath> rpc`). */
  process?: ProcessProviderOptions;
  /** Register the HTTP task provider (requires an endpoint). */
  acp?: AcpProviderOptions;
  /** Register the SDK provider (requires a runtimeFactory). */
  sdk?: SdkProviderOptions;
  /** Register the external agent provider. */
  external?: ExternalAgentProviderOptions;
}

/**
 * Providers that can actually execute. In-process is always available; the
 * others are registered only when configured, so listProviders() never
 * advertises a backend that would fail on first spawn for lack of wiring.
 */
export function defaultSubagentProviders(opts: DefaultSubagentProvidersOptions): SubagentProvider[] {
  const providers: SubagentProvider[] = [new InProcessSubagentProvider(opts)];
  if (opts.process) providers.push(new ProcessSubagentProvider(opts.process));
  if (opts.acp?.endpoint) providers.push(new ACPSubagentProvider(opts.acp));
  if (opts.sdk?.runtimeFactory) providers.push(new SDKSubagentProvider(opts.sdk));
  if (opts.external) providers.push(new ExternalAgentSubagentProvider(opts.external));
  return providers;
}
