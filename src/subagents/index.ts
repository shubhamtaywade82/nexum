/**
 * Formal SubagentService — multi-provider subagent management.
 *
 * Nexum already has a Delegator (orchestration/delegation/delegator.ts) that
 * handles in-process child execution. This service generalizes it to support
 * multiple provider backends (DeepSeek Harness-style):
 *
 *   InProcessProvider     ← wraps the existing Delegator
 *   ProcessProvider       ← spawns a child Nexum process
 *   ACPProvider           ← HTTP task API (Nexum-specific, not the ACP wire protocol)
 *   SDKProvider           ← drives another Nexum SDK instance
 *   ExternalAgentProvider ← runs an external agent CLI (Claude Code, Codex, …)
 *
 * All providers implement the same SubagentProvider interface, so the agent
 * sees a uniform spawn/send/interrupt/resume/fork/inspect API regardless of
 * where the child actually runs. Lifecycle state lives in SubagentSession
 * (session.ts): every provider reports through it, so a terminal state never
 * changes and every child frees its slot when its session terminates.
 *
 * Continuable children: a child session can be paused and resumed later with
 * new messages or interruptions. This is critical for long-running autonomous
 * agents that need to interact with subagents over multiple turns.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentRuntime, ExecutionContext } from "../core/types.js";
import type { AgentRegistry } from "../runtime/agent/agent-runtime.js";
import { Delegator, type DelegationPolicy } from "../orchestration/delegation/delegator.js";
import type {
  SubagentHandle,
  SubagentProvider,
  SubagentProviderType,
  SubagentResult,
  SubagentSpawnRequest,
  SubagentState,
} from "./contracts.js";
import { SubagentSession, isLiveState } from "./session.js";

export * from "./contracts.js";

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

    // Every child frees its slot when its session reaches a terminal state, whether it
    // finished, failed, was cancelled, or (for a continuable child) its process died.
    const release = () => this.release(handle.subagentId);
    void handle.terminated.then(release);

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

  /** Cancel a specific subagent. Terminal children are left exactly as they ended. */
  async cancel(subagentId: string, reason?: string): Promise<void> {
    const handle = this.handles.get(subagentId);
    if (!handle) return;
    try {
      await handle.interrupt(reason ?? "cancelled by parent");
    } finally {
      this.release(subagentId);
    }
  }

  /** Stop all subagents (host shutdown). */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.providers.values()].map((p) => p.stopAll()));
    for (const handle of this.handles.values()) {
      this.release(handle.subagentId);
    }
    this.perSessionCount.clear();
  }
}

// ── Shared provider bookkeeping ─────────────────────────────────────────────

/**
 * What every provider shares: the handles it spawned, and a shutdown that
 * interrupts only the children that are still live.
 */
abstract class BaseSubagentProvider implements SubagentProvider {
  abstract readonly type: SubagentProviderType;
  protected readonly handles = new Map<string, SubagentHandle>();

  abstract spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle>;

  protected track(handle: SubagentHandle): SubagentHandle {
    this.handles.set(handle.subagentId, handle);
    return handle;
  }

  list(): SubagentHandle[] {
    return [...this.handles.values()];
  }

  async stopAll(): Promise<void> {
    for (const handle of this.handles.values()) {
      if (!isLiveState(handle.state)) continue;
      try {
        await handle.interrupt("host shutdown");
      } catch {
        /* best-effort: shutdown must reach every child */
      }
    }
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
  const session = new SubagentSession({ provider: type, request, providerRunId: child.childRunId });

  // The child settles the handle with its real result; a child that honours a cancel reports "cancelled".
  void child.promise.then(
    (result) =>
      session.complete({
        subagentId: session.subagentId,
        status: result.status,
        output: result.output,
        error: result.error,
        metadata: { runId: result.runId, agentId: result.agentId, usage: result.usage },
      }),
    (e: unknown) => session.fail(e instanceof Error ? e : new Error(String(e))),
  );

  return session.toHandle({
    async send(): Promise<SubagentResult> {
      throw new Error(`one-shot ${type} subagent does not support send() — spawn a new one`);
    },
    async interrupt(): Promise<void> {
      // The runtime reports the cancelled result, so the one-shot promise settles with it.
      if (!session.markCancelled()) return;
      child.cancel();
    },
    async resume(): Promise<SubagentResult> {
      throw new Error(`one-shot ${type} subagent cannot be resumed`);
    },
    fork: () => respawn({ ...request, goal: `${request.goal} (forked from ${session.subagentId})` }),
  });
}

/**
 * InProcessSubagentProvider — one-shot children executed by the parent's
 * AgentRuntime via the Delegator (capability matching, derived budget,
 * cancellation). Requires the parent ExecutionContext.
 */
export class InProcessSubagentProvider extends BaseSubagentProvider {
  readonly type = "in-process" as const;
  private readonly delegator: Delegator;

  constructor(opts: InProcessProviderOptions) {
    super();
    this.delegator = new Delegator({ runtime: opts.runtime, agents: opts.agents });
  }

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    return this.track(spawnDelegated("in-process", this.delegator, request, parent, (r) => this.spawn(r, parent)));
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
  /** Spawned subprocess env (defaults to process.env). */
  env?: Record<string, string>;
  /** Timeout for child startup (ms, default 5000). */
  startupTimeoutMs?: number;
}

interface PendingRpc {
  resolve: (r: SubagentResult) => void;
  reject: (e: Error) => void;
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
 *   - Child process exits before responding → the session fails with the exit code
 *   - Parent calls interrupt() → the session is cancelled and the child is stopped
 *   - Continuable child dies while live → its session fails, freeing its slot
 *   - Child stderr output → captured as `metadata.stderr` in SubagentResult
 */
export class ProcessSubagentProvider extends BaseSubagentProvider {
  readonly type = "process" as const;
  private readonly children = new Map<string, ChildProcess>();
  private readonly opts: ProcessProviderOptions;

  constructor(opts: ProcessProviderOptions = {}) {
    super();
    this.opts = opts;
  }

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    const continuable = request.continuable ?? false;
    const binaryPath = this.opts.binaryPath ?? process.argv[1];
    if (!binaryPath) {
      throw new Error("ProcessSubagentProvider: no binaryPath and no process.argv[1]");
    }

    const session = new SubagentSession({ provider: "process", request, continuable });
    const subagentId = session.subagentId;

    // `nexum rpc` is the JSON-RPC agent server. Continuable children stay alive between
    // messages; one-shot children exit after their first response.
    const child = spawn(binaryPath, ["rpc", ...(this.opts.extraArgs ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
    });
    this.children.set(subagentId, child);

    const pendingRequests = new Map<number | string | null, PendingRpc>();
    let nextRequestId = 1;
    const rejectPending = (error: Error): void => {
      for (const [id, pending] of pendingRequests) {
        pendingRequests.delete(id);
        pending.reject(error);
      }
    };

    // Stream errors must not crash the host: an EPIPE from a child that already exited is expected.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") session.fail(new Error(`stdin error: ${err.message}`));
    });
    child.stdout?.on("error", () => {
      /* best-effort — stdout closed */
    });
    child.stderr?.on("error", () => {
      /* best-effort — stderr closed */
    });
    child.on("error", (err) => {
      this.children.delete(subagentId);
      session.fail(new Error(`child spawn error: ${err.message}`));
    });

    const stderrBuffer: string[] = [];
    let stdoutBuffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        let msg: {
          id?: number | string | null;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not JSON — skip
        }
        if (msg.id === undefined) continue;
        const pending = pendingRequests.get(msg.id);
        if (!pending) continue;
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
          continue;
        }
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
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer.push(chunk);
    });

    // 'close' rather than 'exit': it fires after stdout is drained, so a response written just before
    // the child exits is still delivered instead of racing the exit.
    child.on("close", (code, signal) => {
      this.children.delete(subagentId);
      const reason = new Error(`child process exited (code=${code}, signal=${signal})`);
      rejectPending(reason);
      // A session still live when its child goes away can no longer be served.
      session.fail(reason);
    });

    // Every terminal transition stops the child, including a failed one.
    void session.terminated.then(() => this.stopChild(subagentId));

    const send = async (message: string): Promise<SubagentResult> => {
      if (!continuable) {
        throw new Error("one-shot process subagent does not support send() — spawn a new one");
      }
      const proc = this.children.get(subagentId);
      if (!session.live || !proc) {
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
        pendingRequests.set(requestId, { resolve, reject });
        try {
          proc.stdin?.write(`${JSON.stringify(payload)}\n`);
        } catch (err) {
          pendingRequests.delete(requestId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    };

    if (!continuable) {
      // One-shot: the first (and only) request carries the goal; its response settles the session.
      const requestId = nextRequestId++;
      pendingRequests.set(requestId, {
        resolve: (r) => session.complete(r),
        reject: (e) => session.fail(e),
      });
      const payload = {
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
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        session.fail(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return this.track(
      session.toHandle({
        send,
        async interrupt(reason = "interrupted"): Promise<void> {
          if (!session.cancel(reason)) return;
          rejectPending(new Error(reason));
        },
        async resume(): Promise<SubagentResult> {
          if (session.state !== "paused") {
            throw new Error(`cannot resume process subagent in state "${session.state}"`);
          }
          session.markRunning();
          return send("resume");
        },
        fork: () =>
          this.spawn({ ...request, continuable: false, goal: `${request.goal} (forked from ${subagentId})` }, parent),
      }),
    );
  }

  /** SIGTERM, escalating to SIGKILL after 2 s. Idempotent: a child that already exited is left alone. */
  private stopChild(subagentId: string): void {
    const child = this.children.get(subagentId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    escalate.unref();
    child.once("exit", () => clearTimeout(escalate));
  }

  /** Stops every live handle, then waits for each child process to actually exit. */
  override async stopAll(): Promise<void> {
    await super.stopAll();
    const exits: Promise<void>[] = [];
    for (const [subagentId, child] of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      exits.push(new Promise<void>((resolve) => child.once("exit", () => resolve())));
      this.stopChild(subagentId);
    }
    await Promise.allSettled(exits);
  }
}

// ── ACP provider (Nexum-specific HTTP task API) ─────────────────────────────

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
 *
 * A one-shot task is posted in the background: spawn() returns the handle at once,
 * like the other providers, and its promise settles with the server's answer.
 */
export class ACPSubagentProvider extends BaseSubagentProvider {
  readonly type = "acp" as const;
  private readonly opts: AcpProviderOptions;

  constructor(opts: AcpProviderOptions = {}) {
    super();
    this.opts = opts;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.opts.authToken ? { Authorization: `Bearer ${this.opts.authToken}` } : {}),
    };
  }

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    const endpoint = this.opts.endpoint;
    if (!endpoint) {
      throw new Error("ACPSubagentProvider requires an endpoint (set via AcpProviderOptions.endpoint)");
    }
    const continuable = request.continuable ?? false;
    const session = new SubagentSession({ provider: "acp", request, continuable });
    const acpSessionId = `acp_${session.subagentId}`;
    const headers = this.headers();

    const send = async (message: string): Promise<SubagentResult> => {
      try {
        const response = await fetch(`${endpoint}/sessions/${acpSessionId}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ message }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { output?: string; error?: string };
        return {
          subagentId: session.subagentId,
          status: data.error ? "failed" : "completed",
          output: data.output ?? "",
          error: data.error,
          metadata: { acpSessionId },
        };
      } catch (err) {
        return {
          subagentId: session.subagentId,
          status: "failed",
          output: "",
          error: err instanceof Error ? err.message : String(err),
          metadata: { acpSessionId },
        };
      }
    };

    const handle = this.track(
      session.toHandle({
        send,
        async interrupt(reason = "interrupted"): Promise<void> {
          if (!session.cancel(reason)) return;
          try {
            await fetch(`${endpoint}/sessions/${acpSessionId}/cancel`, {
              method: "POST",
              headers,
              body: JSON.stringify({ reason }),
            });
          } catch {
            /* best-effort: the local session is already cancelled */
          }
        },
        async resume(): Promise<SubagentResult> {
          if (session.state !== "paused") {
            throw new Error(`cannot resume ACP subagent in state "${session.state}"`);
          }
          session.markRunning();
          return send("resume");
        },
        fork: () => this.spawn({ ...request, goal: `${request.goal} (forked from ${session.subagentId})` }, parent),
      }),
    );

    if (!continuable) {
      void fetch(`${endpoint}/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          goal: request.goal,
          requiredCapabilities: request.requiredCapabilities,
          contextHandoff: request.contextHandoff,
        }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}/tasks`);
          const data = (await response.json()) as { output?: string; error?: string; sessionId?: string };
          session.complete({
            subagentId: session.subagentId,
            status: data.error ? "failed" : "completed",
            output: data.output ?? "",
            error: data.error,
            metadata: { acpSessionId: data.sessionId ?? acpSessionId },
          });
        })
        .catch((err: unknown) => session.fail(err instanceof Error ? err : new Error(String(err))));
    }

    return handle;
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
export class SDKSubagentProvider extends BaseSubagentProvider {
  readonly type = "sdk" as const;
  private readonly opts: SdkProviderOptions;

  constructor(opts: SdkProviderOptions = {}) {
    super();
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
    return this.track(spawnDelegated("sdk", delegator, request, parent, (r) => this.spawn(r, parent)));
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
export class ExternalAgentSubagentProvider extends BaseSubagentProvider {
  readonly type = "external" as const;
  private readonly children = new Map<string, ChildProcess>();
  private readonly opts: ExternalAgentProviderOptions;

  constructor(opts: ExternalAgentProviderOptions) {
    super();
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

  async spawn(request: SubagentSpawnRequest, parent?: ExecutionContext): Promise<SubagentHandle> {
    if (request.continuable) {
      throw new Error("external subagents are one-shot; continuable sessions are not supported");
    }
    const { binary, args, env } = this.invocation(request.goal);
    const timeoutMs = this.opts.timeoutMs ?? 15 * 60_000;
    const maxOutputBytes = this.opts.maxOutputBytes ?? 1024 * 1024;
    const session = new SubagentSession({ provider: "external", request });

    const child = spawn(binary, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(session.subagentId, child);

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    };
    // Any terminal transition (cancel, timeout, start failure, normal exit) leaves no process behind.
    void session.terminated.then(terminate);

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
      session.fail(new Error(`external agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      this.children.delete(session.subagentId);
      session.fail(new Error(`failed to start external agent "${binary}": ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      this.children.delete(session.subagentId);
      if (!session.live) return;
      const ok = code === 0;
      session.complete({
        subagentId: session.subagentId,
        status: ok ? "completed" : "failed",
        output: Buffer.concat(stdout).toString("utf8"),
        error: ok
          ? undefined
          : `exit code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}: ${stderrTail.trim()}`,
        metadata: { agent: this.opts.agent, exitCode: code, truncated },
      });
    });

    return this.track(
      session.toHandle({
        async send(): Promise<SubagentResult> {
          throw new Error("one-shot external subagent does not support send() — spawn a new one");
        },
        async interrupt(reason = "interrupted"): Promise<void> {
          session.cancel(reason);
        },
        async resume(): Promise<SubagentResult> {
          throw new Error("one-shot external subagent cannot be resumed");
        },
        fork: () => this.spawn({ ...request, goal: `${request.goal} (forked from ${session.subagentId})` }, parent),
      }),
    );
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
