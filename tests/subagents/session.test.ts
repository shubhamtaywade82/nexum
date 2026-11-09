/**
 * SubagentSession: the single owner of a subagent's lifecycle state. These
 * pin the transition table and the settlement rules every provider relies on.
 */
import { describe, it, expect } from "@jest/globals";
import { SubagentSession, SUBAGENT_TRANSITIONS, isLiveState } from "../../src/subagents/session.js";
import type { SubagentResult, SubagentSpawnRequest } from "../../src/subagents/contracts.js";

const request: SubagentSpawnRequest = { provider: "external", goal: "g" };

function result(status: SubagentResult["status"], subagentId = "sub"): SubagentResult {
  return { subagentId, status, output: `${status} output` };
}

describe("SUBAGENT_TRANSITIONS", () => {
  it("makes completed, failed and cancelled absorbing", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      expect(SUBAGENT_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("allows only the documented live transitions", () => {
    expect(SUBAGENT_TRANSITIONS.pending).toEqual(["running", "cancelled", "failed"]);
    expect(SUBAGENT_TRANSITIONS.running).toEqual(["paused", "completed", "failed", "cancelled"]);
    expect(SUBAGENT_TRANSITIONS.paused).toEqual(["running", "completed", "cancelled", "failed"]);
  });
});

describe("isLiveState", () => {
  it("is true for pending, running and paused only", () => {
    expect(isLiveState("pending")).toBe(true);
    expect(isLiveState("running")).toBe(true);
    expect(isLiveState("paused")).toBe(true);
    expect(isLiveState("completed")).toBe(false);
    expect(isLiveState("failed")).toBe(false);
    expect(isLiveState("cancelled")).toBe(false);
  });
});

describe("SubagentSession", () => {
  it("starts running with its own identifiers", () => {
    const session = new SubagentSession({ provider: "external", request });
    expect(session.state).toBe("running");
    expect(session.live).toBe(true);
    expect(session.subagentId).toMatch(/\S+/);
    expect(session.providerRunId).toMatch(/\S+/);
  });

  it("maps a completed result to completed and resolves the one-shot promise", async () => {
    const session = new SubagentSession({ provider: "external", request });
    session.complete(result("completed"));
    await expect(session.promise).resolves.toMatchObject({ status: "completed", output: "completed output" });
    expect(session.state).toBe("completed");
  });

  it("maps a failed result to failed", async () => {
    const session = new SubagentSession({ provider: "external", request });
    session.complete(result("failed"));
    await expect(session.promise).resolves.toMatchObject({ status: "failed" });
    expect(session.state).toBe("failed");
  });

  it("a late cancel cannot overwrite a completed session", () => {
    const session = new SubagentSession({ provider: "external", request });
    session.complete(result("completed"));
    expect(session.cancel("late")).toBe(false);
    expect(session.state).toBe("completed");
  });

  it("a late failure cannot overwrite a completed session", async () => {
    const session = new SubagentSession({ provider: "external", request });
    session.complete(result("completed"));
    session.fail(new Error("late"));
    await expect(session.promise).resolves.toMatchObject({ status: "completed" });
    expect(session.state).toBe("completed");
  });

  it("markCancelled keeps the one-shot promise open for the child's own settlement", async () => {
    const session = new SubagentSession({ provider: "in-process", request });
    expect(session.markCancelled()).toBe(true);
    expect(session.state).toBe("cancelled");
    session.complete(result("cancelled"));
    await expect(session.promise).resolves.toMatchObject({ status: "cancelled" });
    expect(session.state).toBe("cancelled");
  });

  it("cancel rejects the one-shot promise with the reason", async () => {
    const session = new SubagentSession({ provider: "external", request });
    expect(session.cancel("user stop")).toBe(true);
    await expect(session.promise).rejects.toThrow("user stop");
    expect(session.state).toBe("cancelled");
  });

  it("the first settlement wins", async () => {
    const session = new SubagentSession({ provider: "external", request });
    session.fail(new Error("boom"));
    session.complete(result("completed"));
    await expect(session.promise).rejects.toThrow("boom");
    expect(session.state).toBe("failed");
  });

  it("terminated resolves once, with the terminal state", async () => {
    const session = new SubagentSession({ provider: "external", request });
    session.cancel("stop");
    session.fail(new Error("ignored"));
    await expect(session.terminated).resolves.toBe("cancelled");
  });

  it("continuable sessions expose no one-shot promise but still reach a terminal state", async () => {
    const continuable = { ...request, provider: "process" as const, continuable: true };
    const session = new SubagentSession({ provider: "process", request: continuable, continuable: true });
    expect(session.promise).toBeUndefined();
    session.fail(new Error("child exited"));
    await expect(session.terminated).resolves.toBe("failed");
  });

  it("toHandle exposes the session state read-only and keeps it authoritative", () => {
    const session = new SubagentSession({ provider: "external", request });
    const handle = session.toHandle({
      send: async () => result("completed"),
      interrupt: async () => {},
      resume: async () => result("completed"),
      fork: async () => {
        throw new Error("unused");
      },
    });
    expect(handle.subagentId).toBe(session.subagentId);
    expect(handle.providerRunId).toBe(session.providerRunId);
    expect(handle.state).toBe("running");
    session.cancel("stop");
    expect(handle.state).toBe("cancelled");
  });
});
