/**
 * Subagent contracts shared by the service, the providers and their hosts.
 * Runtime behaviour lives in session.ts (lifecycle) and index.ts (service and providers).
 */

import type { ExecutionContext, ExecutionResult } from "../core/types.js";

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

export type SubagentState = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface SubagentResult {
  subagentId: string;
  status: ExecutionResult["status"];
  output: string;
  error?: string;
  /** Provider-specific metadata (token usage, cost, duration). */
  metadata?: Record<string, unknown>;
}

/** The behaviour a provider attaches to a handle; the lifecycle state is owned by the session. */
export interface SubagentHandleOps {
  /** Send a new message to a continuable child. */
  send(message: string): Promise<SubagentResult>;
  /** Interrupt a live child (graceful). No-op once the child is terminal. */
  interrupt(reason?: string): Promise<void>;
  /** Resume a paused child. */
  resume(): Promise<SubagentResult>;
  /** Fork the child into a new independent session. */
  fork(): Promise<SubagentHandle>;
}

export interface SubagentHandle extends SubagentHandleOps {
  /** Unique id for this spawned subagent. */
  subagentId: string;
  /** The delegation/run id assigned by the provider. */
  providerRunId: string;
  /** Which provider is hosting this child. */
  provider: SubagentProviderType;
  /** Whether the child is continuable (persistent session). */
  continuable: boolean;
  /** Current lifecycle state. Read-only: only the owning session transitions it. */
  readonly state: SubagentState;
  /** Resolves once, with the terminal state, for every session kind. Never rejects. */
  readonly terminated: Promise<SubagentState>;
  /** The original spawn request (for inspection). */
  request: SubagentSpawnRequest;
  /** Settles when a one-shot child completes; undefined for continuable children. */
  promise?: Promise<SubagentResult>;
}

/**
 * Provider interface — each backend implements this.
 * The service routes spawn() to the right provider based on request.provider.
 */
export interface SubagentProvider {
  readonly type: SubagentProviderType;
  spawn(request: SubagentSpawnRequest, parent: ExecutionContext | undefined): Promise<SubagentHandle>;
  /** List children this provider spawned (for inspect()). */
  list(): SubagentHandle[];
  /** Stop all live children for this provider (host shutdown). */
  stopAll(): Promise<void>;
}
