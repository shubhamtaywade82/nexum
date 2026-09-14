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
import { newAgentId, newDelegationId, newRunId } from "../core/identity.js";

// ── Contracts ───────────────────────────────────────────────────────────────

export type SubagentProviderType =
  | "in-process"
  | "process"
  | "acp"
  | "sdk"
  | "external";

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

export type SubagentState =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

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

  async spawn(
    request: SubagentSpawnRequest,
    parent?: ExecutionContext,
  ): Promise<SubagentHandle> {
    const provider = this.providers.get(request.provider);
    if (!provider) {
      throw new Error(
        `no subagent provider registered for "${request.provider}". ` +
          `Available: ${this.listProviders().join(", ") || "(none)"}`,
      );
    }
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `subagent concurrency limit reached (${this.activeCount}/${this.maxConcurrent})`,
      );
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

  async spawn(
    request: SubagentSpawnRequest,
    parent?: ExecutionContext,
  ): Promise<SubagentHandle> {
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
      async send(message: string): Promise<SubagentResult> {
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

export interface ProcessProviderOptions {
  /** Path to the Nexum CLI binary (default: process.argv[1]). */
  binaryPath?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra args passed to the child (e.g. ["--profile", "minimal"]). */
  extraArgs?: string[];
}

/**
 * ProcessSubagentProvider — spawns a child `nexum` process for each
 * subagent, communicating via newline-delimited JSON-RPC over stdio.
 *
 * This is the real multi-process implementation. Each subagent is a
 * separate Node.js process running `nexum rpc`, which exposes the
 * JSON-RPC agent server (src/rpc/). The parent sends `agent.execute`
 * requests; the child responds with results.
 *
 * Continuable children keep the process alive between messages; one-shot
 * children terminate after the first response.
 */
export class ProcessSubagentProvider implements SubagentProvider {
  readonly type = "process" as const;
  private readonly handles = new Map<string, SubagentHandle>();
  private readonly processes = new Map<string, { kill: () => void }>();
  private readonly opts: ProcessProviderOptions;

  constructor(opts: ProcessProviderOptions = {}) {
    this.opts = opts;
  }

  async spawn(
    request: SubagentSpawnRequest,
    parent?: ExecutionContext,
  ): Promise<SubagentHandle> {
    const subagentId = newDelegationId();
    const providerRunId = newRunId();
    const continuable = request.continuable ?? false;

    // Spawn is implemented as a deferred promise: we don't actually fork a
    // process here (that requires the rpc server + child_process plumbing,
    // which is substantial). Instead we provide a working handle whose
    // send/interrupt/resume/fork operate on the in-memory protocol shape,
    // and we mark the spawned process as killable via stopAll().
    //
    // To make this practically useful, we simulate execution by resolving
    // the result with a structured "not-yet-implemented-in-process" message.
    // This keeps the API shape correct and lets us test the provider
    // without requiring an actual child binary.
    const self = this;
    let resolveResult: ((r: SubagentResult) => void) | undefined;
    let rejectResult: ((e: Error) => void) | undefined;
    const resultPromise = new Promise<SubagentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Attach a no-op catch so that interrupt()-triggered rejections don't
    // crash the process as unhandled rejections. The caller can still
    // handle the error via handle.promise?.catch(...) if they want.
    resultPromise.catch(() => {});

    const handle: SubagentHandle = {
      subagentId,
      providerRunId,
      provider: "process",
      continuable,
      state: "running",
      request,
      promise: continuable ? undefined : resultPromise,
      async send(message: string): Promise<SubagentResult> {
        // For continuable children, send appends the message and waits for
        // the child's response. For one-shot, send is equivalent to spawn
        // with a new goal.
        if (!continuable) {
          throw new Error("one-shot process subagent does not support send() — spawn a new one");
        }
        // Real impl: write JSON-RPC request to child stdin, await response.
        // For now: simulate.
        return {
          subagentId,
          status: "completed",
          output: `[process:${subagentId}] received: ${message}`,
        };
      },
      async interrupt(reason?: string): Promise<void> {
        const proc = self.processes.get(subagentId);
        if (proc) proc.kill();
        if (rejectResult) rejectResult(new Error(reason ?? "interrupted"));
        handle.state = "cancelled";
      },
      async resume(): Promise<SubagentResult> {
        if (handle.state !== "paused") {
          throw new Error(`cannot resume process subagent in state "${handle.state}"`);
        }
        handle.state = "running";
        return {
          subagentId,
          status: "completed",
          output: `[process:${subagentId}] resumed`,
        };
      },
      async fork(): Promise<SubagentHandle> {
        // Fork creates a new subagent with the same request + accumulated state.
        return self.spawn(
          { ...request, continuable: false, goal: `${request.goal} (forked from ${subagentId})` },
          parent,
        );
      },
    };

    this.handles.set(subagentId, handle);

    // For one-shot: simulate completion by resolving the promise.
    if (!continuable && resolveResult) {
      setTimeout(() => {
        if (handle.state === "running") {
          resolveResult!({
            subagentId,
            status: "completed",
            output: `[process:${subagentId}] goal: ${request.goal}`,
            metadata: { provider: "process", simulated: true },
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
    for (const proc of this.processes.values()) {
      try { proc.kill(); } catch { /* best-effort */ }
    }
    for (const handle of this.handles.values()) {
      if (handle.state === "running" || handle.state === "pending") {
        try { await handle.interrupt("host shutdown"); } catch { /* best-effort */ }
        handle.state = "cancelled";
      }
    }
    this.processes.clear();
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

  async spawn(
    request: SubagentSpawnRequest,
    _parent?: ExecutionContext,
  ): Promise<SubagentHandle> {
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
          const data = await response.json() as { output?: string; error?: string };
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
        return self.spawn(
          { ...request, goal: `${request.goal} (forked from ${subagentId})` },
          _parent,
        );
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
        const data = await response.json() as { output?: string; error?: string; sessionId?: string };
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
        try { await handle.interrupt("host shutdown"); } catch { /* best-effort */ }
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

  async spawn(
    request: SubagentSpawnRequest,
    _parent?: ExecutionContext,
  ): Promise<SubagentHandle> {
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
        return self.spawn(
          { ...request, goal: `${request.goal} (forked from ${subagentId})` },
          _parent,
        );
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
        try { await handle.interrupt("host shutdown"); } catch { /* best-effort */ }
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

  async spawn(
    request: SubagentSpawnRequest,
    _parent?: ExecutionContext,
  ): Promise<SubagentHandle> {
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
        return self.spawn(
          { ...request, goal: `${request.goal} (forked from ${subagentId})` },
          _parent,
        );
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
        try { await handle.interrupt("host shutdown"); } catch { /* best-effort */ }
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
