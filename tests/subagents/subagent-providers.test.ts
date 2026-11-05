/**
 * SubagentService + providers: real execution paths, lifecycle accounting,
 * and provider registration honesty.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  SubagentService,
  InProcessSubagentProvider,
  ProcessSubagentProvider,
  ACPSubagentProvider,
  SDKSubagentProvider,
  ExternalAgentSubagentProvider,
  defaultSubagentProviders,
  type SubagentProvider,
} from "../../src/subagents/index.js";
import { AgentRegistry, devAgentDescriptor } from "../../src/runtime/agent/agent-runtime.js";
import { createExecutionContext } from "../../src/runtime/context/execution-context.js";
import { BudgetManager } from "../../src/runtime/budget/budget-manager.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { AllowAllPolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { AgentRuntime, ExecutionContext, ExecutionRequest, ExecutionResult } from "../../src/core/types.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";

/** Runtime that answers immediately, or blocks until its run is cancelled when `block` is set. */
class FakeRuntime implements AgentRuntime {
  readonly agents = new AgentRegistry();
  readonly requests: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly waiters = new Map<string, () => void>();

  constructor(private readonly behavior: { block?: boolean; fail?: boolean } = {}) {
    this.agents.register({ ...devAgentDescriptor(), capabilities: ["coding"] });
  }

  async execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionResult> {
    this.requests.push(request);
    if (this.behavior.fail) throw new Error("model gateway unreachable");
    const base = {
      runId: context.runId,
      agentId: request.agentId,
      strategy: "react" as const,
      usage: { toolCalls: 0, modelCalls: 1, totalTokens: 10, costUsd: 0, elapsedMs: 1 },
    };
    if (this.behavior.block) {
      await new Promise<void>((resolve) => this.waiters.set(context.runId, resolve));
      return { ...base, status: "cancelled", output: "" };
    }
    return { ...base, status: "completed", output: `did: ${request.task.goal} | input: ${request.task.input ?? ""}` };
  }

  cancel(runId: string): boolean {
    this.cancelled.push(runId);
    this.waiters.get(runId)?.();
    return true;
  }
}

function parentContext(): ExecutionContext {
  const modelGateway = {
    route: async () => ({ message: { role: "assistant", content: "ok" } }),
    routeToModel: async () => ({ message: { role: "assistant", content: "ok" } }),
    profiles: () => null as never,
    select: () => [],
  } as unknown as ModelGateway;
  const toolGateway = new DefaultToolGateway({ catalog: new ToolCatalog(), policyEngine: new AllowAllPolicyEngine() });
  const request: ExecutionRequest = { agentId: "devagent", task: { goal: "parent goal" } };
  return {
    ...createExecutionContext(request, { modelGateway, toolGateway }),
    budget: new BudgetManager({ budget: { maxToolCalls: 100, maxModelCalls: 100 } }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("InProcessSubagentProvider", () => {
  it("executes the goal through the runtime and returns its real output", async () => {
    const runtime = new FakeRuntime();
    const provider = new InProcessSubagentProvider({ runtime, agents: runtime.agents });
    const handle = await provider.spawn(
      { provider: "in-process", goal: "fix the bug", requiredCapabilities: ["coding"], contextHandoff: ["a", "b"] },
      parentContext(),
    );
    const result = await handle.promise!;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("did: fix the bug | input: a\nb");
    expect(runtime.requests).toHaveLength(1);
    expect(handle.state).toBe("completed");
  });

  it("requires a parent context and refuses continuable sessions", async () => {
    const runtime = new FakeRuntime();
    const provider = new InProcessSubagentProvider({ runtime, agents: runtime.agents });
    await expect(provider.spawn({ provider: "in-process", goal: "x", childAgentId: "devagent" })).rejects.toThrow(
      /require the parent ExecutionContext/,
    );
    await expect(
      provider.spawn(
        { provider: "in-process", goal: "x", childAgentId: "devagent", continuable: true },
        parentContext(),
      ),
    ).rejects.toThrow(/one-shot/);
  });

  it("interrupt cancels the child run through the runtime", async () => {
    const runtime = new FakeRuntime({ block: true });
    const provider = new InProcessSubagentProvider({ runtime, agents: runtime.agents });
    const handle = await provider.spawn(
      { provider: "in-process", goal: "long task", childAgentId: "devagent" },
      parentContext(),
    );
    await handle.interrupt("stop");
    expect(runtime.cancelled).toEqual([handle.providerRunId]);
    expect(handle.state).toBe("cancelled");
    await expect(handle.promise).resolves.toMatchObject({ status: "cancelled" });
  });

  it("marks the handle failed when the runtime throws", async () => {
    const runtime = new FakeRuntime({ fail: true });
    const provider = new InProcessSubagentProvider({ runtime, agents: runtime.agents });
    const handle = await provider.spawn(
      { provider: "in-process", goal: "x", childAgentId: "devagent" },
      parentContext(),
    );
    await expect(handle.promise).rejects.toThrow(/unreachable/);
    expect(handle.state).toBe("failed");
  });
});

describe("SDKSubagentProvider", () => {
  it("spawn throws without a runtimeFactory", async () => {
    const provider = new SDKSubagentProvider();
    await expect(provider.spawn({ provider: "sdk", goal: "test" }, parentContext())).rejects.toThrow(
      /requires a runtimeFactory/,
    );
  });

  it("creates a fresh runtime per subagent and executes the goal on it", async () => {
    const created: FakeRuntime[] = [];
    const provider = new SDKSubagentProvider({
      runtimeFactory: () => {
        const r = new FakeRuntime();
        created.push(r);
        return r;
      },
    });
    const parent = parentContext();
    const a = await provider.spawn({ provider: "sdk", goal: "first", childAgentId: "devagent" }, parent);
    const b = await provider.spawn({ provider: "sdk", goal: "second", childAgentId: "devagent" }, parent);
    expect((await a.promise!).output).toContain("did: first");
    expect((await b.promise!).output).toContain("did: second");
    expect(created).toHaveLength(2);
    expect(created[0].requests).toHaveLength(1);
    expect(created[1].requests).toHaveLength(1);
  });
});

describe("ExternalAgentSubagentProvider", () => {
  it("runs the binary with the goal substituted and captures stdout", async () => {
    const provider = new ExternalAgentSubagentProvider({
      agent: "generic",
      binaryPath: "/bin/echo",
      extraArgs: ["goal:", "{goal}"],
    });
    const handle = await provider.spawn({ provider: "external", goal: "refactor it" });
    const result = await handle.promise!;
    expect(result).toMatchObject({ status: "completed", output: "goal: refactor it\n" });
    expect(handle.state).toBe("completed");
  });

  it("uses the built-in invocation for claude-code (claude -p <goal>)", async () => {
    const provider = new ExternalAgentSubagentProvider({ agent: "claude-code", binaryPath: "/bin/echo" });
    const result = await (await provider.spawn({ provider: "external", goal: "the goal" })).promise!;
    expect(result.output).toBe("-p the goal\n");
  });

  it("reports a non-zero exit as failed with the stderr tail", async () => {
    const provider = new ExternalAgentSubagentProvider({
      agent: "generic",
      binaryPath: "/bin/sh",
      extraArgs: ["-c", "echo boom >&2; exit 3"],
    });
    const handle = await provider.spawn({ provider: "external", goal: "g" });
    const result = await handle.promise!;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exit code 3.*boom/);
    expect(handle.state).toBe("failed");
  });

  it("exports apiKey only through the configured env var, never argv", async () => {
    const provider = new ExternalAgentSubagentProvider({
      agent: "generic",
      binaryPath: "/bin/sh",
      extraArgs: ["-c", 'printf %s "$AGENT_KEY"'],
      apiKey: "k-123",
      apiKeyEnv: "AGENT_KEY",
    });
    const result = await (await provider.spawn({ provider: "external", goal: "g" })).promise!;
    expect(result.output).toBe("k-123");
  });

  it("truncates output at maxOutputBytes and flags it", async () => {
    const provider = new ExternalAgentSubagentProvider({
      agent: "generic",
      binaryPath: "/bin/echo",
      extraArgs: ["hello world"],
      maxOutputBytes: 5,
    });
    const result = await (await provider.spawn({ provider: "external", goal: "g" })).promise!;
    expect(result.output).toBe("hello");
    expect(result.metadata?.truncated).toBe(true);
  });

  it("rejects on timeout and on a missing binary", async () => {
    const slow = new ExternalAgentSubagentProvider({
      agent: "generic",
      binaryPath: "/bin/sleep",
      timeoutMs: 100,
    });
    const handle = await slow.spawn({ provider: "external", goal: "5" });
    await expect(handle.promise).rejects.toThrow(/timed out/);
    expect(handle.state).toBe("failed");

    const missing = new ExternalAgentSubagentProvider({ agent: "generic", binaryPath: "/nonexistent/agent" });
    await expect((await missing.spawn({ provider: "external", goal: "g" })).promise).rejects.toThrow(/failed to start/);
  });

  it("interrupt terminates the process and marks the handle cancelled", async () => {
    const provider = new ExternalAgentSubagentProvider({ agent: "generic", binaryPath: "/bin/sleep" });
    const handle = await provider.spawn({ provider: "external", goal: "5" });
    await handle.interrupt("user cancel");
    await expect(handle.promise).rejects.toThrow(/user cancel/);
    expect(handle.state).toBe("cancelled");
  });

  it("refuses unconfigured agents and continuable sessions", async () => {
    await expect(
      new ExternalAgentSubagentProvider({ agent: "cursor" }).spawn({ provider: "external", goal: "g" }),
    ).rejects.toThrow(/set binaryPath/);
    await expect(
      new ExternalAgentSubagentProvider({ agent: "generic", binaryPath: "/bin/echo" }).spawn({
        provider: "external",
        goal: "g",
        continuable: true,
      }),
    ).rejects.toThrow(/one-shot/);
  });
});

describe("ProcessSubagentProvider", () => {
  let provider: ProcessSubagentProvider;

  beforeEach(() => {
    // /bin/true exits without answering the JSON-RPC request.
    provider = new ProcessSubagentProvider({ binaryPath: "/bin/true" });
  });

  it("fails the handle when the child exits without responding", async () => {
    const handle = await provider.spawn({ provider: "process", goal: "test process goal" });
    await expect(handle.promise).rejects.toThrow();
    expect(handle.state).toBe("failed");
  });

  it("continuable send() fails once the child is gone", async () => {
    const handle = await provider.spawn({ provider: "process", goal: "c", continuable: true });
    await flush();
    await expect(handle.send("hello")).rejects.toThrow();
  });

  it("one-shot send() throws", async () => {
    const handle = await provider.spawn({ provider: "process", goal: "one-shot" });
    await expect(handle.send("x")).rejects.toThrow(/one-shot process subagent does not support send/);
  });

  it("interrupt cancels the handle", async () => {
    const handle = await provider.spawn({ provider: "process", goal: "test", continuable: true });
    await handle.interrupt("user cancelled");
    expect(handle.state).toBe("cancelled");
  });

  it("stopAll leaves every handle terminal", async () => {
    await provider.spawn({ provider: "process", goal: "a", continuable: true });
    await provider.spawn({ provider: "process", goal: "b", continuable: true });
    await provider.stopAll();
    for (const h of provider.list()) {
      expect(["cancelled", "failed", "completed"]).toContain(h.state);
    }
  });
});

describe("ACPSubagentProvider", () => {
  it("spawn throws without an endpoint", async () => {
    await expect(new ACPSubagentProvider().spawn({ provider: "acp", goal: "test" })).rejects.toThrow(
      /requires an endpoint/,
    );
  });
});

describe("SubagentService accounting", () => {
  function serviceWith(provider: SubagentProvider, maxConcurrent = 2): SubagentService {
    return new SubagentService({ maxConcurrent }).registerProvider(provider);
  }

  it("releases a slot exactly once when a completed child is also cancelled", async () => {
    const runtime = new FakeRuntime();
    const service = serviceWith(new InProcessSubagentProvider({ runtime, agents: runtime.agents }));
    const parent = parentContext();
    const h = await service.spawn({ provider: "in-process", goal: "a", childAgentId: "devagent" }, parent);
    await h.promise;
    await flush();
    expect(service.activeSlots()).toBe(0);
    await service.cancel(h.subagentId);
    expect(service.activeSlots()).toBe(0);
    expect(h.state).toBe("completed");
  });

  it("does not double-release when cancel() races the child's settlement", async () => {
    const runtime = new FakeRuntime({ block: true });
    const service = serviceWith(new InProcessSubagentProvider({ runtime, agents: runtime.agents }), 2);
    const parent = parentContext();
    const a = await service.spawn({ provider: "in-process", goal: "a", childAgentId: "devagent" }, parent);
    await service.spawn({ provider: "in-process", goal: "b", childAgentId: "devagent" }, parent);
    await service.cancel(a.subagentId);
    await a.promise;
    await flush();
    // One slot freed (a), one still held (b): a third spawn fits, a fourth does not.
    expect(service.activeSlots()).toBe(1);
    await service.spawn({ provider: "in-process", goal: "c", childAgentId: "devagent" }, parent);
    await expect(
      service.spawn({ provider: "in-process", goal: "d", childAgentId: "devagent" }, parent),
    ).rejects.toThrow(/concurrency limit/);
  });

  it("frees the slot of a failed child without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const runtime = new FakeRuntime({ fail: true });
      const service = serviceWith(new InProcessSubagentProvider({ runtime, agents: runtime.agents }), 1);
      const h = await service.spawn({ provider: "in-process", goal: "a", childAgentId: "devagent" }, parentContext());
      await expect(h.promise).rejects.toThrow();
      await flush();
      expect(service.activeSlots()).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("concurrent spawns cannot overshoot maxConcurrent", async () => {
    const runtime = new FakeRuntime({ block: true });
    const service = serviceWith(new InProcessSubagentProvider({ runtime, agents: runtime.agents }), 1);
    const parent = parentContext();
    const results = await Promise.allSettled([
      service.spawn({ provider: "in-process", goal: "a", childAgentId: "devagent" }, parent),
      service.spawn({ provider: "in-process", goal: "b", childAgentId: "devagent" }, parent),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(service.activeSlots()).toBe(1);
  });

  it("a failed provider spawn does not leak a slot", async () => {
    const runtime = new FakeRuntime();
    const service = serviceWith(new InProcessSubagentProvider({ runtime, agents: runtime.agents }), 1);
    await expect(
      service.spawn({ provider: "in-process", goal: "no parent", childAgentId: "devagent" }),
    ).rejects.toThrow();
    expect(service.activeSlots()).toBe(0);
  });

  it("throws when spawning with an unregistered provider", async () => {
    await expect(new SubagentService().spawn({ provider: "acp", goal: "test" })).rejects.toThrow(
      /no subagent provider registered for "acp"/,
    );
  });
});

describe("defaultSubagentProviders", () => {
  it("registers only in-process unless other backends are configured", () => {
    const runtime = new FakeRuntime();
    const base = { runtime, agents: runtime.agents };
    expect(defaultSubagentProviders(base).map((p) => p.type)).toEqual(["in-process"]);
    expect(defaultSubagentProviders({ ...base, acp: {} }).map((p) => p.type)).toEqual(["in-process"]);
    expect(defaultSubagentProviders({ ...base, sdk: {} }).map((p) => p.type)).toEqual(["in-process"]);
    const all = defaultSubagentProviders({
      ...base,
      process: { binaryPath: "/bin/true" },
      acp: { endpoint: "http://127.0.0.1:1" },
      sdk: { runtimeFactory: () => new FakeRuntime() },
      external: { agent: "codex" },
    });
    expect(all.map((p) => p.type)).toEqual(["in-process", "process", "acp", "sdk", "external"]);
  });
});
