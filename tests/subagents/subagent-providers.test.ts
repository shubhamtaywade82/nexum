/**
 * Tests for the implemented SubagentService providers.
 *
 * Verifies that the previously-stub providers (Process, ACP, SDK, External)
 * now produce working SubagentHandles that support the full lifecycle:
 * spawn → send/interrupt/resume/fork → completion.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SubagentService,
  ProcessSubagentProvider,
  ACPSubagentProvider,
  SDKSubagentProvider,
  ExternalAgentSubagentProvider,
  type SubagentHandle,
} from "../../src/subagents/index.js";
import { DefaultAgentRuntime, devAgentDescriptor } from "../../src/runtime/agent/agent-runtime.js";

describe("ProcessSubagentProvider", () => {
  let provider: ProcessSubagentProvider;

  beforeEach(() => {
    // Use a stub binary that immediately exits with code 0 — this lets us
    // test the spawn/list/stopAll logic without requiring an actual `nexum rpc`
    // server. The handle's promise will reject (child exits before responding)
    // but all other lifecycle methods still work.
    provider = new ProcessSubagentProvider({ binaryPath: "/bin/true" });
  });

  it("spawns a one-shot subagent (rejects when child exits without response)", async () => {
    const handle = await provider.spawn({
      provider: "process",
      goal: "test process goal",
    });
    expect(handle.provider).toBe("process");
    expect(handle.state).toBe("running");
    expect(handle.promise).toBeDefined();
    // The child exits immediately, so the promise should reject.
    await expect(handle.promise).rejects.toThrow();
    // The handle's state may transition to failed after the exit.
    expect(["failed", "cancelled", "running"]).toContain(handle.state);
  });

  it("spawns a continuable subagent and the child can be killed via send() failure", async () => {
    const handle = await provider.spawn({
      provider: "process",
      goal: "continuable process",
      continuable: true,
    });
    expect(handle.continuable).toBe(true);
    expect(handle.promise).toBeUndefined();
    // send() should throw because the child is dead.
    await expect(handle.send("hello")).rejects.toThrow();
  });

  it("one-shot send() throws", async () => {
    const handle = await provider.spawn({
      provider: "process",
      goal: "one-shot",
    });
    await expect(handle.send("x")).rejects.toThrow(/one-shot process subagent does not support send/);
  });

  it("interrupt cancels the handle", async () => {
    const handle = await provider.spawn({
      provider: "process",
      goal: "test",
      continuable: true,
    });
    await handle.interrupt("user cancelled");
    expect(handle.state).toBe("cancelled");
  });

  it("fork creates a new handle", async () => {
    const handle = await provider.spawn({
      provider: "process",
      goal: "original goal",
      continuable: true,
    });
    const forked = await handle.fork();
    expect(forked.subagentId).not.toBe(handle.subagentId);
    expect(forked.request.goal).toContain("forked from");
  });

  it("list returns all spawned handles", async () => {
    await provider.spawn({ provider: "process", goal: "a" });
    await provider.spawn({ provider: "process", goal: "b" });
    expect(provider.list().length).toBe(2);
  });

  it("stopAll cancels everything", async () => {
    await provider.spawn({ provider: "process", goal: "a", continuable: true });
    await provider.spawn({ provider: "process", goal: "b", continuable: true });
    await provider.stopAll();
    // After stopAll, all handles should be in a terminal state.
    for (const h of provider.list()) {
      expect(["cancelled", "failed", "completed"]).toContain(h.state);
    }
  });
});

describe("ACPSubagentProvider", () => {
  it("spawn throws without an endpoint", async () => {
    const provider = new ACPSubagentProvider();
    await expect(
      provider.spawn({ provider: "acp", goal: "test" }),
    ).rejects.toThrow(/requires an endpoint/);
  });

  it("spawn returns a handle when endpoint is set (one-shot, may fail to connect)", async () => {
    const provider = new ACPSubagentProvider({
      endpoint: "http://nonexistent.example.com",
    });
    const handle = await provider.spawn({
      provider: "acp",
      goal: "test acp",
    });
    expect(handle.provider).toBe("acp");
    // The fetch will fail (DNS resolution), but the handle is returned.
    // The promise should reject.
    await expect(handle.promise).rejects.toThrow();
    // State should be failed after the network error.
    expect(handle.state).toBe("failed");
  });
});

describe("SDKSubagentProvider", () => {
  let runtime: DefaultAgentRuntime;

  beforeEach(() => {
    runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
  });

  it("spawn throws without a runtimeFactory", async () => {
    const provider = new SDKSubagentProvider();
    await expect(
      provider.spawn({ provider: "sdk", goal: "test" }),
    ).rejects.toThrow(/requires a runtimeFactory/);
  });

  it("spawns with an isolated runtime", async () => {
    const provider = new SDKSubagentProvider({
      runtimeFactory: () => runtime,
    });
    const handle = await provider.spawn({
      provider: "sdk",
      goal: "test sdk",
    });
    expect(handle.provider).toBe("sdk");
    const result = await handle.promise!;
    expect(result.status).toBe("completed");
    expect(result.output).toContain("test sdk");
    expect(result.metadata?.isolated).toBe(true);
  });

  it("continuable supports send()", async () => {
    const provider = new SDKSubagentProvider({
      runtimeFactory: () => runtime,
    });
    const handle = await provider.spawn({
      provider: "sdk",
      goal: "continuable",
      continuable: true,
    });
    const r1 = await handle.send("message 1");
    const r2 = await handle.send("message 2");
    expect(r1.metadata?.messagesProcessed).toBe(1);
    expect(r2.metadata?.messagesProcessed).toBe(2);
  });
});

describe("ExternalAgentSubagentProvider", () => {
  it("spawns a one-shot external subagent", async () => {
    const provider = new ExternalAgentSubagentProvider({ agent: "claude-code" });
    const handle = await provider.spawn({
      provider: "external",
      goal: "test external",
    });
    expect(handle.provider).toBe("external");
    const result = await handle.promise!;
    expect(result.status).toBe("completed");
    expect(result.metadata?.agent).toBe("claude-code");
  });

  it("continuable external supports send()", async () => {
    const provider = new ExternalAgentSubagentProvider({ agent: "codex" });
    const handle = await provider.spawn({
      provider: "external",
      goal: "continuable",
      continuable: true,
    });
    const result = await handle.send("hi");
    expect(result.output).toContain("codex");
    expect(result.output).toContain("hi");
  });

  it("interrupt cancels the handle", async () => {
    const provider = new ExternalAgentSubagentProvider({ agent: "cursor" });
    const handle = await provider.spawn({
      provider: "external",
      goal: "test",
      continuable: true,
    });
    await handle.interrupt("user cancel");
    expect(handle.state).toBe("cancelled");
  });
});

describe("SubagentService (with all providers)", () => {
  let tmpDir: string;
  let service: SubagentService;
  let runtime: DefaultAgentRuntime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-subagents-"));
    runtime = new DefaultAgentRuntime();
    runtime.agents.register(devAgentDescriptor());
    service = new SubagentService({
      runtime,
      agents: runtime.agents,
      maxConcurrent: 4,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists registered providers when registered", () => {
    service.registerProvider(new ProcessSubagentProvider());
    service.registerProvider(new ExternalAgentSubagentProvider({ agent: "generic" }));
    expect(service.listProviders().length).toBe(2);
    expect(service.listProviders()).toContain("process");
    expect(service.listProviders()).toContain("external");
  });

  it("throws when spawning with an unregistered provider", async () => {
    await expect(
      service.spawn({ provider: "acp", goal: "test" }),
    ).rejects.toThrow(/no subagent provider registered for "acp"/);
  });

  it("spawn + list + cancel", async () => {
    service.registerProvider(new ProcessSubagentProvider());
    const handle = await service.spawn({
      provider: "process",
      goal: "test",
      continuable: true,
    });
    expect(service.list().length).toBe(1);
    await service.cancel(handle.subagentId, "test cancel");
    expect(handle.state).toBe("cancelled");
  });

  it("enforces concurrency limit", async () => {
    service.registerProvider(new ProcessSubagentProvider());
    // Spawn 4 (max concurrent).
    for (let i = 0; i < 4; i++) {
      await service.spawn({
        provider: "process",
        goal: `job ${i}`,
        continuable: true,
      });
    }
    // 5th should throw.
    await expect(
      service.spawn({ provider: "process", goal: "5th", continuable: true }),
    ).rejects.toThrow(/concurrency limit/);
  });
});
