/**
 * Gateway enforcement flip — policy lives in the gateway, confirmations are
 * resolved by the product, and schema validation is strict in the Agent path.
 *
 * Covers: arg-aware rules, posture presets, the confirmed/unattended invoke
 * contract, and the ReActStrategy confirmation seam (approved → re-execute,
 * rejected → ApprovalRejected observation, headless → structured denial).
 */

import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { DeleteFileRule, DestructiveShellRule, FileEditRule, GitPublishRule } from "../../src/core/policy/rules.js";
import { parityPosture, restrictedPosture, standardPosture } from "../../src/core/policy/postures.js";
import { ReActStrategy } from "../../src/runtime/strategies/execution-strategy.js";
import { createExecutionContext } from "../../src/runtime/context/execution-context.js";
import { ModelCapabilityRegistry } from "../../src/models/profiles/model-capability-registry.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { StrategyHooks, ToolObservation } from "../../src/runtime/strategies/strategy-hooks.js";

function def(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "echo",
    description: "test tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    capabilities: ["testing"],
    pack: "test",
    tags: [],
    risk: "read",
    sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
    execution: { timeoutMs: 2_000, concurrency: 1, idempotent: true, reversible: true },
    policy: { confirmation: "optional" },
    ...overrides,
  };
}

const reqOf = (tool: ToolDefinition, args: Record<string, unknown> = {}) => ({
  tool,
  args,
  agentId: "devagent",
  runId: "run_test",
});

// ── Arg-aware rules ─────────────────────────────────────────────────────────

describe("DestructiveShellRule", () => {
  const rule = new DestructiveShellRule();
  const shell = def({ id: "run_shell", risk: "high", policy: { confirmation: "required" } });

  it("confirms destructive commands", () => {
    for (const command of ["rm -rf build", "git push --force origin main", "drop table users", ":(){ :|:& };:"]) {
      const d = rule.evaluate(reqOf(shell, { command }));
      expect(d).not.toBeNull();
      expect(d!.requireConfirmation).toBe(true);
      expect(d!.allowed).toBe(true);
    }
  });

  it("definitively allows benign commands (preempts tool-level confirmation)", () => {
    const d = rule.evaluate(reqOf(shell, { command: "ls -la src" }));
    expect(d).toEqual({
      allowed: true,
      requireConfirmation: false,
      reason: "shell command is non-destructive",
      rule: "destructive-shell",
    });
  });

  it("defers other tools to the chain", () => {
    expect(rule.evaluate(reqOf(def({ id: "read_file" })))).toBeNull();
  });

  it("can defer benign faces to the risk ladder (standard posture mode)", () => {
    const ladder = new DestructiveShellRule(false);
    expect(ladder.evaluate(reqOf(shell, { command: "ls" }))).toBeNull();
    expect(ladder.evaluate(reqOf(shell, { command: "rm -rf x" }))?.requireConfirmation).toBe(true);
  });
});

describe("GitPublishRule", () => {
  const rule = new GitPublishRule();
  const git = def({ id: "git", risk: "high", policy: { confirmation: "required" } });
  const github = def({ id: "github", risk: "high", policy: { confirmation: "required" } });

  it("confirms git push and gh pr create", () => {
    expect(rule.evaluate(reqOf(git, { args: ["push", "origin", "main"] }))?.requireConfirmation).toBe(true);
    expect(rule.evaluate(reqOf(github, { args: ["pr", "create"] }))?.requireConfirmation).toBe(true);
  });

  it("definitively allows local operations", () => {
    expect(rule.evaluate(reqOf(git, { args: ["status"] }))?.requireConfirmation).toBe(false);
    expect(rule.evaluate(reqOf(github, { args: ["pr", "view", "12"] }))?.requireConfirmation).toBe(false);
  });

  it("defers other tools to the chain", () => {
    expect(rule.evaluate(reqOf(def({ id: "run_shell" })))).toBeNull();
  });
});

describe("DeleteFileRule", () => {
  const rule = new DeleteFileRule();
  const del = def({ id: "delete_file", risk: "high", policy: { confirmation: "required" } });

  it("confirms every deletion with the path in the reason", () => {
    const d = rule.evaluate(reqOf(del, { path: "src/old.ts" }));
    expect(d?.requireConfirmation).toBe(true);
    expect(d?.reason).toContain("src/old.ts");
  });
});

describe("FileEditRule", () => {
  const rule = new FileEditRule();

  it("confirms workspace file edits with the path in the reason", () => {
    const d = rule.evaluate(reqOf(def({ id: "write_file", risk: "medium" }), { path: "notes.md" }));
    expect(d?.requireConfirmation).toBe(true);
    expect(d?.reason).toContain("notes.md");
  });

  it("defers reads to the chain", () => {
    expect(rule.evaluate(reqOf(def({ id: "read_file" }), { path: "notes.md" }))).toBeNull();
  });
});

// ── Postures ────────────────────────────────────────────────────────────────

describe("policy postures", () => {
  const shell = def({ id: "run_shell", risk: "high", sideEffects: { process: true } });
  const git = def({ id: "git", risk: "high" });
  const del = def({ id: "delete_file", risk: "high", sideEffects: { filesystem: true } });
  const dockerish = def({ id: "docker", risk: "high" });
  const paperTrade = def({
    id: "binance_paper_trade",
    risk: "critical",
    sideEffects: { financial: true, externalMutation: true },
    policy: { confirmation: "required" },
  });
  const readFile = def({ id: "read_file" });

  it("parity: only destructive/publish/delete/financial faces ask", () => {
    const engine = parityPosture();
    expect(engine.check(reqOf(shell, { command: "npm test" })).requireConfirmation).toBe(false);
    expect(engine.check(reqOf(git, { args: ["commit", "-m", "x"] })).requireConfirmation).toBe(false);
    expect(engine.check(reqOf(dockerish, { args: ["ps"] })).requireConfirmation).toBe(false);
    expect(engine.check(reqOf(readFile, { path: "a" })).requireConfirmation).toBe(false);

    expect(engine.check(reqOf(shell, { command: "rm -rf node_modules" })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(git, { args: ["push"] })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(del, { path: "x" })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(def({ id: "write_file", risk: "medium" }), { path: "a" })).requireConfirmation).toBe(
      true,
    );
    expect(engine.check(reqOf(paperTrade, { action: "buy" })).requireConfirmation).toBe(true);
  });

  it("standard: every high-risk call asks, benign faces included", () => {
    const engine = standardPosture();
    expect(engine.check(reqOf(shell, { command: "ls" })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(git, { args: ["status"] })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(dockerish, { args: ["ps"] })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(readFile, { path: "a" })).requireConfirmation).toBe(false);
  });

  it("restricted: medium floor, deny lists and ceilings enforce", () => {
    const engine = restrictedPosture({ deniedToolIds: ["run_shell"], denyRiskAbove: "critical" });
    const medium = def({ id: "write_file", risk: "medium", sideEffects: { filesystem: true } });
    expect(engine.check(reqOf(readFile, { path: "a" })).requireConfirmation).toBe(false); // read < medium floor
    expect(engine.check(reqOf(medium, { path: "a" })).requireConfirmation).toBe(true);
    expect(engine.check(reqOf(shell, { command: "ls" })).allowed).toBe(false);
    expect(engine.check(reqOf(paperTrade, { action: "buy" })).allowed).toBe(false);
  });
});

// ── Gateway confirmed / unattended contract ─────────────────────────────────

describe("gateway confirmation contract", () => {
  const SHELL_SCHEMA = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  function shellGateway() {
    const catalog = new ToolCatalog();
    catalog.register(
      def({
        id: "run_shell",
        inputSchema: SHELL_SCHEMA,
        risk: "high",
        sideEffects: { process: true },
      }),
      async (args) => ({ ran: String(args.command) }),
    );
    return new DefaultToolGateway({ catalog, policyEngine: parityPosture(), validation: "strict" });
  }

  it("benign commands execute; destructive ones surface ConfirmationRequired", async () => {
    const gw = shellGateway();

    const ok = await gw.invoke("run_shell", { command: "npm test" });
    expect(ok.ok).toBe(true);

    const gated = await gw.invoke("run_shell", { command: "rm -rf dist" });
    expect(gated.ok).toBe(false);
    expect(gated.error?.code).toBe("ConfirmationRequired");
  });

  it("confirmed: true satisfies the confirmation and executes", async () => {
    const gw = shellGateway();
    const result = await gw.invoke("run_shell", { command: "rm -rf dist" }, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ran: "rm -rf dist" });
  });

  it("unattended runs bypass the confirmation gate by contract", async () => {
    const gw = shellGateway();
    const result = await gw.invoke("run_shell", { command: "rm -rf dist" }, { unattended: true });
    expect(result.ok).toBe(true);
  });

  it("validation: strict rejects missing required args as structured errors", async () => {
    const gw = shellGateway();
    const bad = await gw.invoke("run_shell", {});
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("ValidationError");
    expect(bad.error?.message).toContain("command");
  });
});

// ── ReActStrategy confirmation seam ─────────────────────────────────────────

describe("ReActStrategy confirmation seam", () => {
  const SHELL_SCHEMA = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  function scriptedGateway(script: Array<{ content?: string; tool_calls?: unknown[] }>): ModelGateway {
    let i = 0;
    return {
      async route() {
        const step = script[Math.min(i, script.length - 1)];
        i += 1;
        return { message: { role: "assistant", content: step.content ?? "", tool_calls: step.tool_calls }, done: true };
      },
      async routeToModel(_model, _tier, _messages, _opts) {
        return this.route("tools", [], {});
      },
      profiles: () => new ModelCapabilityRegistry(),
    };
  }

  function ctxFor(script: Array<{ content?: string; tool_calls?: unknown[] }>, ran: string[]) {
    const catalog = new ToolCatalog();
    catalog.register(
      def({
        id: "run_shell",
        inputSchema: SHELL_SCHEMA,
        risk: "high",
        sideEffects: { process: true },
      }),
      async (args) => {
        ran.push(String(args.command));
        return { ran: String(args.command) };
      },
    );
    const gateway = new DefaultToolGateway({ catalog, policyEngine: parityPosture(), validation: "strict" });
    return createExecutionContext(
      { agentId: "devagent", task: { goal: "clean build" } },
      { modelGateway: scriptedGateway(script), toolGateway: gateway },
    );
  }

  const shellCall = { function: { name: "run_shell", arguments: '{"command":"rm -rf dist"}' } };

  it("approved confirmations re-execute the call and complete normally", async () => {
    const ran: string[] = [];
    const ctx = ctxFor([{ tool_calls: [shellCall] }, { content: "cleaned" }], ran);
    const asked: string[] = [];
    const hooks: StrategyHooks = {
      resolveConfirmation: async ({ name, reason }) => {
        asked.push(`${name}: ${reason}`);
        return true;
      },
    };

    const result = await new ReActStrategy().run({ ctx, capability: "coder", hooks });

    expect(result.status).toBe("completed");
    expect(result.metadata?.terminal).toBe("answered");
    expect(ran).toEqual(["rm -rf dist"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("destructive shell command");
  });

  it("rejected confirmations become ApprovalRejected observations, run continues", async () => {
    const ran: string[] = [];
    const ctx = ctxFor([{ tool_calls: [shellCall] }, { content: "okay, skipping" }], ran);
    const observations: ToolObservation[] = [];
    const hooks: StrategyHooks = {
      resolveConfirmation: async () => false,
      onToolObserved: (obs) => {
        observations.push(obs);
        ctx.context.pushToolResult(JSON.stringify(obs.result.data, null, 2));
      },
    };

    const result = await new ReActStrategy().run({ ctx, capability: "coder", hooks });

    expect(result.status).toBe("completed");
    expect(ran).toEqual([]); // never executed
    const rejected = observations[0]?.result.data as { error?: string };
    expect(rejected.error).toBe("ApprovalRejected");
    const toolMessages = ctx.context.messages().filter((m) => m.role === "tool");
    expect(toolMessages.some((m) => m.content.includes("ApprovalRejected"))).toBe(true);
  });

  it("headless (no resolver): ConfirmationRequired is the observation", async () => {
    const ran: string[] = [];
    const ctx = ctxFor([{ tool_calls: [shellCall] }, { content: "cannot run that" }], ran);

    const result = await new ReActStrategy().run({ ctx, capability: "coder" });

    expect(result.status).toBe("completed");
    expect(ran).toEqual([]);
    const toolMessages = ctx.context.messages().filter((m) => m.role === "tool");
    expect(toolMessages.some((m) => m.content.includes("ConfirmationRequired"))).toBe(true);
  });
});
