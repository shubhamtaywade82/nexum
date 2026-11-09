/**
 * A run whose live fan-out fails still ends as completed: the event and the status
 * are persisted first, and live delivery is best-effort. A failed publish that
 * re-entered the failure path would overwrite a completed run with 'failed'.
 */
import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { startRun, type RunServices } from "../../src/host/run-starter.js";
import { RunEventBridge } from "../../src/host/event-bridge.js";
import { CreateRunRequestSchema } from "../../src/protocol/types.js";
import type { Agent } from "../../src/cli/agent.js";

function fakeAgent(): Agent {
  return {
    on: () => undefined,
    startExecutionRun: () => "run-1",
    endExecutionRun: () => undefined,
    cancelExecutionRun: () => false,
    execution: { signal: undefined },
    conversation: { getMessages: () => [], presentationInstructions: "" },
    approvalMode: "ask",
    runUserMessage: async () => "the answer",
  } as unknown as Agent;
}

function services(publish: () => Promise<void>): {
  services: RunServices;
  runsComplete: jest.Mock;
  appended: string[];
} {
  const appended: string[] = [];
  const runsComplete = jest.fn(async () => undefined);
  const agent = fakeAgent();
  const bridge = new RunEventBridge(agent, {});
  const repos = {
    sessions: { touch: async () => undefined },
    messages: { append: async () => undefined },
    runs: {
      create: async (id: string, sessionId: string, goal: string) => ({ id, sessionId, goal, status: "running" }),
      complete: runsComplete,
    },
    events: {
      append: async (event: { type: string }) => {
        appended.push(event.type);
        return appended.length;
      },
    },
  };
  const registry = { getOrCreate: async () => ({ agent, bridge, lastUsedAt: Date.now() }) };
  return {
    services: {
      registry,
      repos,
      eventBus: { publish } as unknown as RunServices["eventBus"],
      runOwners: new Map(),
      activeRuns: new Set(),
      busySessions: new Set(),
    } as unknown as RunServices,
    runsComplete,
    appended,
  };
}

afterEach(() => jest.restoreAllMocks());

describe("a run during a Redis outage", () => {
  it("still ends completed when the live publish fails after the status is persisted", async () => {
    const outage = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const {
      services: svc,
      runsComplete,
      appended,
    } = services(async () => {
      throw new Error("Redis publish timed out");
    });

    const started = await startRun(svc, "session-1", CreateRunRequestSchema.parse({ goal: "say hello" }));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.done;

    expect(runsComplete).toHaveBeenCalledTimes(1);
    expect(runsComplete.mock.calls[0][1]).toBe("completed");
    expect(appended).toContain("run.completed");
    expect(appended).not.toContain("run.failed");
    outage.mockRestore();
  });
});
