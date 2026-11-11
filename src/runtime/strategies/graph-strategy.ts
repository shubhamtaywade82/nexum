/**
 * GraphStrategy (review item 3) — task-graph execution inside one run.
 *
 * The third pluggable execution strategy:
 *   ReActStrategy        sequential think→act→observe loop
 *   PlanExecuteStrategy  plan, then execute steps SERIALLY with ReAct
 *   GraphStrategy        decompose into a TaskGraph, then execute READY
 *                        nodes in PARALLEL (dependency-aware, resource-
 *                        locked, priority-laned), aggregating results
 *
 * The strategy owns the reasoning loop shape only. State, policies,
 * budgets, retries, cancellation and checkpoints remain runtime-owned
 * (review item 3): cancellation flows through ctx.signal, budgets through
 * ctx.budget (parallel slots via BudgetManager), node retries through the
 * graph's retry budget.
 */

import type { ChatMessage } from "../../models/adapters/provider.js";
import { budgetUsageOf, readUsage } from "../../models/usage-reading.js";
import type { Capability } from "../../models/catalog.js";
import type { ExecutionResult, ExecutionContext, StrategyName } from "../../core/types.js";
import type { ExecutionStrategy } from "./execution-strategy.js";
import { ReActStrategy, runGuarded } from "./execution-strategy.js";
import { TransientContextManager } from "../context/execution-context.js";
import { TaskGraph } from "../../core/tasks/task-graph.js";
import { ResourceLockRegistry } from "../../core/concurrency/resource-locks.js";
import { Scheduler } from "../../core/tasks/scheduler.js";
import { BudgetManager } from "../budget/budget-manager.js";
import type { ExecutionStep } from "../types.js";

export interface GraphStrategyOptions {
  /** Capability used for the decomposition call. Defaults to "reasoning". */
  planCapability?: Capability;
  /** Capability used for node execution. Defaults to "agentic". */
  executeCapability?: Capability;
  maxNodes?: number;
  maxToolTurnsPerNode?: number;
  /** Max nodes in flight (also bounded by the run's parallel budget). */
  maxParallel?: number;
}

interface GraphPlanNode {
  goal: string;
  dependencies?: string[];
  resourceLocks?: string[];
  exclusive?: boolean;
  priority?: "critical" | "normal";
}

function parseGraphPlan(content: string, maxNodes: number): GraphPlanNode[] {
  const nodes: GraphPlanNode[] = [];
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            nodes.push({ goal: item });
          } else if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            const goal =
              typeof record.goal === "string" ? record.goal : typeof record.step === "string" ? record.step : undefined;
            if (goal) {
              nodes.push({
                goal,
                dependencies: Array.isArray(record.dependencies)
                  ? record.dependencies.filter((d): d is string => typeof d === "string")
                  : undefined,
                resourceLocks: Array.isArray(record.resourceLocks)
                  ? record.resourceLocks.filter((r): r is string => typeof r === "string")
                  : undefined,
                exclusive: record.exclusive === true,
                priority: record.priority === "critical" ? "critical" : "normal",
              });
            }
          }
          if (nodes.length >= maxNodes) break;
        }
      }
    } catch {
      // fall through
    }
  }
  if (nodes.length === 0) {
    for (const line of content.split("\n")) {
      const cleaned = line.replace(/^\s*(?:[-*\d.]+\s*)/, "").trim();
      if (cleaned.length >= 8 && cleaned.length <= 400) nodes.push({ goal: cleaned });
      if (nodes.length >= maxNodes) break;
    }
  }
  return nodes;
}

export class GraphStrategy implements ExecutionStrategy {
  readonly name: StrategyName = "graph";

  private readonly react = new ReActStrategy();
  private readonly planCapability: Capability;
  private readonly executeCapability: Capability;
  private readonly maxNodes: number;
  private readonly maxToolTurnsPerNode: number;
  private readonly maxParallel: number;

  constructor(opts: GraphStrategyOptions = {}) {
    this.planCapability = opts.planCapability ?? "reasoning";
    this.executeCapability = opts.executeCapability ?? "agentic";
    this.maxNodes = opts.maxNodes ?? 10;
    this.maxToolTurnsPerNode = opts.maxToolTurnsPerNode ?? 12;
    this.maxParallel = opts.maxParallel ?? 3;
  }

  async run(request: { ctx: ExecutionContext; maxToolTurns?: number }): Promise<ExecutionResult> {
    const { ctx } = request;
    return runGuarded(ctx, this.name, async () => {
      if (ctx.task.input) ctx.context.push({ role: "user", content: ctx.task.input });

      // ── Phase 1: decompose into a task graph ───────────────────────────
      const planMessages: ChatMessage[] = [
        ...ctx.context.messages(),
        {
          role: "user",
          content:
            "Decompose the goal into tasks. Reply ONLY with a JSON array where each item is " +
            '{"goal": "...", "dependencies": ["n1", ...], "resourceLocks": ["git"|"database"|"browser"|"workspace-write"], ' +
            '"exclusive": false, "priority": "normal"}. Use ids "n1", "n2", ... and reference earlier ids in ' +
            "dependencies to express ordering. Tasks WITHOUT dependencies will run in PARALLEL — only add a dependency " +
            `when task B truly needs task A's output. Max ${this.maxNodes} tasks.`,
        },
      ];
      const planResponse = await ctx.modelGateway.route(this.planCapability, planMessages, { stream: false });
      ctx.budget.consumeModelCall(budgetUsageOf(readUsage(planResponse)));

      const graph = new TaskGraph();
      const planNodes = parseGraphPlan(planResponse.message?.content ?? "", this.maxNodes);
      planNodes.forEach((node, i) => {
        graph.add({
          id: `n${i + 1}`,
          goal: node.goal,
          dependencies: node.dependencies,
          resourceLocks: node.resourceLocks,
          exclusive: node.exclusive,
          priority: node.priority,
          maxRetries: 1,
        });
      });
      if (graph.size() === 0) graph.add({ id: "n1", goal: ctx.task.goal });

      ctx.events.publish({
        type: "execution.goal",
        goal: ctx.task.goal,
        steps: graph
          .all()
          .map((n): ExecutionStep => ({ id: n.id, description: n.goal.slice(0, 80), status: "pending" })),
      });

      // ── Phase 2: execute the graph (dependency-aware parallelism) ──────
      // parallel slots come from the run budget when it is a BudgetManager
      // (review item 14); otherwise the strategy default bounds in-flight work
      const budgetParallel = ctx.budget instanceof BudgetManager;
      const scheduler = new Scheduler({
        graph,
        locks: new ResourceLockRegistry(),
        maxParallel: this.maxParallel,
        signal: ctx.signal,
      });

      const outputs: string[] = [];
      const failures: string[] = [];

      await scheduler.drain(async (node) => {
        // one parallel slot per in-flight node when the budget tracks them
        const releaseSlot = budgetParallel ? (ctx.budget as BudgetManager).acquireParallelSlot() : undefined;
        try {
          ctx.events.publish({
            type: "execution.step",
            step: { id: node.id, description: node.goal.slice(0, 80), status: "running" } satisfies ExecutionStep,
          });
          const nodeMessages: ChatMessage[] = [
            ...(ctx.context.messages().filter((m) => m.role === "system") ?? []),
            {
              role: "user",
              content: [
                `Overall goal: ${ctx.task.goal}`,
                `Your task: ${node.goal}`,
                outputs.length ? `Other completed tasks (may be partial):\n${outputs.slice(-4).join("\n")}` : "",
                "Complete this one task now. Use tools as needed, then state the result concisely.",
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ];
          const nodeResult = await this.react.run({
            ctx: { ...ctx, context: new TransientContextManager([...nodeMessages]) },
            capability: this.executeCapability,
            maxToolTurns: this.maxToolTurnsPerNode,
          });
          if (nodeResult.status === "completed") {
            outputs.push(`[${node.id}] ${nodeResult.output || node.goal}`);
            ctx.events.publish({
              type: "execution.step",
              step: { id: node.id, description: node.goal.slice(0, 80), status: "completed" } satisfies ExecutionStep,
            });
            return "success" as const;
          }
          failures.push(`[${node.id}] ${nodeResult.error ?? nodeResult.status}`);
          ctx.events.publish({
            type: "execution.step",
            step: { id: node.id, description: node.goal.slice(0, 80), status: "failed" } satisfies ExecutionStep,
          });
          return "failure" as const;
        } finally {
          releaseSlot?.();
        }
      });

      if (ctx.signal.aborted) throw new DOMException("run cancelled", "AbortError");

      const summary = graph.summary();
      const header =
        `graph complete: ${summary.completed}/${summary.total} tasks succeeded` +
        (summary.skipped ? `, ${summary.skipped} skipped` : "") +
        (summary.blocked ? `, ${summary.blocked} blocked` : "");
      const body = outputs.join("\n");
      const failureBlock = failures.length ? `\nfailed tasks:\n${failures.join("\n")}` : "";
      const finalText = [header, body, failureBlock].filter(Boolean).join("\n\n");
      return finalText || "(graph produced no output)";
    });
  }
}
