import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { ModelCapabilityRegistry } from "../../src/models/profiles/model-capability-registry.js";
import { createExecutionContext, TransientContextManager } from "../../src/runtime/context/execution-context.js";
import { DefaultAgentRuntime, devAgentDescriptor } from "../../src/runtime/agent/agent-runtime.js";
import { GateRegistry } from "../../src/core/concurrency/gate-registry.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ExecutionRequest } from "../../src/core/types.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";

interface ScriptStep {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

/** A scripted ModelGateway: plays canned assistant turns in order. */
function fakeModelGateway(script: ScriptStep[]): ModelGateway {
  let i = 0;
  return {
    async route() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        message: { role: "assistant", content: step.content ?? "", tool_calls: step.tool_calls },
        done: true,
      };
    },
    async routeToModel(_model, _tier, messages, opts) {
      return this.route("tools", messages, opts);
    },
    profiles: () => new ModelCapabilityRegistry(),
  };
}

function echoDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "read_file",
    description: "reads a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    capabilities: ["filesystem"],
    pack: "filesystem",
    tags: [],
    risk: "read",
    sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
    execution: { timeoutMs: 2_000, concurrency: 1, idempotent: true, reversible: true },
    policy: { confirmation: "never" },
    ...overrides,
  };
}

function makeToolGateway(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const catalog = new ToolCatalog();
  catalog.register(echoDefinition(), async (args) => {
    calls.push({ name: "read_file", args });
    return { content: `contents of ${String(args.path)}` };
  });
  return new DefaultToolGateway({ catalog, policyEngine: new RulePolicyEngine() });
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agentId: "devagent",
    task: { goal: "find the config", input: "where is the config?" },
    ...overrides,
  };
}

describe("DefaultAgentRuntime + ReActStrategy (kernel-native path)", () => {
  it("runs a full ReAct loop: model → tool → observation → final answer", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const events: string[] = [];
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());

    const ctx = createExecutionContext(request(), {
      modelGateway: fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"config.yml"}' } }] },
        { content: "the config lives in config.yml" },
      ]),
      toolGateway: makeToolGateway(toolCalls),
      events: { publish: (e) => events.push(e.type) },
      context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
    });

    const result = await runtime.execute(request(), ctx);

    expect(result.status).toBe("completed");
    expect(result.output).toContain("config.yml");
    expect(toolCalls).toEqual([{ name: "read_file", args: { path: "config.yml" } }]);
    expect(events).toContain("tool.started");
    expect(events).toContain("tool.completed");
    // Tool result was fed back into the context as an observation.
    const toolMessages = ctx.context.messages().filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse(toolMessages[0].content)).toEqual({ content: "contents of config.yml" });
    expect(result.usage.modelCalls).toBe(2);
    expect(result.usage.toolCalls).toBe(1);
  });

  it("returns budget_exhausted when the tool budget runs out", async () => {
    const toolCalls: Array<{ name: string }> = [];
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());

    const ctx = createExecutionContext(request(), {
      modelGateway: fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"b"}' } }] },
        { content: "never reached" },
      ]),
      toolGateway: makeToolGateway(toolCalls as never),
      budget: { maxToolCalls: 1 },
    });

    const result = await runtime.execute(request(), ctx);
    expect(result.status).toBe("budget_exhausted");
    expect(result.usage.toolCalls).toBe(2);
  });

  it("returns cancelled when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const catalog = new ToolCatalog();
    catalog.register(echoDefinition(), async () => {
      controller.abort();
      return { content: "x" };
    });
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());

    const ctx = createExecutionContext(request(), {
      modelGateway: fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { content: "unreachable" },
      ]),
      toolGateway: new DefaultToolGateway({ catalog }),
      signal: controller.signal,
    });

    const result = await runtime.execute(request(), ctx);
    expect(result.status).toBe("cancelled");
  });

  it("rejects unknown agents", async () => {
    const runtime = new DefaultAgentRuntime();
    const ctx = createExecutionContext(request({ agentId: "nope" }), {
      modelGateway: fakeModelGateway([]),
      toolGateway: makeToolGateway([]),
    });
    await expect(runtime.execute(request({ agentId: "nope" }), ctx)).rejects.toThrow(/unknown agent/);
  });

  it("serializes runs per agent through the agent concurrency gate", async () => {
    const runtime = new DefaultAgentRuntime({ gates: new GateRegistry({ defaults: { agent: 1 } }) });
    runtime.agents.register(devAgentDescriptor());
    let concurrent = 0;
    let peak = 0;

    const modelGateway = fakeModelGateway([{ content: "done" }]);
    const originalRoute = modelGateway.route.bind(modelGateway);
    modelGateway.route = async (...args) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await originalRoute(...args);
      } finally {
        concurrent -= 1;
      }
    };

    const ctx = createExecutionContext(request(), {
      modelGateway,
      toolGateway: makeToolGateway([]),
    });
    await Promise.all([runtime.execute(request(), ctx), runtime.execute(request(), ctx)]);
    expect(peak).toBe(1); // agent gate = 1 in flight at a time
  });
});

describe("TransientContextManager.elideToolResults", () => {
  it("should stub all but the newest tool results and leave other roles untouched", () => {
    const ctx = new TransientContextManager([{ role: "system", content: "sys" }]);
    ctx.pushToolResult("old-1");
    ctx.push({ role: "assistant", content: "thinking" });
    ctx.pushToolResult("old-2");
    ctx.pushToolResult("new-1");
    ctx.pushToolResult("small");

    const replaced = ctx.elideToolResults(2, (c) => (c === "small" ? null : `[elided ${c}]`));

    expect(replaced).toBe(2);
    expect(ctx.messages().map((m) => m.content)).toEqual([
      "sys",
      "[elided old-1]",
      "thinking",
      "[elided old-2]",
      "new-1",
      "small",
    ]);
  });
});
