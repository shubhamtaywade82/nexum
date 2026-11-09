/**
 * Concurrent first requests for one session must share one Agent. Creating an
 * Agent starts child processes, so a second construction that overwrote the
 * first would leak them and split the session's state.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { HostAgentRegistry } from "../../src/host/agent-registry.js";
import type { Agent } from "../../src/cli/agent.js";

function fakeAgent(): Agent {
  return {
    on: () => undefined,
    mcpHostConfig: () => ({ servers: [], trust: undefined, credentials: {} }),
    tools: { registerMcpTools: () => ({ skipped: [] }) },
    startHost: async () => undefined,
    stopHost: async () => undefined,
    resumeSessionById: () => false,
    sessions: { adopt: () => undefined },
  } as unknown as Agent;
}

let registry: HostAgentRegistry | undefined;
afterEach(async () => {
  await registry?.stopAll();
  registry = undefined;
});

describe("HostAgentRegistry.getOrCreate under concurrency", () => {
  it("concurrent first requests for one session construct one agent and share it", async () => {
    let constructed = 0;
    registry = new HostAgentRegistry({
      createAgent: () => {
        constructed += 1;
        return fakeAgent();
      },
    });

    const [a, b, c] = await Promise.all([
      registry.getOrCreate("session-1"),
      registry.getOrCreate("session-1"),
      registry.getOrCreate("session-1"),
    ]);

    expect(constructed).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(registry.peek("session-1")).toBe(a);
  });

  it("different sessions still get separate agents", async () => {
    registry = new HostAgentRegistry({ createAgent: () => fakeAgent() });
    const [a, b] = await Promise.all([registry.getOrCreate("s1"), registry.getOrCreate("s2")]);
    expect(a).not.toBe(b);
  });

  it("a failed creation is not cached: the next request builds again", async () => {
    let attempts = 0;
    registry = new HostAgentRegistry({
      createAgent: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return fakeAgent();
      },
    });

    await expect(registry.getOrCreate("s1")).rejects.toThrow("boom");
    const entry = await registry.getOrCreate("s1");
    expect(attempts).toBe(2);
    expect(registry.peek("s1")).toBe(entry);
  });
});
