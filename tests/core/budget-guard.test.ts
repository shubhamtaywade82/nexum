import { ToolCallBudgetError } from "../../src/runtime/budget/budget-tracker.js";
import { describe, it, expect } from "@jest/globals";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";
import { BudgetManager } from "../../src/runtime/budget/budget-manager.js";
import { BudgetGuardRule, PolicyRequest } from "../../src/core/policy/policy-engine.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";

function def(id: string, mutating: boolean): ToolDefinition {
  return {
    id,
    description: id,
    inputSchema: { type: "object", properties: {} },
    capabilities: ["testing"],
    pack: "test",
    tags: [],
    risk: mutating ? "low" : "read",
    sideEffects: { filesystem: mutating, process: false, network: false, externalMutation: false, financial: false },
    execution: { timeoutMs: 5_000, concurrency: 1, idempotent: true, reversible: true },
    policy: { confirmation: "never" },
  };
}

function policyRequest(tool: ToolDefinition, budget?: PolicyRequest["budget"]): PolicyRequest {
  return { tool, args: {}, agentId: "a", runId: "r", budget };
}

describe("BudgetTracker.isDepleted", () => {
  it("is false when the budget has no ceilings", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s" });
    tracker.consumeToolCall();
    expect(tracker.isDepleted()).toBe(false);
  });

  it("is true once the tool-call ceiling is reached, not before", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s", budget: { maxToolCalls: 2 } });
    tracker.consumeToolCall();
    expect(tracker.isDepleted()).toBe(false);
    tracker.consumeToolCall();
    expect(tracker.isDepleted()).toBe(true);
  });

  it("is true once the model-call ceiling is reached", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s", budget: { maxModelCalls: 1 } });
    tracker.consumeModelCall({ promptTokens: 1, completionTokens: 1, usageSource: "PROVIDER" });
    expect(tracker.isDepleted()).toBe(true);
  });

  it("is true once the wall-clock deadline has passed", () => {
    let clock = 0;
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s", budget: { deadlineMs: 100 }, now: () => clock });
    clock = 99;
    expect(tracker.isDepleted()).toBe(false);
    clock = 100;
    expect(tracker.isDepleted()).toBe(true);
  });
});

describe("BudgetManager.isDepleted", () => {
  it("includes the run-level dimensions: iterations and cloud calls", () => {
    const iterations = new BudgetManager({ runId: "r", sessionId: "s", budget: { maxIterations: 1 } });
    iterations.consumeIteration();
    expect(iterations.isDepleted()).toBe(true);

    const cloud = new BudgetManager({ runId: "r", sessionId: "s", budget: { maxCloudCalls: 1 } });
    cloud.consumeModelCall({ promptTokens: 1, completionTokens: 1, usageSource: "PROVIDER", cloud: true });
    expect(cloud.isDepleted()).toBe(true);
  });
});

describe("BudgetGuardRule", () => {
  const rule = new BudgetGuardRule();

  it("denies a mutating tool once the run is depleted", () => {
    const decision = rule.evaluate(policyRequest(def("write_file", true), { ...emptyUsage(), depleted: true }));
    expect(decision).toMatchObject({ allowed: false, rule: "budget-guard" });
  });

  it("still allows read-only tools after depletion, so the run can wrap up", () => {
    expect(rule.evaluate(policyRequest(def("read_file", false), { ...emptyUsage(), depleted: true }))).toBeNull();
  });

  it("does nothing while the run has headroom, or when no budget is supplied", () => {
    expect(rule.evaluate(policyRequest(def("write_file", true), { ...emptyUsage(), depleted: false }))).toBeNull();
    expect(rule.evaluate(policyRequest(def("write_file", true)))).toBeNull();
  });
});

describe("budget guard through the tool gateway", () => {
  it("counts every attempt, denies a mutating tool once the allowance is spent, and then refuses further calls", async () => {
    const catalog = new ToolCatalog();
    catalog.register(def("read_file", false), async () => ({ content: "contents" }));
    catalog.register(def("write_file", true), async () => ({ content: "written" }));
    const gateway = new DefaultToolGateway({ catalog, policyEngine: new RulePolicyEngine() });
    const budget = new BudgetTracker({ runId: "r", sessionId: "s", budget: { maxToolCalls: 1 } });

    // The first attempt uses the single allowance. It is a mutating tool, and the run is now depleted: denied.
    const denied = await gateway.invoke("write_file", {}, { budget, runId: "r", agentId: "a" });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("PolicyDenied");
    expect(denied.error?.message).toContain("run budget is depleted");

    // A second attempt is past the ceiling: the gateway throws, so the run stops rather than seeing a tool failure.
    await expect(gateway.invoke("read_file", {}, { budget, runId: "r", agentId: "a" })).rejects.toBeInstanceOf(
      ToolCallBudgetError,
    );
    expect(budget.snapshot().toolCalls).toBe(2);
  });

  it("allows a mutating tool while the run still has allowance, counting the attempt once", async () => {
    const catalog = new ToolCatalog();
    catalog.register(def("write_file", true), async () => ({ content: "written" }));
    const gateway = new DefaultToolGateway({ catalog, policyEngine: new RulePolicyEngine() });
    const budget = new BudgetTracker({ runId: "r", sessionId: "s", budget: { maxToolCalls: 2 } });

    const result = await gateway.invoke("write_file", {}, { budget, runId: "r", agentId: "a" });
    expect(result.ok).toBe(true);
    expect(budget.snapshot().toolCalls).toBe(1);
  });
});

function emptyUsage() {
  return { toolCalls: 0, modelCalls: 0, totalTokens: 0, costUsd: 0, elapsedMs: 0 };
}
