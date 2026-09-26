/**
 * Tests for the in-loop critic plane: CriticService (model + heuristic),
 * SelfCorrectionLoop, VerifierService, and the ReAct integration.
 */
import { describe, it, expect } from "@jest/globals";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";
import { CriticService, severityAtLeast } from "../../src/runtime/critic/critic.js";
import { SelfCorrectionLoop } from "../../src/runtime/critic/reflection.js";
import {
  VerifierService,
  expectOutputContains,
  expectNoPlaceholders,
  expectMinLength,
} from "../../src/runtime/critic/verifier.js";
import { ReActStrategy } from "../../src/runtime/strategies/execution-strategy.js";
import { createExecutionContext, TransientContextManager } from "../../src/runtime/context/execution-context.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { ExecutionRequest } from "../../src/core/types.js";

/** Gateway that answers the loop calls normally and critiques with fixed JSON. */
function criticGateway(opts: {
  answer: string;
  critique: string;
  revised?: string;
  counts?: { route: number };
}): ModelGateway {
  const counts = opts.counts ?? { route: 0 };
  return {
    async route(capability, messages) {
      counts.route += 1;
      const last = messages[messages.length - 1]?.content ?? "";
      // The critique prompt is recognizable; everything else is an answer turn.
      if (capability === "reasoning" && last.includes("strict critic")) {
        return { message: { role: "assistant", content: opts.critique }, done: true } as unknown as ChatResponse;
      }
      if (last.includes("needs revision")) {
        return {
          message: { role: "assistant", content: opts.revised ?? opts.answer },
          done: true,
        } as unknown as ChatResponse;
      }
      return { message: { role: "assistant", content: opts.answer }, done: true } as unknown as ChatResponse;
    },
    async routeToModel(_m, _t, messages, opts2) {
      return this.route("reasoning", messages, opts2);
    },
    profiles: () => {
      throw new Error("unused");
    },
  } as unknown as ModelGateway;
}

describe("CriticService", () => {
  it("parses model critiques into verdicts and weaknesses", async () => {
    const gateway = criticGateway({
      answer: "ignored",
      critique: JSON.stringify({
        verdict: "revise",
        weaknesses: [
          { description: "does not cite the config path", severity: "medium", suggestion: "name the file" },
          { description: "typo in header", severity: "low" },
        ],
        summary: "Incomplete answer.",
      }),
    });
    const critic = new CriticService({ modelGateway: gateway });
    const critique = await critic.critique({ goal: "find the config" }, "The config is somewhere.");
    expect(critique.verdict).toBe("revise");
    expect(critique.weaknesses).toHaveLength(2);
    expect(critique.source).toBe("model");
    expect(critique.summary).toBe("Incomplete answer.");
  });

  it("falls back to the heuristic critique when the model fails or is unparseable", async () => {
    const broken = {
      route: async () => {
        throw new Error("model down");
      },
    } as unknown as ModelGateway;
    const critic = new CriticService({ modelGateway: broken });
    const empty = await critic.critique({ goal: "do anything" }, "");
    expect(empty.source).toBe("heuristic");
    expect(empty.verdict).toBe("revise");
    expect(empty.weaknesses[0].severity).toBe("high");

    const placeholders = await critic.critique(
      { goal: "write the report" },
      "Here is the report: [insert findings here]",
    );
    expect(placeholders.verdict).toBe("revise");

    const echo = await critic.critique({ goal: "explain the tool gateway" }, "explain the tool gateway");
    expect(echo.weaknesses.some((w) => w.description.includes("echoes"))).toBe(true);

    const fine = await critic.critique(
      { goal: "summarize" },
      "The summary covers the checkpoint store, the event bus, and the budget manager in detail.",
    );
    expect(fine.verdict).toBe("pass");
  });

  it("respects the minimum-severity bar", () => {
    expect(severityAtLeast("high", "medium")).toBe(true);
    expect(severityAtLeast("low", "medium")).toBe(false);
    const gateway = criticGateway({
      answer: "x",
      critique: JSON.stringify({
        verdict: "revise",
        weaknesses: [{ description: "typo", severity: "low" }],
        summary: "",
      }),
    });
    return new CriticService({ modelGateway: gateway, minSeverity: "high" })
      .critique({ goal: "g" }, "answer")
      .then((critique) => expect(critique.verdict).toBe("pass"));
  });
});

describe("SelfCorrectionLoop", () => {
  it("returns the first answer when the critic passes", async () => {
    const gateway = criticGateway({
      answer: "good answer",
      critique: JSON.stringify({ verdict: "pass", weaknesses: [], summary: "fine" }),
    });
    const loop = new SelfCorrectionLoop(new CriticService({ modelGateway: gateway }));
    const result = await loop.improve({ goal: "g" }, "good answer", async () => "should not be called");
    expect(result.answer).toBe("good answer");
    expect(result.attempts).toBe(0);
    expect(result.improved).toBe(false);
  });

  it("revises once when the critique demands it and stops at the bound", async () => {
    let regenerations = 0;
    const reviseAlways = JSON.stringify({
      verdict: "revise",
      weaknesses: [{ description: "still incomplete", severity: "high" }],
      summary: "revise",
    });
    const gateway = criticGateway({ answer: "v1", critique: reviseAlways, revised: "v2" });
    const loop = new SelfCorrectionLoop(new CriticService({ modelGateway: gateway }), { maxAttempts: 1 });
    const result = await loop.improve({ goal: "g" }, "v1", async (feedback) => {
      regenerations += 1;
      expect(feedback).toContain("still incomplete");
      return "v2";
    });
    expect(regenerations).toBe(1);
    expect(result.answer).toBe("v2");
    expect(result.critiques).toHaveLength(2);
    expect(result.improved).toBe(false); // last critique still says revise
  });

  it("marks improved when the revision passes", async () => {
    const pass = JSON.stringify({ verdict: "pass", weaknesses: [], summary: "fine" });
    const revise = JSON.stringify({
      verdict: "revise",
      weaknesses: [{ description: "empty", severity: "high" }],
      summary: "revise",
    });
    let critiqueCount = 0;
    const gateway = {
      route: async () => {
        critiqueCount += 1;
        return {
          message: { role: "assistant", content: critiqueCount === 1 ? revise : pass },
        } as unknown as ChatResponse;
      },
    } as unknown as ModelGateway;
    const loop = new SelfCorrectionLoop(new CriticService({ modelGateway: gateway }), { maxAttempts: 2 });
    const result = await loop.improve({ goal: "g" }, "bad", async () => "fixed");
    expect(result.answer).toBe("fixed");
    expect(result.improved).toBe(true);
    expect(result.attempts).toBe(1);
  });
});

describe("VerifierService", () => {
  it("runs registered checks and aggregates pass/fail", async () => {
    const verifier = new VerifierService()
      .register(expectOutputContains(["checkpoint", "event bus"]))
      .register(expectNoPlaceholders())
      .register(expectMinLength(50));
    const report = await verifier.verify(
      "The checkpoint store persists events; the event bus fans them out to reducers.",
    );
    expect(report.pass).toBe(true);
    expect(report.results.map((r) => r.checkId)).toEqual(["contains", "no-placeholders", "min-length"]);

    const bad = await verifier.verify("TODO: write this [insert here]");
    expect(bad.pass).toBe(false);
    expect(bad.results.find((r) => r.checkId === "contains")?.detail).toContain("missing");
  });

  it("collects throwing checks as failures", async () => {
    const verifier = new VerifierService().register({
      id: "throws",
      description: "always throws",
      run: () => {
        throw new Error("check bug");
      },
    });
    const report = await verifier.verify("answer");
    expect(report.pass).toBe(false);
    expect(report.results[0].detail).toContain("check bug");
  });

  it("rejects duplicate check ids", () => {
    const verifier = new VerifierService().register(expectNoPlaceholders());
    expect(() => verifier.register(expectNoPlaceholders())).toThrow("already registered");
  });
});

describe("ReAct + critic integration", () => {
  function toolGateway() {
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

  function request(): ExecutionRequest {
    return { agentId: "devagent", task: { goal: "find the config", input: "where is the config?" } };
  }

  it("critiques the final answer and attaches the critique to result metadata", async () => {
    const pass = JSON.stringify({ verdict: "pass", weaknesses: [], summary: "fine" });
    const counts = { route: 0 };
    const gateway = criticGateway({ answer: "the config lives in config.yml", critique: pass, counts });
    const strategy = new ReActStrategy({ critic: { maxAttempts: 1, minSeverity: "high" } });

    const ctx = createExecutionContext(request(), {
      modelGateway: gateway,
      toolGateway: toolGateway(),
      context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
    });
    const result = await strategy.run({ ctx, capability: "agentic", maxToolTurns: 4 });

    expect(result.status).toBe("completed");
    expect(result.output).toContain("config.yml");
    expect(result.metadata?.terminal).toBe("answered");
    const critique = result.metadata?.critique as { verdict: string; attempts: number };
    expect(critique.verdict).toBe("pass");
    expect(critique.attempts).toBe(0);
    // 1 answer call + 1 critique call
    expect(counts.route).toBe(2);
  });

  it("revises a weak final answer in the same run", async () => {
    const revise = JSON.stringify({
      verdict: "revise",
      weaknesses: [{ description: "does not name the file", severity: "high", suggestion: "name config.yml" }],
      summary: "revise",
    });
    const counts = { route: 0 };
    const gateway = criticGateway({
      answer: "it is somewhere in the repo",
      critique: revise,
      revised: "the config lives in config.yml",
      counts,
    });
    const strategy = new ReActStrategy({ critic: { maxAttempts: 1, minSeverity: "high" } });

    const ctx = createExecutionContext(request(), {
      modelGateway: gateway,
      toolGateway: toolGateway(),
      context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
    });
    const result = await strategy.run({ ctx, capability: "agentic", maxToolTurns: 4 });

    expect(result.output).toBe("the config lives in config.yml");
    const critique = result.metadata?.critique as { attempts: number; verdict: string };
    expect(critique.attempts).toBe(1);
    // The feedback entered the context as a system message.
    const system = ctx.context.messages().filter((m) => m.role === "system");
    expect(system.some((m) => m.content.includes("needs revision"))).toBe(true);
    // answer + critique + regeneration + final critique
    expect(counts.route).toBe(4);
  });

  it("is inert when no critic policy is set (kernel default)", async () => {
    const counts = { route: 0 };
    const gateway = criticGateway({ answer: "plain answer", critique: "unused", counts });
    const strategy = new ReActStrategy();
    const ctx = createExecutionContext(request(), {
      modelGateway: gateway,
      toolGateway: toolGateway(),
      context: new TransientContextManager([{ role: "system", content: "You are Nexum." }]),
    });
    const result = await strategy.run({ ctx, capability: "agentic", maxToolTurns: 4 });
    expect(result.output).toBe("plain answer");
    expect(result.metadata?.critique).toBeUndefined();
    expect(counts.route).toBe(1);
  });
});
