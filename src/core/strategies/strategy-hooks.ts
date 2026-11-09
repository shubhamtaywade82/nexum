/**
 * StrategyHooks — the product-side port of the execution loop.
 *
 * Roadmap step 1 (docs/guide/kernel.md §Migration status): the ReAct loop
 * lived hard-coded inside `Agent.runUserMessage`, entangled with CLI-only
 * concerns — escalation (quick→cloud), streamed-output buffering, dynamic
 * tool selection, human approvals, learning telemetry. Those concerns are
 * *product policies*, not loop mechanics, but the loop cannot ignore them
 * either. The seam this module defines: the kernel strategy owns the loop
 * (turns, tool dispatch, observations, budgets, cancellation, nudges) and
 * delegates every product policy to an optional hook.
 *
 * A strategy MUST run correctly with zero hooks (headless default path:
 * model calls via ModelGateway, tools advertised via ToolGateway schemas).
 * Every hook is optional and individually skippable.
 *
 * Ownership contract for tool observations:
 *   - without `onToolObserved`, the strategy pushes the tool result into
 *     the context and runs its own loop detector;
 *   - with `onToolObserved`, the hook OWNS the observation — it decides
 *     how/whether the result is pushed (e.g. the CLI's compact
 *     PathEscapeError form) and returns { abortRun } when its loop policy
 *     fires. The strategy then never double-pushes.
 */

import type { ChatMessage, ChatResponse } from "../../models/adapters/provider.js";
import type { Capability } from "../../models/catalog.js";
import type { ToolResult } from "../tools/tool-contract.js";

/** Everything a hook needs to know about the current loop turn. */
export interface StrategyTurnInfo {
  /** 0-based tool turn (the loop safety counter). */
  turn: number;
  /** Capability the runtime resolved for this agent (advisory). */
  capability: Capability;
  /** The task input this run was started with. */
  userMessage: string;
  /** Current conversation window (read-only view). */
  messages: readonly ChatMessage[];
}

/** Model-call options a strategy hands to the `callModel` hook. */
export interface StrategyModelCallOptions {
  /** Tool schemas to advertise this turn (from selectTools, already filtered). */
  tools?: unknown[];
  stream?: boolean;
  /** Stream delta callback (kernel strategies pass it through to the product UI). */
  onChunk?: (chunk: ChatResponse) => void;
}

/** Result of the `prepareToolCall` hook: parsed args plus optional guidance. */
export interface PreparedToolCall {
  args: Record<string, unknown>;
  /** Guidance pushed as a system message before approval/execution. */
  guidance?: string;
}

/** A tool call whose execution failed (threw instead of returning). */
export interface ToolFailureInfo {
  name: string;
  error: Error;
  turn: number;
}

/**
 * Raised when the gateway's policy engine demands human confirmation for a
 * tool call (risk floor, financial side effects, arg-aware rules). The
 * strategy has NOT executed the call yet.
 */
export interface ConfirmationRequest {
  name: string;
  args: Record<string, unknown>;
  /** Human-readable reason from the policy decision (shown to the user). */
  reason: string;
  turn: number;
}

/** What a hook sees after a tool call completed (success or error record). */
export interface ToolObservation {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
  turn: number;
  /** Non-null when the raw arguments could not be parsed (call still ran). */
  parseError: string | null;
}

/** Action a tool-observation hook can request from the strategy. */
export interface ToolObservationAction {
  /** Terminate the run immediately after this observation. */
  abortRun?: boolean;
  /** Terminal tag surfaced on ExecutionResult.metadata.terminal (e.g. "loop_abort"). */
  terminal?: string;
  /** Overrides the run's output text when aborting (e.g. legacy "[aborted] ..." suffix). */
  output?: string;
}

/**
 * Product-side policies for one strategy run. All optional; a strategy must
 * run correctly with no hooks at all (headless default path).
 */
export interface StrategyHooks {
  /**
   * Restrict/replace the tools advertised this turn. Receives the gateway's
   * default schema list; return the final list (same shape or product-side
   * schemas when `callModel` is also implemented). Return undefined to keep
   * the defaults.
   */
  selectTools?(
    turn: StrategyTurnInfo,
    defaultSchemas: unknown[],
  ): Promise<unknown[] | undefined> | unknown[] | undefined;

  /**
   * Perform the model call for this turn. Implement this when the product
   * owns routing/streaming/verification (escalation policies, buffered
   * output, retries). Return the response; the strategy handles context
   * pushes, tool dispatch, budgets, and usage accounting.
   */
  callModel?(turn: StrategyTurnInfo, opts: StrategyModelCallOptions): Promise<ChatResponse>;

  /** Start-of-turn seam: pruning, status emission, per-turn bookkeeping. */
  onTurnStart?(turn: StrategyTurnInfo): void | Promise<void>;

  /** Emitted once per turn after the model responded (usage metering, UI). */
  onModelUsed?(info: { response: ChatResponse; elapsedMs: number; turn: number }): void;

  /**
   * Parse/normalize a model-issued tool call before approval and execution.
   * Return { args, guidance } — guidance is pushed as a system message.
   * Without this hook the strategy passes raw arguments to the gateway
   * (which decodes JSON itself).
   */
  prepareToolCall?(call: {
    name: string;
    rawArguments: unknown;
    turn: number;
  }): Promise<PreparedToolCall | undefined> | PreparedToolCall | undefined;

  /**
   * Approval/veto seam before the tool executes. Return false to reject —
   * the strategy skips execution and the hook owns the rejection
   * observation (tool-result message, telemetry). Return true/undefined to
   * proceed.
   */
  beforeToolCall?(call: {
    name: string;
    args: Record<string, unknown>;
    turn: number;
  }): Promise<boolean | undefined> | boolean | undefined;

  /**
   * Human-confirmation seam for gateway policy outcomes. When the policy
   * engine demands confirmation (risk floor, financial side effects,
   * arg-aware rules) the gateway returns a structured ConfirmationRequired
   * outcome instead of blocking. With this hook installed, the strategy asks
   * it: true → the call re-executes under `confirmed: true`; false → the
   * call becomes an "ApprovalRejected" observation and the run continues.
   * Without this hook (headless) the ConfirmationRequired outcome itself
   * becomes the observation — the model sees the denial and adapts.
   */
  resolveConfirmation?(request: ConfirmationRequest): Promise<boolean> | boolean;

  /**
   * Human-confirmation seam for gateway policy outcomes. When the policy
   * engine demands confirmation (risk floor, financial side effects,
   * arg-aware rules) the gateway returns a structured ConfirmationRequired
   * outcome instead of blocking. With this hook installed, the strategy asks
   * it: true → the call re-executes under `confirmed: true`; false → the
   * call becomes an "ApprovalRejected" observation and the run continues.
   * Without this hook (headless) the ConfirmationRequired outcome itself
   * becomes the observation — the model sees the denial and adapts.
   */
  resolveConfirmation?(request: ConfirmationRequest): Promise<boolean> | boolean;

  /**
   * Observation seam after a tool call completed. With this hook present
   * the strategy does NOT push the tool result into the context — the hook
   * owns how the observation is recorded. Return { abortRun: true } to
   * terminate the run (product loop detector fired).
   */
  onToolObserved?(obs: ToolObservation): Promise<ToolObservationAction | void> | ToolObservationAction | void;

  /**
   * Failure seam when a tool call THREW (rather than returning an error
   * record). The strategy has already pushed the error tool-result and a
   * generic retry-guidance system message; the hook records telemetry /
   * recovery flags.
   */
  onToolFailed?(info: ToolFailureInfo): void | Promise<void>;

  /**
   * Final-answer text override consulted at every run completion point.
   * Products that accumulate streamed deltas return their accumulator here
   * so the returned answer is byte-identical to what the user saw.
   */
  finalAnswer?(): string | undefined;
}
