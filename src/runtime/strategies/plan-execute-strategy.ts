/**
 * PlanExecuteStrategy — plan first, then execute each step with ReAct.
 *
 * Phase 1 (plan): one model call produces a JSON array of step goals.
 * Phase 2 (execute): each step runs through the ReAct loop with a fresh
 * budget slice, steps emitting execution.step events for the state store.
 *
 * JSON-plan parsing is defensive: malformed plans fall back to treating the
 * whole task as a single step (same behavior as asking ReAct directly).
 */

import type { ChatMessage } from "../../models/adapters/provider.js";
import type { Capability } from "../../models/catalog.js";
import type { ExecutionResult, ExecutionContext, StrategyName } from "../../core/types.js";
import type { ExecutionStrategy } from "./execution-strategy.js";
import { ReActStrategy, runGuarded } from "./execution-strategy.js";
import { LoopDetector } from "../../core/loop/loop-detector.js";
import { TransientContextManager } from "../context/execution-context.js";
import type { ExecutionStep } from "../types.js";

export interface PlanExecuteStrategyOptions {
  /** Capability used for the planning call. Defaults to "reasoning". */
  planCapability?: Capability;
  /** Capability used for step execution. Defaults to "agentic". */
  executeCapability?: Capability;
  maxSteps?: number;
  maxToolTurnsPerStep?: number;
}

interface PlanStep {
  title: string;
  goal: string;
}

function parsePlan(content: string, maxSteps: number): PlanStep[] {
  const steps: PlanStep[] = [];
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            steps.push({ title: item.slice(0, 80), goal: item });
          } else if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            const goal =
              typeof record.goal === "string" ? record.goal : typeof record.step === "string" ? record.step : undefined;
            if (goal) {
              const title = typeof record.title === "string" ? record.title : goal.slice(0, 80);
              steps.push({ title, goal });
            }
          }
        }
      }
    } catch {
      // fall through to line-based parsing
    }
  }

  if (steps.length === 0) {
    for (const line of content.split("\n")) {
      const cleaned = line.replace(/^\s*(?:[-*\d.]+\s*)/, "").trim();
      if (cleaned.length >= 8 && cleaned.length <= 400) {
        steps.push({ title: cleaned.slice(0, 80), goal: cleaned });
      }
      if (steps.length >= maxSteps) break;
    }
  }

  return steps.slice(0, maxSteps);
}

export class PlanExecuteStrategy implements ExecutionStrategy {
  readonly name: StrategyName = "plan_execute";

  private readonly react = new ReActStrategy();
  private readonly planCapability: Capability;
  private readonly executeCapability: Capability;
  private readonly maxSteps: number;
  private readonly maxToolTurnsPerStep: number;

  constructor(opts: PlanExecuteStrategyOptions = {}) {
    this.planCapability = opts.planCapability ?? "reasoning";
    this.executeCapability = opts.executeCapability ?? "agentic";
    this.maxSteps = opts.maxSteps ?? 8;
    this.maxToolTurnsPerStep = opts.maxToolTurnsPerStep ?? 16;
  }

  async run(request: { ctx: ExecutionContext; maxToolTurns?: number }): Promise<ExecutionResult> {
    const { ctx } = request;
    const loopDetector = new LoopDetector();

    return runGuarded(ctx, this.name, async () => {
      if (ctx.task.input) ctx.context.push({ role: "user", content: ctx.task.input });

      // ── Phase 1: plan ───────────────────────────────────────────────────
      const planMessages: ChatMessage[] = [
        ...ctx.context.messages(),
        {
          role: "user",
          content:
            "Produce a concise plan to accomplish the goal. Reply with ONLY a JSON array of strings, " +
            `each string one step (max ${this.maxSteps} steps). No prose.`,
        },
      ];

      const planResponse = await ctx.modelGateway.route(this.planCapability, planMessages, { stream: false });
      const planSteps = parsePlan(planResponse.message?.content ?? "", this.maxSteps);
      const { promptTokens: planPrompt, completionTokens: planCompletion } = {
        promptTokens: Number(planResponse.prompt_eval_count ?? 0),
        completionTokens: Number(planResponse.eval_count ?? 0),
      };
      ctx.budget.consumeModelCall({ promptTokens: planPrompt, completionTokens: planCompletion });

      ctx.events.publish({
        type: "execution.goal",
        goal: ctx.task.goal,
        steps: planSteps.map((s, i): ExecutionStep => ({
          id: `step-${i + 1}`,
          description: s.title,
          status: "pending",
        })),
      });

      // ── Phase 2: execute steps ──────────────────────────────────────────
      const outputs: string[] = [];

      for (let i = 0; i < planSteps.length; i++) {
        if (ctx.signal.aborted) throw new DOMException("run cancelled", "AbortError");
        ctx.budget.assertTimeLeft();

        const step = planSteps[i];
        const stepId = `step-${i + 1}`;
        ctx.events.publish({
          type: "execution.step",
          step: { id: stepId, description: step.title, status: "running" } satisfies ExecutionStep,
        });

        // Fresh transcript window per step: system + goal + step + prior outputs.
        const stepMessages: ChatMessage[] = [
          ...(ctx.context.messages().filter((m) => m.role === "system") ?? []),
          {
            role: "user",
            content: [
              `Overall goal: ${ctx.task.goal}`,
              step.goal,
              outputs.length ? `Completed so far:\n${outputs.map((o, idx) => `${idx + 1}. ${o}`).join("\n")}` : "",
              "Work on this step now. Use tools as needed, then state the result.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ];

        const stepResult = await this.react.run({
          ctx: { ...ctx, context: stepContext(ctx, stepMessages) },
          capability: this.executeCapability,
          maxToolTurns: this.maxToolTurnsPerStep,
        });

        if (stepResult.status === "completed") {
          outputs.push(stepResult.output || step.title);
          ctx.events.publish({
            type: "execution.step",
            step: { id: stepId, description: step.title, status: "completed" } satisfies ExecutionStep,
          });
        } else {
          const failed = stepResult.error ?? stepResult.status;
          ctx.events.publish({
            type: "execution.step",
            step: { id: stepId, description: step.title, status: "failed" } satisfies ExecutionStep,
          });
          if (loopDetector.record(stepId, {}, failed)) {
            throw new Error(`step loop detected: ${step.title}`);
          }
          outputs.push(`(step failed: ${failed})`);
        }
      }

      return outputs.join("\n") || "(no steps executed)";
    });
  }
}

/** A read-only ContextManager view pinned to explicit messages. */
function stepContext(_ctx: ExecutionContext, messages: ChatMessage[]): TransientContextManager {
  return new TransientContextManager([...messages]);
}
