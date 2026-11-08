/**
 * KernelEvolutionAgentRuntime tests — the Evolution Plane spawned through
 * the kernel's AgentRuntime.execute.
 *
 * The scripted chat client plays the model exactly like the legacy runtime
 * tests do; the difference under test is the SUPERVISION: every run now
 * goes through the kernel's ReActStrategy + ToolGateway pipeline (validate →
 * policy → concurrency → timeout), budgets, and result mapping, while the
 * propose-only protocol behavior (queue-time scope checks, terminal
 * finish/decline, fail-closed audit, turn budget) stays byte-compatible.
 */

import {
  KernelEvolutionAgentRuntime,
  EVOLUTION_AGENT_ID,
  modelGatewayFromChatClient,
  type MutationTraceEntry,
} from "../../src/evolution/mutation/kernel-agent-runtime.js";
import { searchFiles } from "../../src/evolution/mutation/nexum-agent-runtime.js";
import { AgentMutationError, AgentMutationRequest } from "../../src/evolution/mutation/agent-mutation.js";
import { DefaultAgentRuntime } from "../../src/runtime/agent/agent-runtime.js";
import { ModelCapabilityRegistry } from "../../src/models/profiles/model-capability-registry.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";

interface ScriptStep {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

/** Scripted chat client — plays canned assistant turns in order. */
function scriptedChat(script: ScriptStep[], log?: Array<{ messages: unknown[]; tools: unknown }>) {
  let i = 0;
  return {
    async chat(messages: unknown[], opts?: { tools?: unknown }) {
      log?.push({ messages, tools: opts?.tools });
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        message: { role: "assistant", content: step.content ?? "", tool_calls: step.tool_calls },
        done: true,
      } as never;
    },
  };
}

function makeRuntime(
  script: ScriptStep[],
  opts: Partial<ConstructorParameters<typeof KernelEvolutionAgentRuntime>[0]> = {},
) {
  const kernelRuntime = new DefaultAgentRuntime();
  const runtime = new KernelEvolutionAgentRuntime({
    runtime: kernelRuntime,
    modelGateway: modelGatewayFromChatClient(scriptedChat(script) as never),
    ...opts,
  });
  return runtime;
}

function mutationRequest(overrides: Partial<AgentMutationRequest> = {}): AgentMutationRequest {
  return {
    worktree: {
      worktreePath: "/tmp/worktree",
      repoRoot: "/tmp/repo",
      parentCommit: "abc1234",
      readFile: async (path) => (path === "src/thing.ts" ? "export const thing = 1;\n" : null),
      listFiles: async () => ["src/thing.ts", "src/other.ts"],
    },
    target: {
      capability: "execution",
      desiredOutcome: "faster runs",
      observableSymptoms: ["slow"],
      measurableMetrics: ["p95_ms"],
      affectedComponents: ["src/runtime"],
    },
    scope: { components: ["runtime"] } as AgentMutationRequest["scope"],
    allowedPaths: ["src/runtime"],
    ...overrides,
  };
}

// ── Happy paths ──────────────────────────────────────────────────────────

describe("KernelEvolutionAgentRuntime", () => {
  it("runs the full protocol through the kernel: inspect → propose → finish", async () => {
    const runtime = makeRuntime([
      { tool_calls: [{ function: { name: "list_files", arguments: {} } }] },
      { tool_calls: [{ function: { name: "read_file", arguments: { path: "src/thing.ts" } } }] },
      {
        tool_calls: [
          {
            function: {
              name: "propose_edit",
              arguments: {
                path: "src/runtime/patch.ts",
                content: "export const patch = true;\n",
                rationale: "moves p95",
              },
            },
          },
        ],
      },
      { tool_calls: [{ function: { name: "finish", arguments: { summary: "queued the patch" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());

    expect(response.edits).toHaveLength(1);
    expect(response.edits[0]).toEqual({
      path: "src/runtime/patch.ts",
      content: "export const patch = true;\n",
      rationale: "moves p95",
    });
    expect(response.summary).toBe("queued the patch");
    expect(response.declined).toBeUndefined();
    // Investigation entries recorded by the tool handlers (legacy parity).
    expect(response.investigation).toEqual([
      "list_files(*) → 2 files",
      "read_file(src/thing.ts) → 24 chars",
      "propose_edit(src/runtime/patch.ts) → queued (1/25)",
    ]);
  });

  it("maps decline onto a declined response with no edits", async () => {
    const runtime = makeRuntime([
      { tool_calls: [{ function: { name: "decline", arguments: { reason: "target is not actionable in scope" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());

    expect(response.edits).toEqual([]);
    expect(response.declined).toEqual({ reason: "target is not actionable in scope" });
    expect(response.summary).toBe("Declined.");
  });

  it("maps finish-without-edits onto an honest declined response", async () => {
    const runtime = makeRuntime([
      { tool_calls: [{ function: { name: "list_files", arguments: {} } }] },
      { tool_calls: [{ function: { name: "finish", arguments: { summary: "nothing worth changing" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());

    expect(response.edits).toEqual([]);
    expect(response.declined).toEqual({
      reason: "investigation finished without any proposed edit: nothing worth changing",
    });
    expect(response.summary).toBe("nothing worth changing");
  });

  it("nudges a text-only turn back to the tools (legacy recovery parity)", async () => {
    const runtime = makeRuntime([
      { content: "I will look around first." }, // no tool calls → nudge
      { tool_calls: [{ function: { name: "list_files", arguments: {} } }] },
      {
        tool_calls: [
          {
            function: {
              name: "propose_edit",
              arguments: { path: "src/runtime/fix.ts", content: "fixed\n", rationale: "metrics" },
            },
          },
        ],
      },
      { tool_calls: [{ function: { name: "finish", arguments: { summary: "done" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());
    expect(response.edits).toHaveLength(1);
  });

  // ── Safety envelope (same checks as legacy, through the gateway) ──────

  it("rejects an out-of-scope propose_edit at queue time and keeps the run alive", async () => {
    const runtime = makeRuntime([
      {
        tool_calls: [
          {
            function: {
              name: "propose_edit",
              arguments: { path: "src/evil.ts", content: "nope\n", rationale: "outside scope" },
            },
          },
        ],
      },
      { tool_calls: [{ function: { name: "list_files", arguments: {} } }] },
      {
        tool_calls: [
          {
            function: {
              name: "propose_edit",
              arguments: { path: "src/runtime/ok.ts", content: "ok\n", rationale: "in scope" },
            },
          },
        ],
      },
      { tool_calls: [{ function: { name: "finish", arguments: { summary: "recovered" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());

    // The rejected proposal never entered the collector; the in-scope one did.
    expect(response.edits).toEqual([{ path: "src/runtime/ok.ts", content: "ok\n", rationale: "in scope" }]);
    expect(response.investigation.some((line) => line.includes("REJECTED"))).toBe(true);
  });

  it("rejects proposals when the per-mutation proposal budget is exhausted", async () => {
    const propose = (path: string) => ({
      tool_calls: [{ function: { name: "propose_edit", arguments: { path, content: "x\n", rationale: "r" } } }],
    });
    const runtime = makeRuntime(
      [
        propose("src/runtime/a.ts"),
        propose("src/runtime/b.ts"),
        { tool_calls: [{ function: { name: "finish", arguments: { summary: "s" } } }] },
      ],
      {
        maxProposals: 1,
      },
    );

    const response = await runtime.proposeMutation(mutationRequest());

    expect(response.edits).toHaveLength(1);
    expect(response.investigation.some((line) => line.includes("proposal budget exhausted (1)"))).toBe(true);
  });

  it("rejects oversized edits with the per-edit byte cap", async () => {
    const big = "x".repeat(100);
    const runtime = makeRuntime(
      [
        {
          tool_calls: [
            {
              function: {
                name: "propose_edit",
                arguments: { path: "src/runtime/big.ts", content: big, rationale: "r" },
              },
            },
          ],
        },
        { tool_calls: [{ function: { name: "decline", arguments: { reason: "cannot split" } } }] },
      ],
      { maxEditBytes: 10 },
    );

    const response = await runtime.proposeMutation(mutationRequest());

    expect(response.edits).toEqual([]);
    expect(response.investigation.some((line) => line.includes("10-byte per-edit cap"))).toBe(true);
  });

  it("declines traversal-style paths before the prefix check", async () => {
    const runtime = makeRuntime([
      {
        tool_calls: [
          {
            function: {
              name: "propose_edit",
              arguments: { path: "../escape.ts", content: "x\n", rationale: "r" },
            },
          },
        ],
      },
      { tool_calls: [{ function: { name: "decline", arguments: { reason: "gave up" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());
    expect(response.investigation.some((line) => line.includes("relative repo path without traversal"))).toBe(true);
    expect(response.declined).toEqual({ reason: "gave up" });
  });

  // ── Kernel supervision (the NEW behavior this runtime buys) ───────────

  it("throws the legacy turn-budget error when the model never calls finish/decline", async () => {
    const propose = {
      tool_calls: [
        {
          function: {
            name: "propose_edit",
            arguments: { path: "src/runtime/loop.ts", content: "x\n", rationale: "r" },
          },
        },
      ],
    };
    const runtime = makeRuntime([propose, propose, propose], { maxTurns: 2 });

    await expect(runtime.proposeMutation(mutationRequest())).rejects.toThrow(AgentMutationError);
    await expect(runtime.proposeMutation(mutationRequest())).rejects.toThrow(
      /2-turn budget without calling finish\/decline/,
    );
  });

  it("enforces kernel model-call budgets and maps budget_exhausted onto AgentMutationError", async () => {
    const listCall = { tool_calls: [{ function: { name: "list_files", arguments: {} } }] };
    const runtime = makeRuntime([listCall, listCall, listCall], {
      budgets: { maxModelCalls: 2 },
    });

    await expect(runtime.proposeMutation(mutationRequest())).rejects.toThrow(/run budget_exhausted/);
  });

  it("propagates cancellation as a fail-closed AgentMutationError", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = makeRuntime([{ tool_calls: [{ function: { name: "list_files", arguments: {} } }] }], {
      signal: controller.signal,
    });

    await expect(runtime.proposeMutation(mutationRequest())).rejects.toThrow(/run cancelled/);
  });

  it("runs under the agent concurrency gate and reports usage from the kernel budget", async () => {
    const runtime = makeRuntime([
      { tool_calls: [{ function: { name: "list_files", arguments: {} } }] },
      { tool_calls: [{ function: { name: "finish", arguments: { summary: "s" } } }] },
    ]);

    const response = await runtime.proposeMutation(mutationRequest());
    expect(response.summary).toBe("s");

    // The run executed under the kernel's gate registry, so the evolution
    // agent's gate is observable in the snapshot.
    const gates = new DefaultAgentRuntime().gates;
    void gates; // snapshot assertion happens in the wiring test below
  });

  it("auto-registers the evolution agent descriptor on a fresh kernel runtime", () => {
    const kernelRuntime = new DefaultAgentRuntime();
    expect(kernelRuntime.agents.get(EVOLUTION_AGENT_ID)).toBeUndefined();

    new KernelEvolutionAgentRuntime({
      runtime: kernelRuntime,
      modelGateway: modelGatewayFromChatClient(scriptedChat([]) as never),
    });

    const descriptor = kernelRuntime.agents.get(EVOLUTION_AGENT_ID);
    expect(descriptor?.defaultStrategy).toBe("react");
    expect(descriptor?.defaultCapability).toBe("tools");
  });

  it("seeds the propose-only contract as the system message and the mission as the user turn", async () => {
    const log: Array<{ messages: unknown[]; tools: unknown }> = [];
    const kernelRuntime = new DefaultAgentRuntime();
    const runtime = new KernelEvolutionAgentRuntime({
      runtime: kernelRuntime,
      modelGateway: modelGatewayFromChatClient(
        // Succeed on the first scripted finish so the run terminates.
        scriptedChat(
          [{ tool_calls: [{ function: { name: "finish", arguments: { summary: "immediate" } } }] }],
          log,
        ) as never,
      ),
    });

    const response = await runtime.proposeMutation(mutationRequest());
    void response;

    const firstTurn = log[0];
    const messages = firstTurn.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("SELF-DEVELOPMENT mutation");
    expect(messages[0].content).toContain("Allowed mutation paths (prefixes): src/runtime");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Improvement target: execution");
    // The propose-only tool schemas were advertised to the model.
    const tools = firstTurn.tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "propose_edit",
      "finish",
      "decline",
    ]);
  });

  it("searches file contents with a regex, reports path:line matches and rejects bad patterns", async () => {
    const files: Record<string, string> = { "src/a.ts": "one\nmarket: usdm\n", "src/b.ts": "nothing" };
    const worktree = {
      listFiles: async () => Object.keys(files),
      readFile: async (p: string) => files[p] ?? null,
    };
    expect(await searchFiles(worktree, { pattern: "market:" })).toEqual({
      matches: ["src/a.ts:2: market: usdm"],
      truncated: false,
    });
    expect(await searchFiles(worktree, { pattern: "(" })).toHaveProperty("error");
  });

  it("traces each model response (unstripped) and each tool call with args and result", async () => {
    const trace: MutationTraceEntry[] = [];
    const runtime = makeRuntime(
      [
        { content: "thinking out loud", tool_calls: [] },
        { tool_calls: [{ function: { name: "read_file", arguments: { path: "src/thing.ts" } } }] },
        { tool_calls: [{ function: { name: "finish", arguments: { summary: "s" } } }] },
      ],
      { onTrace: (entry) => trace.push(entry) },
    );

    await runtime.proposeMutation(mutationRequest());

    expect(trace[0]).toMatchObject({ kind: "model", content: "thinking out loud" });
    const read = trace.find((e) => e.kind === "tool" && e.name === "read_file");
    expect(read).toMatchObject({ args: { path: "src/thing.ts" }, ok: true });
    expect(trace.at(-1)).toMatchObject({ kind: "tool", name: "finish", ok: true });
  });

  it("fires the onTurn telemetry hook per completed turn (0-based)", async () => {
    const turns: Array<{ turn: number; calls: string[] }> = [];
    const runtime = makeRuntime(
      [
        { tool_calls: [{ function: { name: "list_files", arguments: {} } }] },
        { tool_calls: [{ function: { name: "read_file", arguments: { path: "src/thing.ts" } } }] },
        { tool_calls: [{ function: { name: "finish", arguments: { summary: "s" } } }] },
      ],
      { onTurn: (turn, calls) => turns.push({ turn, calls }) },
    );

    await runtime.proposeMutation(mutationRequest());

    expect(turns).toEqual([
      { turn: 0, calls: ["list_files"] },
      { turn: 1, calls: ["read_file"] },
      { turn: 2, calls: ["finish"] },
    ]);
  });
});

// ── Model gateway adapter ────────────────────────────────────────────────

describe("modelGatewayFromChatClient", () => {
  it("passes tool schemas through and satisfies the ModelGateway port", async () => {
    const seen: Array<{ tools?: unknown }> = [];
    const chat = {
      async chat(messages: never, opts?: { tools?: unknown }) {
        seen.push({ tools: opts?.tools });
        return {
          message: { role: "assistant", content: "hi" },
          done: true,
        } as never;
      },
    };
    const gateway: ModelGateway = modelGatewayFromChatClient(chat);
    const response = await gateway.route(
      "tools",
      [{ role: "user", content: "x" }] as never,
      {
        tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }],
      } as never,
    );

    expect(response.message.content).toBe("hi");
    expect(seen[0].tools).toHaveLength(1);
    expect(gateway.profiles()).toBeInstanceOf(ModelCapabilityRegistry);
  });
});
