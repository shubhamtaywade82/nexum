/**
 * DefaultAgentRuntime — the kernel facade tying everything together.
 *
 * Implements the review's recommended core API (§24):
 *
 *   AgentRuntime.execute(request, context) → Promise<ExecutionResult>
 *
 * The runtime owns:
 *   - the agent registry (which agents exist, their default strategies,
 *     allowed capabilities, and mounted tool packs)
 *   - the strategy registry (react / plan_execute / graph / workflow)
 *   - execution bookkeeping (active runs, cancellation handles)
 *
 * It delegates policy to the PolicyEngine inside the ToolGateway, model
 * calls to the ModelGateway, and never touches a concrete tool, provider,
 * or domain directly.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentRuntime,
  ExecutionRequest,
  ExecutionResult,
  ExecutionContext,
  StrategyExecuteOptions,
  StrategyName,
} from "../../core/types.js";
import { ExecutionStrategy } from "../strategies/execution-strategy.js";
import { ReActStrategy, type CriticPolicy } from "../strategies/execution-strategy.js";
import { PlanExecuteStrategy } from "../strategies/plan-execute-strategy.js";
import { GraphStrategy } from "../strategies/graph-strategy.js";
import { GateRegistry } from "../../core/concurrency/gate-registry.js";
import { CancellationRegistry, CancellationScope } from "../../core/cancellation/cancellation.js";
import type { RunRecorder } from "../persistence/execution-recorder.js";

// ── Agent registry (capability-driven, review item 24) ─────────────────────

/**
 * What an agent DECLARES about itself. Delegation is capability-driven:
 * the Delegator matches DelegationRequest.requiredCapabilities against
 * these declarations instead of hard-coded agent names.
 */
export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  /** Model-routing capability used for this agent's turns. */
  defaultCapability: "coding" | "vision" | "reasoning" | "quick" | "tools" | "agentic";
  defaultStrategy: StrategyName;
  /** Tool-pack ids this agent may use (capability scoping). */
  allowedPackIds?: string[];
  /** Capability tags used for tool discovery filtering AND delegation matching. */
  capabilities?: string[];
  description?: string;

  // ── review item 24: formal capability declaration ──────────────────────
  /** Tool ids the agent cannot run without (checked before execution). */
  requiredTools?: string[];
  /** Policy posture names this agent accepts (e.g. ["standard", "restricted"]). */
  allowedPolicies?: string[];
  /** Strategies this agent supports (execution strategy negotiation). */
  supportedStrategies?: StrategyName[];
  /** Model ids / capability tags this agent can run on (routing constraint). */
  supportedModels?: string[];
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentDescriptor>();

  register(descriptor: AgentDescriptor): this {
    this.agents.set(descriptor.id, descriptor);
    return this;
  }

  get(id: AgentId): AgentDescriptor | undefined {
    return this.agents.get(id);
  }

  require(id: AgentId): AgentDescriptor {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(
        `unknown agent "${id}". Registered agents: ${[...this.agents.keys()].sort().join(", ") || "(none)"}`,
      );
    }
    return agent;
  }

  ids(): AgentId[] {
    return [...this.agents.keys()];
  }

  all(): AgentDescriptor[] {
    return [...this.agents.values()];
  }

  /** Capability-driven selection (review item 24): agents whose declared
   *  capabilities satisfy the required set, tightest overlap first. */
  selectFor(required: string[]): AgentDescriptor[] {
    if (required.length === 0) return this.all();
    const scored = this.all()
      .map((agent) => {
        const caps = new Set(agent.capabilities ?? []);
        const missing = required.filter((r) => !caps.has(r));
        const overlap = required.length - missing.length;
        return { agent, missing, overlap };
      })
      .filter((s) => s.missing.length === 0);
    scored.sort((a, b) => b.overlap - a.overlap);
    return scored.map((s) => s.agent);
  }

  /** Does the agent satisfy strategy + model constraints? */
  supports(descriptor: AgentDescriptor, opts: { strategy?: StrategyName; model?: string }): boolean {
    if (opts.strategy && descriptor.supportedStrategies && !descriptor.supportedStrategies.includes(opts.strategy)) {
      return false;
    }
    if (
      opts.model &&
      descriptor.supportedModels &&
      descriptor.supportedModels.length > 0 &&
      !descriptor.supportedModels.some((m) => m === opts.model || opts.model?.includes(m))
    ) {
      return false;
    }
    return true;
  }
}

// ── Strategy registry ───────────────────────────────────────────────────────

export class StrategyRegistry {
  private readonly strategies = new Map<StrategyName, ExecutionStrategy>();

  register(strategy: ExecutionStrategy): this {
    this.strategies.set(strategy.name, strategy);
    return this;
  }

  get(name: StrategyName): ExecutionStrategy | undefined {
    return this.strategies.get(name);
  }

  require(name: StrategyName): ExecutionStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`unknown execution strategy "${name}". Registered: ${[...this.strategies.keys()].join(", ")}`);
    }
    return strategy;
  }

  names(): StrategyName[] {
    return [...this.strategies.keys()];
  }
}

export function defaultStrategyRegistry(): StrategyRegistry {
  return new StrategyRegistry()
    .register(new ReActStrategy())
    .register(new PlanExecuteStrategy())
    .register(new GraphStrategy());
}

// ── Runtime ─────────────────────────────────────────────────────────────────

export interface DefaultAgentRuntimeOptions {
  strategies?: StrategyRegistry;
  gates?: GateRegistry;
  /** Max tool turns applied when neither the request nor the agent specifies one. */
  defaultMaxToolTurns?: number;
  /**
   * Durable history (review item 13): when supplied, every run is recorded
   * (run.started / terminal run.* events + a RunRecord in the index) and
   * every event the strategy publishes through it is persisted.
   */
  recorder?: (context: ExecutionContext) => RunRecorder;
  /** Shared cancellation registry (review item 16); one is created when omitted. */
  cancellation?: CancellationRegistry;
  /**
   * In-loop critic for final answers (runtime/critic): critique → revise
   * weak answers inside the same execution. Opt-in at the kernel level so
   * embedders keep exact model-call accounting; product compositions
   * (DevAgent) enable it by default.
   */
  critic?: CriticPolicy;
}

export class DefaultAgentRuntime implements AgentRuntime {
  readonly agents = new AgentRegistry();
  readonly strategies: StrategyRegistry;
  readonly gates: GateRegistry;
  readonly cancellation: CancellationRegistry;

  private readonly defaultMaxToolTurns: number;
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly recorderFactory?: (context: ExecutionContext) => RunRecorder;
  private readonly criticPolicy?: CriticPolicy;

  constructor(opts: DefaultAgentRuntimeOptions = {}) {
    this.strategies = opts.strategies ?? defaultStrategyRegistry();
    this.gates = opts.gates ?? new GateRegistry();
    this.defaultMaxToolTurns = opts.defaultMaxToolTurns ?? 64;
    this.recorderFactory = opts.recorder;
    this.cancellation = opts.cancellation ?? new CancellationRegistry();
    this.criticPolicy = opts.critic;
  }

  /**
   * Execute one task. The caller supplies the ExecutionContext (it owns the
   * gateways + context port). The runtime resolves the agent descriptor,
   * picks the strategy, runs under the agent-level concurrency gate, and
   * tracks the run for cancellation via `cancel(runId)`. Product-side
   * policies ride in through `options.hooks` (see strategy-hooks.ts).
   */
  async execute(
    request: ExecutionRequest,
    context: ExecutionContext,
    options?: StrategyExecuteOptions,
  ): Promise<ExecutionResult> {
    const agent = this.agents.require(request.agentId);
    const strategyName = request.strategy ?? agent.defaultStrategy;
    const strategy = this.strategies.require(strategyName);

    // durable recording (review items 13/33): one recorder per run; the
    // strategy publishes through it so events fan out live AND persist.
    const recorder = this.recorderFactory?.(context);
    const events = recorder ?? context.events;

    // Agent-level concurrency: one lease per product agent, so a burst of
    // user requests cannot fork-bomb the machine with parallel agent runs.
    const release = await this.gates.gate("agent", request.agentId).acquire("normal");
    const controller = new AbortController();
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.activeRuns.set(context.runId, controller);

    // cancellation scope registered for THIS run (review item 16): model
    // calls, tool calls, shell, MCP and children register under it and
    // cancel(runId) reaches all of them.
    const scope = new CancellationScope(`run:${context.runId}`, context.signal);
    const unregister = this.cancellation.register(context.runId, scope);

    recorder?.start(context.task.goal, request.agentId, strategyName);

    try {
      const result = await strategy.run({
        ctx: { ...context, agentId: request.agentId, signal: controller.signal, events },
        capability: agent.defaultCapability,
        maxToolTurns: options?.maxToolTurns ?? this.defaultMaxToolTurns,
        toolCapabilities: request.capabilities ?? agent.capabilities,
        hooks: options?.hooks,
        ...(this.criticPolicy ? { critic: this.criticPolicy } : {}),
      });
      recorder?.finish({
        status: result.status,
        output: result.output,
        error: result.error,
        usage: result.usage as unknown as Record<string, unknown>,
      });
      return result;
    } catch (e) {
      recorder?.finish({ status: "failed", error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      unregister();
      scope.dispose();
      this.activeRuns.delete(context.runId);
      release();
    }
  }

  /**
   * Cancel an active run by id: aborts the run's controller AND every
   * cancellation scope registered under the run (in-flight model calls,
   * tool calls, shell containers, MCP requests, browser actions, child
   * agents - review item 16).
   */
  cancel(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    const cancelledScopes = this.cancellation.cancel(runId, "cancelled by runtime");
    if (!controller) return cancelledScopes > 0;
    controller.abort();
    return true;
  }

  activeRunIds(): string[] {
    return [...this.activeRuns.keys()];
  }
}

/** Convenience factory: descriptor for the default coding agent. */
export function devAgentDescriptor(): AgentDescriptor {
  return {
    id: "devagent",
    displayName: "Nexum DevAgent",
    description: "Software-engineering agent: filesystem, git, tests, LSP, browser.",
    defaultCapability: "agentic",
    defaultStrategy: "react",
  };
}

export function runId(): string {
  return `run_${randomUUID()}`;
}
