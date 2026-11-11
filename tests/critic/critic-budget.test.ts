import { describe, it, expect } from "@jest/globals";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";
import { CriticService } from "../../src/runtime/critic/critic.js";
import { ReActStrategy } from "../../src/runtime/strategies/execution-strategy.js";
import { createExecutionContext, TransientContextManager } from "../../src/runtime/context/execution-context.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { ExecutionRequest } from "../../src/core/types.js";

const PASS = JSON.stringify({ verdict: "pass", weaknesses: [], summary: "fine" });
const NOT_JSON = "this is not a critique";

/**
 * Answers the critique prompt with `critiqueText` and every other prompt with `answer`. Each side reports
 * token counters only when its flag is set, so the answer and the critique can be metered independently.
 */
function gatewayFor(opts: {
  answer: string;
  critiqueText: string;
  answerCounters: boolean;
  critiqueCounters: boolean;
}): ModelGateway {
  const reply = (content: string, counters: boolean): ChatResponse =>
    ({
      message: { role: "assistant", content },
      done: true,
      ...(counters ? { prompt_eval_count: 11, eval_count: 7 } : {}),
    }) as unknown as ChatResponse;
  return {
    async route(capability, messages) {
      const last = messages[messages.length - 1]?.content ?? "";
      if (capability === "reasoning" && last.includes("strict critic")) {
        return reply(opts.critiqueText, opts.critiqueCounters);
      }
      return reply(opts.answer, opts.answerCounters);
    },
    async routeToModel(_model, _tier, messages, opts2) {
      return this.route("reasoning", messages, opts2);
    },
    profiles: () => {
      throw new Error("unused");
    },
  } as unknown as ModelGateway;
}

function toolGateway(): DefaultToolGateway {
  const catalog = new ToolCatalog();
  const definition: ToolDefinition = {
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
  };
  catalog.register(definition, async (args) => ({ content: `contents of ${String(args.path)}` }));
  return new DefaultToolGateway({ catalog, policyEngine: new RulePolicyEngine() });
}

const request: ExecutionRequest = {
  agentId: "devagent",
  task: { goal: "find the config", input: "where is the config?" },
};

describe("CriticService usage reporting", () => {
  it("reports MISSING, not zero tokens, when the critique call returns no counters", async () => {
    const modelGateway = gatewayFor({
      answer: "",
      critiqueText: PASS,
      answerCounters: false,
      critiqueCounters: false,
    });
    const critique = await new CriticService({ modelGateway }).critique(
      { goal: "explain the config" },
      "the config is config.yml",
    );

    expect(critique.source).toBe("model");
    expect(critique.usage?.source).toBe("MISSING");
    expect(critique.usage?.promptTokens).toBeUndefined();
  });

  it("reports the counts the provider returned for the critique call", async () => {
    const modelGateway = gatewayFor({
      answer: "",
      critiqueText: PASS,
      answerCounters: false,
      critiqueCounters: true,
    });
    const critique = await new CriticService({ modelGateway }).critique(
      { goal: "explain the config" },
      "the config is config.yml",
    );

    expect(critique.usage).toMatchObject({ source: "PROVIDER", promptTokens: 11, completionTokens: 7 });
  });
});

describe("ReAct + critic budget accounting", () => {
  it("does not count a heuristic critique as a model call (it made none)", async () => {
    // With a one-call budget, the answer uses the only call. A heuristic critique that were counted as a
    // model call would overrun the budget and end the run.
    const ctx = createExecutionContext(request, {
      modelGateway: gatewayFor({
        answer: "the config lives in config.yml",
        critiqueText: NOT_JSON,
        answerCounters: true,
        critiqueCounters: true,
      }),
      toolGateway: toolGateway(),
      context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
      budget: { maxModelCalls: 1 },
    });
    const strategy = new ReActStrategy({ critic: { maxAttempts: 0, minSeverity: "high" } });

    const result = await strategy.run({ ctx, capability: "agentic", maxToolTurns: 4 });

    expect(result.status).toBe("completed");
    expect(ctx.budget.snapshot()).toMatchObject({ modelCalls: 1, unmeteredModelCalls: 0 });
    expect((result.metadata?.critique as { source?: string } | undefined)?.source).toBe("heuristic");
  });

  it("still budget-accounts a model critique, and counts its missing counters as unmetered", async () => {
    // The answer reports its counters (11 + 7 = 18 tokens); the critique call reports none.
    const ctx = createExecutionContext(request, {
      modelGateway: gatewayFor({
        answer: "the config lives in config.yml",
        critiqueText: PASS,
        answerCounters: true,
        critiqueCounters: false,
      }),
      toolGateway: toolGateway(),
      context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
      budget: { maxModelCalls: 2 },
    });
    const strategy = new ReActStrategy({ critic: { maxAttempts: 1, minSeverity: "high" } });

    const result = await strategy.run({ ctx, capability: "agentic", maxToolTurns: 4 });

    expect(result.status).toBe("completed");
    expect(ctx.budget.snapshot()).toMatchObject({ modelCalls: 2, totalTokens: 18, unmeteredModelCalls: 1 });
  });
});
