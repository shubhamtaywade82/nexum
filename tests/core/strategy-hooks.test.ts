import { testOnlyAllowAll } from "../support/policy.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { ModelCapabilityRegistry } from "../../src/models/profiles/model-capability-registry.js";
import { createExecutionContext } from "../../src/runtime/context/execution-context.js";
import { DefaultAgentRuntime, devAgentDescriptor } from "../../src/runtime/agent/agent-runtime.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ExecutionRequest, ExecutionContext } from "../../src/core/types.js";
import type { StrategyHooks, ToolObservation } from "../../src/runtime/strategies/strategy-hooks.js";

interface ScriptStep {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

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

function readDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
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

function makeGateway(
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
) {
  const catalog = new ToolCatalog();
  catalog.register(readDefinition(), handler);
  return new DefaultToolGateway({ policyEngine: testOnlyAllowAll(), catalog });
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agentId: "devagent",
    task: { goal: "read the config", input: "read the config" },
    ...overrides,
  };
}

function ctxFor(
  modelGateway: ModelGateway,
  toolGateway: DefaultToolGateway,
  overrides: Partial<ExecutionContext> = {},
) {
  return createExecutionContext(request(), { modelGateway, toolGateway, ...overrides }) as ExecutionContext;
}

async function runWith(runtime: DefaultAgentRuntime, ctx: ExecutionContext, hooks: StrategyHooks | undefined) {
  return runtime.execute(request(), ctx, hooks ? { hooks } : undefined);
}

describe("ReActStrategy + StrategyHooks (product seams)", () => {
  it("without hooks, keeps the kernel-native path (gateway schemas, own result push)", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { content: "done" },
      ]),
      makeGateway((args) => ({ content: `file ${String(args.path)}` })),
    );

    const result = await runWith(runtime, ctx, undefined);

    expect(result.status).toBe("completed");
    const toolMessages = ctx.context.messages().filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse(toolMessages[0].content)).toEqual({ content: "file a" });
  });

  it("selectTools replaces the advertised schema list and callModel overrides routing", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const seen: Array<unknown[] | undefined> = [];
    const hooks: StrategyHooks = {
      selectTools: (_turn, defaults) => {
        expect(defaults.length).toBeGreaterThan(0);
        return [{ type: "function", function: { name: "custom", parameters: {} } }];
      },
      callModel: async (_turn, opts) => {
        seen.push(opts.tools);
        return { message: { role: "assistant", content: "routed by product" }, done: true };
      },
    };
    const ctx = ctxFor(
      // The gateway must never be consulted when callModel is installed.
      fakeModelGateway([{ content: "kernel path" }]),
      makeGateway(() => ({})),
    );

    const result = await runWith(runtime, ctx, hooks);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("routed by product");
    expect(seen).toHaveLength(1);
    expect((seen[0] as Array<{ function: { name: string } }>)[0].function.name).toBe("custom");
  });

  it("beforeToolCall rejection skips execution and the strategy does not push a result", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    let invoked = 0;
    const hooks: StrategyHooks = {
      beforeToolCall: () => {
        // The hook owns the rejection observation.
        return false;
      },
    };
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { content: "gave up" },
      ]),
      makeGateway(() => {
        invoked += 1;
        return {};
      }),
    );

    const result = await runWith(runtime, ctx, hooks);

    expect(result.status).toBe("completed");
    expect(invoked).toBe(0);
    // No hook observation → no tool message pushed by either side.
    expect(ctx.context.messages().filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("onToolObserved owns the result push and can abort the run with a terminal tag", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const observations: ToolObservation[] = [];
    const hooks: StrategyHooks = {
      onToolObserved: (obs) => {
        observations.push(obs);
        obs_result_push(obs);
        if (observations.length >= 2) {
          return { abortRun: true, terminal: "loop_abort", output: "aborted by product policy" };
        }
      },
    };
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"b"}' } }] },
        { content: "unreachable" },
      ]),
      makeGateway((args) => ({ content: `file ${String(args.path)}` })),
    );

    const result = await runWith(runtime, ctx, hooks);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("aborted by product policy");
    expect(result.metadata?.terminal).toBe("loop_abort");
    expect(observations).toHaveLength(2);
    // The strategy did NOT push (hook ownership): exactly the hook's pushes exist.
    expect(ctx.context.messages().filter((m) => m.role === "tool")).toHaveLength(2);

    function obs_result_push(obs: ToolObservation) {
      ctx.context.pushToolResult(JSON.stringify(obs.result.data, null, 2));
    }
  });

  it("prepareToolCall guidance lands as a system message before the tool result", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const hooks: StrategyHooks = {
      prepareToolCall: (call) => ({
        args: { path: "rewritten" },
        guidance: `[system] normalized ${call.name}`,
      }),
    };
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"raw"}' } }] },
        { content: "done" },
      ]),
      makeGateway((args) => ({ content: `file ${String(args.path)}` })),
    );

    await runWith(runtime, ctx, hooks);

    const messages = ctx.context.messages();
    const guidanceIdx = messages.findIndex((m) => m.role === "system" && m.content.includes("normalized read_file"));
    const toolIdx = messages.findIndex((m) => m.role === "tool");
    expect(guidanceIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(guidanceIdx);
    // The tool received the rewritten args, not the raw model arguments.
    expect(messages[toolIdx].content).toContain("rewritten");
  });

  it("onToolFailed records gateway-thrown errors and the run continues", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const failures: string[] = [];
    const hooks: StrategyHooks = {
      onToolFailed: ({ name, error }) => {
        failures.push(`${name}: ${error.message}`);
      },
    };
    // A throwing ToolGateway (custom implementations may throw; the built-in
    // one converts handler errors into ok:false results instead).
    const throwingGateway = {
      schemasFor: () => [],
      invoke: async () => {
        throw new Error("gateway exploded");
      },
    };
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { content: "recovered" },
      ]),
      throwingGateway as never,
    );

    const result = await runWith(runtime, ctx, hooks);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("recovered");
    expect(failures).toEqual(["read_file: gateway exploded"]);
    const messages = ctx.context.messages();
    expect(messages.some((m) => m.role === "tool" && m.content.includes("gateway exploded"))).toBe(true);
    expect(messages.some((m) => m.content.includes(`Tool execution for "read_file" failed`))).toBe(true);
  });

  it("handler throws arrive as ok:false observations (gateway wraps them), not onToolFailed", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const failures: string[] = [];
    const observations: ToolObservation[] = [];
    const hooks: StrategyHooks = {
      onToolObserved: (obs) => {
        observations.push(obs);
      },
      onToolFailed: ({ name, error }) => {
        failures.push(`${name}: ${error.message}`);
      },
    };
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { content: "recovered" },
      ]),
      makeGateway(() => {
        throw new Error("boom");
      }),
    );

    const result = await runWith(runtime, ctx, hooks);

    expect(result.status).toBe("completed");
    expect(result.output).toBe("recovered");
    expect(failures).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0].result.ok).toBe(false);
    expect(observations[0].result.data).toMatchObject({ error: "Error", message: "boom" });
  });

  it("finalAnswer overrides the returned output on the answered path", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const hooks: StrategyHooks = { finalAnswer: () => "streamed accumulator text" };
    const ctx = ctxFor(
      fakeModelGateway([{ content: "model content" }]),
      makeGateway(() => ({})),
    );

    const result = await runWith(runtime, ctx, hooks);

    expect(result.output).toBe("streamed accumulator text");
    expect(result.metadata?.terminal).toBe("answered");
  });

  it("turn exhaustion surfaces the turn_budget terminal tag", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const ctx = ctxFor(
      fakeModelGateway([{ tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] }]),
      makeGateway(() => ({ content: "x" })),
    );

    const result = await runtime.execute(request(), ctx, { maxToolTurns: 1 });

    expect(result.status).toBe("completed");
    expect(result.metadata?.terminal).toBe("turn_budget");
  });

  it("onTurnStart fires once per turn before the model call", async () => {
    const runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    const turns: number[] = [];
    const hooks: StrategyHooks = {
      onTurnStart: (turnInfo) => {
        turns.push(turnInfo.turn);
      },
    };
    const ctx = ctxFor(
      fakeModelGateway([
        { tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { content: "done" },
      ]),
      makeGateway(() => ({ content: "x" })),
    );

    await runWith(runtime, ctx, hooks);
    expect(turns).toEqual([0, 1]);
  });
});
