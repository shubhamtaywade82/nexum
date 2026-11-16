import { testOnlyAllowAll } from "../support/policy.js";
/**
 * CONTRACT TESTS — MCP adapter boundary + delegation + trading execution
 * (review items 19, 20, 25, 26, 30, 31, 37).
 */

import { McpToolAdapter } from "../../src/mcp/adapter/mcp-tool-adapter.js";
import { mcpSecurityMetadata } from "../../src/mcp/adapter/security-metadata.js";
import { Delegator } from "../../src/orchestration/delegation/delegator.js";
import { DefaultAgentRuntime, devAgentDescriptor } from "../../src/runtime/agent/agent-runtime.js";
import { createExecutionContext } from "../../src/runtime/context/execution-context.js";
import { BudgetManager } from "../../src/runtime/budget/budget-manager.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import type { ExecutionRequest, ExecutionResult, ExecutionContext } from "../../src/core/types.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import { TradingExecutionPipeline } from "../../src/domains/trading/execution/pipeline.js";
import { TradingRiskEngine, DEFAULT_RISK_LIMITS } from "../../src/domains/trading/execution/risk-engine.js";
import { validateProposal } from "../../src/domains/trading/execution/validation.js";
import { executionPolicyFor } from "../../src/domains/trading/execution/executors.js";
import { defaultStrategyRegistry } from "../../src/runtime/agent/agent-runtime.js";

describe("MCP adapter contract (items 19, 20)", () => {
  it("server annotations never drive authorization; only local classification does (item 20)", () => {
    const readOnly = mcpSecurityMetadata({
      name: "search_docs",
      description: "search",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    // A server claiming read-only + idempotent gets no benefit of the doubt.
    expect(readOnly.risk).toBe("high");
    expect(readOnly.policy.confirmation).toBe("required");
    expect(readOnly.sideEffects.externalMutation).toBe(true);
    expect(readOnly.sideEffects.network).toBe(true);
    expect(readOnly.sideEffects.filesystem).toBe(false);
    expect(readOnly.execution.idempotent).toBe(false);

    const destructive = mcpSecurityMetadata({
      name: "delete_record",
      description: "delete",
      inputSchema: {},
      annotations: { destructiveHint: true },
    });
    expect(destructive.risk).toBe("high");
    expect(destructive.policy.confirmation).toBe("required");

    const unknown = mcpSecurityMetadata({ name: "mystery", description: "", inputSchema: {} });
    expect(unknown.risk).toBe("high"); // strictest default
    expect(unknown.policy.confirmation).toBe("required");

    // Only the local configuration may classify a tool as read-only.
    const classified = mcpSecurityMetadata(
      { name: "search_docs", description: "search", inputSchema: {}, annotations: { readOnlyHint: true } },
      { risk: "read", confirmation: "never", externalMutation: false, idempotent: true },
    );
    expect(classified.risk).toBe("read");
    expect(classified.policy.confirmation).toBe("never");
    expect(classified.execution.idempotent).toBe(true);
  });
  it("server-level overrides tighten (never loosen) per-tool metadata (item 20)", () => {
    const meta = mcpSecurityMetadata(
      { name: "tool", description: "", inputSchema: {} },
      { risk: "critical", timeoutMs: 5_000, confirmation: "required" },
    );
    expect(meta.risk).toBe("critical");
    expect(meta.execution.timeoutMs).toBe(5_000);
    expect(meta.policy.confirmation).toBe("required");
  });

  it("adapter cancels on the run's signal (item 16) and maps errors structurally", async () => {
    const never: Promise<Record<string, unknown>> = new Promise(() => undefined);
    const adapter = new McpToolAdapter({ callTool: () => never }, { name: "slow", description: "", inputSchema: {} });
    const controller = new AbortController();
    const call = adapter.call(
      {},
      { invocation: { id: "tc_1", name: "slow", args: {} }, startedAt: Date.now(), signal: controller.signal },
    );
    controller.abort();
    const result = await call;
    expect(result.error).toBe("McpCancelled");
  });
});

describe("Delegation contract (items 25, 26)", () => {
  function fakeRuntime(): DefaultAgentRuntime & { calls: ExecutionRequest[] } {
    const calls: ExecutionRequest[] = [];
    class RecordingRuntime {
      readonly agents = new DefaultAgentRuntime().agents;
      readonly strategies = new DefaultAgentRuntime().strategies;
      readonly gates = new DefaultAgentRuntime().gates;
      calls = calls;
      async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
        calls.push(request);
        // faithful to the real path: strategies consume through ctx.budget,
        // which the Delegator wired to a derived child manager of the parent
        context.budget.consumeModelCall({ promptTokens: 5, completionTokens: 5 });
        return {
          status: "completed",
          runId: "run_child",
          agentId: request.agentId,
          strategy: "react",
          output: `child did: ${request.task.goal}`,
          usage: { toolCalls: 0, modelCalls: 1, totalTokens: 10, costUsd: 0, elapsedMs: 1 },
        };
      }
      cancel(): boolean {
        return true;
      }
    }
    const runtime = new RecordingRuntime() as unknown as DefaultAgentRuntime & { calls: ExecutionRequest[] };
    runtime.agents.register({
      ...devAgentDescriptor(),
      id: "specialist",
      capabilities: ["coding", "analysis"],
    });
    return runtime;
  }

  function contextWith(_runtime: DefaultAgentRuntime): ExecutionContext {
    const modelGateway = {
      route: async () => ({ message: { role: "assistant", content: "ok" } }),
      routeToModel: async () => ({ message: { role: "assistant", content: "ok" } }),
      profiles: () => null as never,
      select: () => [],
    } as unknown as ModelGateway;
    const catalog = new ToolCatalog();
    const gateway = new DefaultToolGateway({ catalog, policyEngine: testOnlyAllowAll() });
    const budget = new BudgetManager({ budget: { maxToolCalls: 10, maxModelCalls: 10 } });
    const request: ExecutionRequest = { agentId: "devagent", task: { goal: "parent goal" } };
    return {
      ...createExecutionContext(request, { modelGateway, toolGateway: gateway }),
      budget,
    };
  }

  it("capability-driven matching selects the agent that declares the capability (item 24/25)", () => {
    const runtime = fakeRuntime();
    const delegator = new Delegator({ runtime, agents: runtime.agents });
    const parent = contextWith(runtime);
    const review = delegator.review(parent, { goal: "x", requiredCapabilities: ["nuclear"] });
    expect(review.allowed).toBe(false);
    const match = delegator.review(parent, { goal: "x", requiredCapabilities: ["coding", "analysis"] });
    expect(match.allowed).toBe(true);
    expect(match.childAgentId).toBe("specialist");
  });

  it("child execution is isolated: own runId, derived budget, parent linkage (item 26)", async () => {
    const runtime = fakeRuntime();
    const delegator = new Delegator({ runtime, agents: runtime.agents });
    const parent = contextWith(runtime);
    const child = delegator.delegate(parent, { goal: "analyze the data", requiredCapabilities: ["coding"] });

    expect(child.childRunId).not.toBe(parent.runId);
    const result = await child.promise;
    expect(result.status).toBe("completed");
    expect(runtime.calls[0].agentId).toBe("specialist");
    expect(runtime.calls[0].task.metadata).toMatchObject({ delegated: true, parentRunId: parent.runId });

    // budget propagated: the child's model call burned the parent's budget
    expect(parent.budget.snapshot().modelCalls).toBeGreaterThanOrEqual(1);
  });

  it("delegation policy caps concurrent + total children (item 25)", () => {
    const runtime = fakeRuntime();
    const delegator = new Delegator({ runtime, agents: runtime.agents });
    const parent = contextWith(runtime);
    delegator.delegate(parent, { goal: "a", requiredCapabilities: ["coding"] });
    delegator.delegate(parent, { goal: "b", requiredCapabilities: ["coding"] });
    const third = delegator.review(
      parent,
      { goal: "c", requiredCapabilities: ["coding"] },
      { maxConcurrentChildren: 2 },
    );
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("concurrent");
  });

  it("result aggregation folds child outputs into a parent observation (item 25)", async () => {
    const runtime = fakeRuntime();
    const delegator = new Delegator({ runtime, agents: runtime.agents });
    const parent = contextWith(runtime);
    const child = delegator.delegate(parent, { goal: "summarize", requiredCapabilities: ["coding"] });
    const delegated = await delegator.observe(child);
    const observation = delegator.aggregate([delegated]);
    expect(observation).toContain("[delegated specialist] completed");
    expect(observation).toContain("child did: summarize");
  });
});

describe("Trading execution contract (items 30, 31)", () => {
  const portfolio = {
    positions: [] as Array<{ symbol: string; market: "spot" | "futures"; netQuantity: number; entryPrice: number }>,
    dayPnlUsd: 0,
    equityUsd: 10_000,
    referencePrices: { BTCUSDT: 50_000 },
  };

  it("research/backtest modes refuse ALL order routing (item 31)", async () => {
    for (const mode of ["research", "backtest"] as const) {
      const pipeline = new TradingExecutionPipeline({ mode });
      const record = await pipeline.submit(
        { symbol: "BTCUSDT", market: "spot", side: "buy", quantity: 0.001 },
        portfolio,
      );
      expect(record.status).toBe("rejected");
      expect(record.decision.approved).toBe(false);
    }
  });

  it("deterministic validation rejects malformed LLM proposals (item 30)", () => {
    const bad = validateProposal({ symbol: "!!", market: "options", side: "buy!!", quantity: -5 } as never);
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(2);
  });

  it("the risk engine (not the LLM) sizes and gates orders (item 30)", () => {
    const engine = new TradingRiskEngine({ ...DEFAULT_RISK_LIMITS, maxOrderNotionalUsd: 100 });
    // 0.01 BTC at 50k = $500 notional → over the $100 cap
    const over = engine.assess(
      { symbol: "BTCUSDT", market: "spot", side: "buy", quantity: 0.01, stopPrice: 49_000 },
      portfolio,
    );
    expect(over.approved).toBe(false);
    expect(over.reasons.some((r) => r.includes("order-notional"))).toBe(true);
    // stop-loss required by default config
    const noStop = engine.assess({ symbol: "BTCUSDT", market: "spot", side: "buy", quantity: 0.001 }, portfolio);
    expect(noStop.approved).toBe(false);
    expect(noStop.reasons.some((r) => r.includes("stop-required"))).toBe(true);
  });

  it("mode permissions get progressively stricter (item 31)", () => {
    expect(executionPolicyFor("research").routingAllowed).toBe(false);
    expect(executionPolicyFor("backtest").routingAllowed).toBe(false);
    expect(executionPolicyFor("shadow").routingAllowed).toBe(false);
    expect(executionPolicyFor("paper").routingAllowed).toBe(true);
    expect(executionPolicyFor("paper").requiresHumanConfirmation).toBe(false);
    expect(executionPolicyFor("live").routingAllowed).toBe(true);
    expect(executionPolicyFor("live").requiresHumanConfirmation).toBe(true);
  });

  it("live mode cannot be constructed by the agent: venue adapter required (item 30)", () => {
    expect(() => new TradingExecutionPipeline({ mode: "live" })).toThrow(/venue/i);
  });
});

describe("GraphStrategy registration (item 3)", () => {
  it("the default strategy registry exposes react, plan_execute, and graph", async () => {
    const registry = defaultStrategyRegistry();
    expect(registry.names().sort()).toEqual(["graph", "plan_execute", "react"]);
    expect(registry.get("graph")).toBeDefined();
  });
});
