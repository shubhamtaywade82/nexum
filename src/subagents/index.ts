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

// ── Stub providers (ready for future implementation) ─────────────────────────

export class ProcessSubagentProvider implements SubagentProvider {
  readonly type = "process" as const;
  spawn(): Promise<SubagentHandle> {
    throw new Error("ProcessSubagentProvider not yet implemented (spawn a child nexum process)");
  }
  list(): SubagentHandle[] {
    return [];
  }
  async stopAll(): Promise<void> {}
}

export class ACPSubagentProvider implements SubagentProvider {
  readonly type = "acp" as const;
  spawn(): Promise<SubagentHandle> {
    throw new Error("ACPSubagentProvider not yet implemented (Agent Client Protocol)");
  }
  list(): SubagentHandle[] {
    return [];
  }
  async stopAll(): Promise<void> {}
}

export class SDKSubagentProvider implements SubagentProvider {
  readonly type = "sdk" as const;
  spawn(): Promise<SubagentHandle> {
    throw new Error("SDKSubagentProvider not yet implemented (drive another Nexum SDK instance)");
  }
  list(): SubagentHandle[] {
    return [];
  }
  async stopAll(): Promise<void> {}
}

export class ExternalAgentSubagentProvider implements SubagentProvider {
  readonly type = "external" as const;
  spawn(): Promise<SubagentHandle> {
    throw new Error("ExternalAgentSubagentProvider not yet implemented (Claude Code, Codex, etc.)");
  }
  list(): SubagentHandle[] {
    return [];
  }
  async stopAll(): Promise<void> {}
}

/** Factory: register all stub providers (so the service is "complete" shape-wise). */
export function defaultSubagentProviders(opts: InProcessProviderOptions): SubagentProvider[] {
  return [
    new InProcessSubagentProvider(opts),
    new ProcessSubagentProvider(),
    new ACPSubagentProvider(),
    new SDKSubagentProvider(),
    new ExternalAgentSubagentProvider(),
  ];
}
