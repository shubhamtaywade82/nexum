import { describe, it, expect } from "@jest/globals";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import { ModelCapabilityRegistry } from "../../src/models/profiles/model-capability-registry.js";
import type { ExecutionRequest, ExecutionBudget } from "../../src/core/types.js";
import { createExecutionContext, TransientContextManager } from "../../src/runtime/context/execution-context.js";
import { DefaultAgentRuntime, devAgentDescriptor } from "../../src/runtime/agent/agent-runtime.js";

interface ScriptStep {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

/** Plays canned assistant turns in order, counting how many model calls the run made. */
function scriptedModel(script: ScriptStep[]): ModelGateway {
  let i = 0;
  return {
    async route() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return { message: { role: "assistant", content: step.content ?? "", tool_calls: step.tool_calls }, done: true };
    },
    async routeToModel(_model, _tier, messages, opts) {
      return this.route("tools", messages, opts);
    },
    profiles: () => new ModelCapabilityRegistry(),
  } as unknown as ModelGateway;
}

function definition(id: string, mutating: boolean): ToolDefinition {
  return {
    id,
    description: id,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    capabilities: ["testing"],
    pack: "test",
    tags: [],
    risk: mutating ? "low" : "read",
    sideEffects: { filesystem: mutating, process: false, network: false, externalMutation: false, financial: false },
    execution: { timeoutMs: 5_000, concurrency: 1, idempotent: true, reversible: true },
    policy: { confirmation: "never" },
  };
}

/** Runs one ReAct execution through DefaultAgentRuntime and records which tool handlers actually ran. */
async function runReAct(script: ScriptStep[], budget: ExecutionBudget) {
  const executed: string[] = [];
  const catalog = new ToolCatalog();
  catalog.register(definition("write_file", true), async () => {
    executed.push("write_file");
    return { written: true };
  });
  catalog.register(definition("read_file", false), async () => {
    executed.push("read_file");
    return { content: "contents" };
  });
  const toolGateway = new DefaultToolGateway({ catalog, policyEngine: new RulePolicyEngine() });

  const request: ExecutionRequest = {
    agentId: "devagent",
    task: { goal: "edit the config", input: "edit the config" },
    budgets: budget,
  };
  const runtime = new DefaultAgentRuntime();
  runtime.agents.register(devAgentDescriptor());
  const ctx = createExecutionContext(request, {
    modelGateway: scriptedModel(script),
    toolGateway,
    budget,
    context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
  });
  const result = await runtime.execute(request, ctx);
  const toolObservations = ctx.context
    .messages()
    .filter((m) => m.role === "tool")
    .map((m) => m.content ?? "");
  return { result, executed, toolObservations };
}

describe("ReAct path propagates the run's policy context", () => {
  it("refuses a mutating tool once the model-call allowance is spent, and never runs its handler", async () => {
    const { result, executed, toolObservations } = await runReAct(
      [{ tool_calls: [{ function: { name: "write_file", arguments: '{"path":"config.yml"}' } }] }, { content: "done" }],
      { maxModelCalls: 1 },
    );

    expect(executed).toEqual([]);
    expect(toolObservations.join("\n")).toContain("run budget is depleted");
    expect(result.status).toBe("budget_exhausted");
  });

  it("still lets read-only tools run after depletion, so the run can finish its diagnosis", async () => {
    const { executed, toolObservations } = await runReAct(
      [{ tool_calls: [{ function: { name: "read_file", arguments: '{"path":"config.yml"}' } }] }, { content: "done" }],
      { maxModelCalls: 1 },
    );

    expect(executed).toEqual(["read_file"]);
    expect(toolObservations.join("\n")).not.toContain("run budget is depleted");
  });

  it("lets the call that spends the last tool-call allowance run: depletion is judged before the call's own count", async () => {
    const { result, executed } = await runReAct(
      [{ tool_calls: [{ function: { name: "write_file", arguments: '{"path":"config.yml"}' } }] }, { content: "done" }],
      { maxToolCalls: 1 },
    );

    expect(executed).toEqual(["write_file"]);
    expect(result.status).toBe("completed");
  });
});
