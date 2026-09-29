/**
 * ExecutionStrategy — the pluggable think→act→observe loop.
 *
 * The ReAct loop used to be hard-coded inside the Agent (runUserMessage).
 * This module promotes the *shape* of such loops into a strategy contract
 * owned by the kernel, while the kernel keeps owning the hard parts:
 * budgets, timeouts, events, cancellation, concurrency, retries, state.
 *
 * A strategy receives an ExecutionContext (per-run, pre-wired with gateways,
 * context port, event sink, budget, abort signal) and drives the loop. It
 * must respect: ctx.signal cancellation, ctx.budget ceilings, and emit
 * events through ctx.events (never console.log).
 *
 * Product policies (escalation, streaming, approvals, tool selection) plug
 * in through StrategyHooks (see strategy-hooks.ts) — the strategy runs with
 * zero hooks for headless/kernel-native runs.
 */

import type { ChatMessage, OllamaToolSchema } from "../../models/adapters/provider.js";
import { Capability } from "../../models/catalog.js";
import type { ExecutionResult, ExecutionContext, ExecutionStatus, StrategyName } from "../../core/types.js";
import { LoopDetector } from "../../orchestration/loop-detector.js";
import type { PreparedToolCall, StrategyHooks, StrategyModelCallOptions } from "./strategy-hooks.js";
import { CriticService, type CriticSeverity } from "../critic/critic.js";
import { SelfCorrectionLoop, type SelfCorrectionResult } from "../critic/reflection.js";

export interface ExecutionStrategy {
  readonly name: StrategyName;
  run(request: StrategyRunRequest): Promise<ExecutionResult>;
}

export interface StrategyRunRequest {
  /** Per-run, pre-wired execution context (gateways, budget, signal, events). */
  ctx: ExecutionContext;
  /** Capability used for model routing during the loop. */
  capability: Capability;
  /** Max tool turns (loop safety). */
  maxToolTurns?: number;
  /** Tool capability filter for schemas sent to the model. */
  toolCapabilities?: string[];
  /** Product-side policies; omit for a fully kernel-native run. */
  hooks?: StrategyHooks;
  /** In-loop critic policy (see runtime/critic); omit to disable. */
  critic?: CriticPolicy;
  onProgress?: (message: string) => void;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Extract tool calls from a ChatResponse, tolerating missing/malformed fields. */
export function extractToolCalls(response: {
  message?: { tool_calls?: unknown[] };
}): Array<{ name: string; arguments: unknown }> {
  const calls = response.message?.tool_calls ?? [];
  const out: Array<{ name: string; arguments: unknown }> = [];
  for (const call of calls) {
    const fn = (call as { function?: { name?: string; arguments?: unknown } })?.function;
    if (!fn?.name) continue;
    out.push({ name: fn.name, arguments: fn.arguments ?? {} });
  }
  return out;
}

function usageOf(response: Record<string, unknown>): {
  promptTokens: number;
  completionTokens: number;
} {
  return {
    promptTokens: Number(response.prompt_eval_count ?? 0),
    completionTokens: Number(response.eval_count ?? 0),
  };
}

/** What the strategy's inner loop returns: the final text, plus an optional
 * product-facing terminal tag (e.g. "answered" vs "loop_abort") and a hard
 * error to rethrow by the caller (preserving the original object). */
export interface LoopOutcome {
  output: string;
  terminal?: string;
  thrown?: Error;
  /** Extra result metadata (e.g. the critic's reflection trail). */
  metadata?: Record<string, unknown>;
}

/** Common wrapper: map abort/budget errors onto ExecutionResult statuses. */
export async function runGuarded(
  ctx: ExecutionContext,
  strategy: StrategyName,
  loop: () => Promise<string | LoopOutcome>,
): Promise<ExecutionResult> {
  const usage = () => ctx.budget.snapshot();
  try {
    ctx.budget.assertTimeLeft();
    const outcome = await loop();
    const resolved: LoopOutcome = typeof outcome === "string" ? { output: outcome } : outcome;
    if (resolved.thrown) throw resolved.thrown;
    return {
      status: "completed",
      runId: ctx.runId,
      agentId: ctx.agentId,
      strategy,
      output: resolved.output,
      usage: usage(),
      ...(resolved.terminal || resolved.metadata
        ? { metadata: { ...(resolved.terminal ? { terminal: resolved.terminal } : {}), ...(resolved.metadata ?? {}) } }
        : {}),
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    let status: ExecutionStatus = "failed";
    if (ctx.signal.aborted) status = "cancelled";
    else if (err.name === "WallClockBudgetError") status = "timeout";
    else if (err.name.endsWith("BudgetError")) status = "budget_exhausted";
    return {
      status,
      runId: ctx.runId,
      agentId: ctx.agentId,
      strategy,
      output: ctx.context.lastAssistantText() ?? "",
      usage: usage(),
      error: err.message,
      metadata: { error: err },
    };
  }
}

// ── In-loop critic policy (see runtime/critic) ─────────────────────────────

/** How aggressively the ReAct loop self-corrects its final answer. */
export interface CriticPolicy {
  /** Max regeneration attempts after the first answer (default 1). */
  maxAttempts?: number;
  /** Minimum weakness severity that triggers a revision (default "medium"). */
  minSeverity?: CriticSeverity;
  /** Capability used to route critique calls (default "reasoning"). */
  capability?: Capability;
}

// ── ReAct strategy ──────────────────────────────────────────────────────────

export interface ReActStrategyOptions {
  /** Loop-detector window tuning (defaults match the Agent's current behavior). */
  loopThreshold?: number;
  /** In-loop critic (final answer gets critiqued and revised when weak). */
  critic?: CriticPolicy;
}

/**
 * ReAct: model → tool call → policy → tool executor → observation → model.
 * Portable implementation of the loop the CLI Agent runs today, minus the
 * product concerns (escalation, streaming, skills, approvals) which ride in
 * through StrategyHooks.
 */
export class ReActStrategy implements ExecutionStrategy {
  readonly name: StrategyName = "react";
  private readonly loopThreshold?: number;
  private readonly criticPolicy?: CriticPolicy;

  constructor(opts: ReActStrategyOptions = {}) {
    this.loopThreshold = opts.loopThreshold;
    this.criticPolicy = opts.critic;
  }

  async run(request: StrategyRunRequest): Promise<ExecutionResult> {
    const { ctx, hooks } = request;
    const maxTurns = request.maxToolTurns ?? 32;
    const loopDetector = new LoopDetector();

    return runGuarded(ctx, this.name, async (): Promise<LoopOutcome> => {
      if (ctx.task.input) ctx.context.push({ role: "user", content: ctx.task.input });

      let lastText: string | undefined;

      for (let turn = 0; turn < maxTurns; turn++) {
        if (ctx.signal.aborted) throw new DOMException("run cancelled", "AbortError");
        ctx.budget.assertTimeLeft();

        const turnInfo = {
          turn,
          capability: request.capability,
          userMessage: ctx.task.input ?? "",
          messages: ctx.context.messages(),
        };

        await hooks?.onTurnStart?.(turnInfo);

        const defaultSchemas = ctx.toolGateway.schemasFor(request.toolCapabilities);
        const selected = (await hooks?.selectTools?.(turnInfo, defaultSchemas)) ?? defaultSchemas;
        const modelOpts: StrategyModelCallOptions = { tools: selected.length > 0 ? selected : undefined };

        const messages = ctx.context.messages() as ChatMessage[];
        const turnStart = Date.now();
        const response = hooks?.callModel
          ? await hooks.callModel(turnInfo, modelOpts)
          : await ctx.modelGateway.route(request.capability, messages, {
              tools: modelOpts.tools as OllamaToolSchema[] | undefined,
            });

        lastText = response.message?.content || lastText;
        const { promptTokens, completionTokens } = usageOf(response);
        ctx.budget.consumeModelCall({ promptTokens, completionTokens });
        hooks?.onModelUsed?.({ response, elapsedMs: Date.now() - turnStart, turn });

        // Push the assistant message exactly once, with tool_calls attached
        // when present (a response can carry both content and tool_calls —
        // pushing content first and tool_calls second would duplicate it).
        const toolCalls = extractToolCalls(response);
        ctx.context.push({
          role: "assistant",
          content: response.message?.content ?? "",
          ...(toolCalls.length > 0 ? { tool_calls: response.message?.tool_calls as ChatMessage["tool_calls"] } : {}),
        });

        if (toolCalls.length === 0) {
          const hasContent = (response.message?.content ?? "").trim().length > 0;
          if (hasContent) {
            const answer = hooks?.finalAnswer?.() ?? lastText ?? "";
            // In-loop self-correction (runtime/critic): critique the final
            // answer and, when it is weak, push the feedback and let the
            // loop regenerate it — all inside THIS execution.
            if (!this.criticPolicy || ctx.signal.aborted) {
              return { output: answer, terminal: "answered" };
            }
            const correction = await this.selfCorrect(ctx, answer);
            return {
              output: correction.answer,
              terminal: "answered",
              metadata: {
                critique: {
                  attempts: correction.attempts,
                  verdict: correction.critiques[correction.critiques.length - 1]?.verdict ?? "pass",
                  weaknesses: correction.critiques[correction.critiques.length - 1]?.weaknesses.length ?? 0,
                  source: correction.critiques[correction.critiques.length - 1]?.source ?? "heuristic",
                },
              },
            };
          }
          if (turn < maxTurns - 1) {
            ctx.context.pushSystem(
              "[system] You were thinking but produced no action or response. Call a tool or provide your final answer now.",
            );
            continue;
          }
          return { output: hooks?.finalAnswer?.() || lastText || "(no response)", terminal: "answered" };
        }

        for (const call of toolCalls) {
          if (ctx.signal.aborted) throw new DOMException("run cancelled", "AbortError");

          // Parse/normalize seam (product may replicate legacy tolerant parsing).
          const prepared: PreparedToolCall = (await hooks?.prepareToolCall?.({
            name: call.name,
            rawArguments: call.arguments,
            turn,
          })) ?? { args: this.defaultParse(call.arguments) };
          const args = prepared.args;
          if (prepared.guidance) ctx.context.pushSystem(prepared.guidance);

          ctx.events.publish({
            type: "tool.started",
            id: `${ctx.runId}:${call.name}`,
            name: call.name,
            args: {},
          });

          // Approval/veto seam: a rejection is fully owned by the hook
          // (it already recorded the observation), the loop just moves on.
          const allowed = (await hooks?.beforeToolCall?.({ name: call.name, args, turn })) ?? true;
          if (!allowed) continue;

          ctx.budget.consumeToolCall();

          let result;
          try {
            result = await ctx.toolGateway.invoke(call.name, args, {
              agentId: ctx.agentId,
              runId: ctx.runId,
              mode: ctx.mode,
              unattended: ctx.unattended,
              signal: ctx.signal,
            });

            // Policy confirmation seam: the gateway never blocks on UX — it
            // returns a structured ConfirmationRequired outcome. With a
            // resolver hook installed, the product asks the human and either
            // re-executes (confirmed) or owns the rejection; without one
            // (headless) the structured outcome itself becomes the
            // observation and the model adapts.
            if (!result.ok && result.error?.code === "ConfirmationRequired" && hooks?.resolveConfirmation) {
              const approved = await hooks.resolveConfirmation({
                name: call.name,
                args,
                reason: result.error.message ?? "tool requires confirmation",
                turn,
              });
              result = approved
                ? await ctx.toolGateway.invoke(call.name, args, {
                    agentId: ctx.agentId,
                    runId: ctx.runId,
                    mode: ctx.mode,
                    unattended: ctx.unattended,
                    signal: ctx.signal,
                    confirmed: true,
                  })
                : {
                    ok: false,
                    data: { error: "ApprovalRejected", message: "The user rejected this action." },
                    error: { code: "ApprovalRejected", message: "The user rejected this action." },
                  };
            }
          } catch (e) {
            // Thrown tool failures become an observation, never a run crash:
            // the model gets the error and a retry-guidance nudge (matching
            // the legacy loop's catch path).
            const err = e instanceof Error ? e : new Error(String(e));
            result = {
              ok: false,
              data: { error: err.constructor?.name ?? "Error", message: err.message },
            };
            ctx.context.pushToolResult(JSON.stringify(result.data, null, 2));
            ctx.context.pushSystem(
              `[system] Tool execution for "${call.name}" failed: ${err.message}. Analyze the error and adjust your parameters or approach.`,
            );
            ctx.events.publish({
              type: "tool.completed",
              id: `${ctx.runId}:${call.name}`,
              result: result.data,
            });
            await hooks?.onToolFailed?.({ name: call.name, error: err, turn });
            continue;
          }

          ctx.events.publish({
            type: "tool.completed",
            id: `${ctx.runId}:${call.name}`,
            result: result.data,
          });

          if (hooks?.onToolObserved) {
            // Product owns the observation (result push, error flags, loop policy).
            const action = await hooks.onToolObserved({
              name: call.name,
              args,
              result,
              turn,
              parseError: null,
            });
            if (action?.abortRun) {
              return {
                output: action.output ?? hooks.finalAnswer?.() ?? lastText ?? "",
                terminal: action.terminal ?? "loop_abort",
              };
            }
          } else {
            ctx.context.pushToolResult(
              typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2),
            );
            if (!result.ok && loopDetector.record(call.name, {}, result.error?.code ?? "error")) {
              return { output: lastText ?? "", terminal: "loop_abort" };
            }
          }
        }
      }

      return {
        output: hooks?.finalAnswer?.() || lastText || "(tool budget exceeded)",
        terminal: "turn_budget",
      };
    });
  }

  /**
   * Kernel-default argument preparation (used when no prepareToolCall hook
   * is installed): pass objects through, best-effort JSON-parse strings.
   * The gateway re-decodes anyway, so a malformed string simply stays a
   * string and fails validation downstream.
   */
  private defaultParse(raw: unknown): Record<string, unknown> {
    if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
    if (typeof raw === "string" && raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
      } catch {
        // fall through — the gateway's decoder reports the failure
      }
    }
    return {};
  }

  /**
   * In-loop self-correction for the final answer (runtime/critic): critique
   * → on "revise", push the feedback into the context and regenerate
   * (text-only revision — bounded, no new tool calls mid-answer). Critique
   * and regeneration calls are budget-accounted like any other model call.
   */
  private async selfCorrect(ctx: ExecutionContext, answer: string): Promise<SelfCorrectionResult> {
    const policy = this.criticPolicy;
    const critic = new CriticService({
      modelGateway: ctx.modelGateway,
      ...(policy?.capability ? { capability: policy.capability } : {}),
      ...(policy?.minSeverity ? { minSeverity: policy.minSeverity } : {}),
    });
    const loop = new SelfCorrectionLoop(critic, { maxAttempts: policy?.maxAttempts ?? 1 });

    const result = await loop.improve(
      { goal: ctx.task.goal, ...(ctx.task.input ? { input: ctx.task.input } : {}) },
      answer,
      async (feedback) => {
        ctx.context.pushSystem(feedback);
        const revised = await ctx.modelGateway.route(
          policy?.capability ?? "reasoning",
          ctx.context.messages() as ChatMessage[],
        );
        ctx.budget.consumeModelCall(usageOf(revised as Record<string, unknown>));
        const revisedText = revised.message?.content ?? "";
        ctx.context.push({ role: "assistant", content: revisedText });
        return revisedText;
      },
    );
    // Budget-account the critique calls themselves (token counts best-effort).
    for (const critique of result.critiques) {
      ctx.budget.consumeModelCall(critique.usage ?? { promptTokens: 0, completionTokens: 0 });
    }
    return result;
  }
}
