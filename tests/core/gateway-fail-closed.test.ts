import { describe, it, expect } from "@jest/globals";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { AllowAllPolicyEngine, RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { PolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { createExecutionContext, TransientContextManager } from "../../src/runtime/context/execution-context.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";

function def(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "write_file",
    description: "writes",
    inputSchema: { type: "object", properties: {} },
    capabilities: ["testing"],
    pack: "test",
    tags: [],
    risk: "low",
    sideEffects: { filesystem: true, process: false, network: false, externalMutation: false, financial: false },
    execution: { timeoutMs: 5_000, concurrency: 1, idempotent: true, reversible: true },
    policy: { confirmation: "never" },
    ...overrides,
  };
}

function catalogWithHandler(calls: string[]) {
  const catalog = new ToolCatalog();
  catalog.register(def(), async () => {
    calls.push("executed");
    return { ok: true };
  });
  return catalog;
}

const throwingEngine: PolicyEngine = {
  check() {
    throw new Error("policy store unreachable");
  },
};

const malformedEngine = { check: () => undefined } as unknown as PolicyEngine;

describe("DefaultToolGateway fails closed", () => {
  it("refuses to construct without an explicit policy engine", () => {
    expect(() => new DefaultToolGateway({ catalog: new ToolCatalog() } as never)).toThrow(/explicit PolicyEngine/);
  });

  it("denies execution when the policy engine throws, and never runs the handler", async () => {
    const calls: string[] = [];
    const gateway = new DefaultToolGateway({ catalog: catalogWithHandler(calls), policyEngine: throwingEngine });
    const result = await gateway.invoke("write_file", {}, { runId: "r", agentId: "a" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PolicyUnavailable");
    expect(calls).toEqual([]);
  });

  it("denies execution when the policy engine returns no decision", async () => {
    const calls: string[] = [];
    const gateway = new DefaultToolGateway({ catalog: catalogWithHandler(calls), policyEngine: malformedEngine });
    const result = await gateway.invoke("write_file", {}, { runId: "r", agentId: "a" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PolicyUnavailable");
    expect(calls).toEqual([]);
  });

  it("has no per-call policy bypass: a skipPolicy flag cannot skip a denying engine", async () => {
    const calls: string[] = [];
    const denyAll: PolicyEngine = {
      check: () => ({ allowed: false, requireConfirmation: false, reason: "no writes", rule: "deny-all" }),
    };
    const gateway = new DefaultToolGateway({ catalog: catalogWithHandler(calls), policyEngine: denyAll });
    const result = await gateway.invoke("write_file", {}, { runId: "r", agentId: "a", skipPolicy: true } as never);
    expect(result.error?.code).toBe("PolicyDenied");
    expect(calls).toEqual([]);
  });

  it("allow-all engines require an explicit acknowledgement, so tests cannot pick them up by accident", () => {
    expect(() => new (AllowAllPolicyEngine as new () => AllowAllPolicyEngine)()).toThrow(/acknowledgeNoPolicy/);
    expect(() =>
      new AllowAllPolicyEngine({ acknowledgeNoPolicy: true, reason: "fixture" } as never).check({} as never),
    ).not.toThrow();
  });

  it("execution contexts carry no second policy engine: the gateway is the single enforcement point", () => {
    const modelGateway = {} as ModelGateway;
    const ctx = createExecutionContext(
      { agentId: "a", task: { goal: "g" } },
      {
        modelGateway,
        toolGateway: new DefaultToolGateway({ catalog: new ToolCatalog(), policyEngine: new RulePolicyEngine() }),
        context: new TransientContextManager(),
      },
    );
    expect("policyEngine" in ctx).toBe(false);
  });
});
