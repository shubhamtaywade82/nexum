/**
 * Tests for the SupervisorAgent: assignment, retry, merge, stall detection,
 * and the bus-backed default task port.
 */
import { describe, it, expect } from "@jest/globals";
import {
  SupervisorAgent,
  newSupervisorTask,
  type TaskPortResult,
  type SupervisorTask,
} from "../../src/multiagent/supervisor.js";
import { AgentMessageBus } from "../../src/multiagent/bus/message-bus.js";
import { SharedStateStore } from "../../src/multiagent/shared-state.js";

const workers = [
  { agentId: "researcher", capabilities: ["research"] },
  { agentId: "analyst", capabilities: ["analysis"] },
];

function makeSupervisor(
  onTask: (task: SupervisorTask, worker: { agentId: string }) => Promise<TaskPortResult>,
  opts: { plannerTasks?: string[] } = {},
) {
  const sharedState = new SharedStateStore({ goal: "unused" });
  const plannerTasks = opts.plannerTasks ?? ["research the topic", "analyze the findings"];
  const supervisor = new SupervisorAgent({
    sharedState,
    workers,
    planner: (goal) => plannerTasks.map((t) => newSupervisorTask(t, goal)),
    onTask,
    policy: { taskTimeoutMs: 500, retryLimit: 1, maxRounds: 4 },
  });
  return { supervisor, sharedState };
}

describe("SupervisorAgent", () => {
  it("assigns tasks, merges results into shared state, and completes", async () => {
    const { supervisor, sharedState } = makeSupervisor(async (task, worker) => ({
      status: "done",
      output: `${task.goal} by ${worker.agentId}`,
      artifacts: [{ artifactId: `art_${task.id.slice(-6)}`, name: `${task.goal}-output`, version: 1 }],
    }));

    const result = await supervisor.orchestrate("produce the quarterly report");

    expect(result.status).toBe("completed");
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every((t) => t.status === "done")).toBe(true);
    const state = sharedState.snapshot();
    expect(state.goal).toBe("produce the quarterly report");
    expect(state.findings).toHaveLength(2);
    expect(state.findings[0].summary).toContain("→ done");
    expect(state.artifacts).toHaveLength(2);
    expect(state.agentStatuses.every((s) => s.state === "done")).toBe(true);
    expect(result.summary).toContain("2/2");
  });

  it("retries failed tasks once, then marks them permanently failed", async () => {
    const attemptsByGoal = new Map<string, number>();
    const { supervisor, sharedState } = makeSupervisor(async (task) => {
      if (task.goal.includes("research")) {
        attemptsByGoal.set(task.goal, (attemptsByGoal.get(task.goal) ?? 0) + 1);
        return { status: "failed", output: "", error: "source unreachable" };
      }
      return { status: "done", output: "analysis complete" };
    });

    const result = await supervisor.orchestrate("g");

    const research = result.tasks.find((t) => t.goal.includes("research"))!;
    expect(research.status).toBe("permanently-failed");
    expect(attemptsByGoal.get(research.goal)).toBe(2); // initial + 1 retry
    expect(research.error).toBe("source unreachable");
    expect(result.tasks.find((t) => t.goal.includes("analyze"))?.status).toBe("done");
    expect(sharedState.snapshot().decisions.some((d) => d.rationale.includes("permanently"))).toBe(true);
  });

  it("detects stalls when a round completes nothing", async () => {
    const { supervisor, sharedState } = makeSupervisor(
      async () => ({ status: "failed", output: "", error: "blocked" }),
      { plannerTasks: ["one task"] },
    );

    const result = await supervisor.orchestrate("g");
    expect(result.status).toBe("stalled");
    expect(result.summary).toContain("no progress");
    expect(sharedState.snapshot().decisions.some((d) => d.rationale.includes("stalled"))).toBe(true);
  });

  it("stops at max rounds when tasks keep being reassigned without progress", async () => {
    const sharedState = new SharedStateStore({ goal: "g" });
    const noStall = new SupervisorAgent({
      sharedState,
      workers,
      planner: () => [newSupervisorTask("loop")],
      onTask: async () => ({ status: "failed", output: "", error: "x" }),
      policy: { maxRounds: 2, retryLimit: 99, taskTimeoutMs: 100, stopOnNoProgress: false },
    });
    const result = await noStall.orchestrate("g");
    expect(result.status).toBe("max-rounds");
    expect(result.rounds).toBe(2);
    expect(result.summary).toContain("unfinished");
  });

  it("assigns round-robin across workers", async () => {
    const assignments: string[] = [];
    const { supervisor } = makeSupervisor(async (task, worker) => {
      assignments.push(`${task.goal}:${worker.agentId}`);
      return { status: "done", output: "ok" };
    });
    await supervisor.orchestrate("g");
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((a) => a.split(":")[1])).size).toBe(2);
  });

  it("drives real workers over the bus through the default task port", async () => {
    const bus = new AgentMessageBus();
    bus.register("supervisor");
    const researcher = bus.register("researcher");
    researcher.onMessage((message) => {
      if (message.type === "coord.task.assign") {
        const payload = message.payload as { goal: string };
        bus.reply(message, "coord.task.result", {
          taskId: (message.payload as { taskId: string }).taskId,
          status: "done",
          output: `bus result for ${payload.goal}`,
          artifacts: [{ artifactId: "art_bus", version: 1 }],
        });
      }
    });

    const sharedState = new SharedStateStore({ goal: "g" });
    const supervisor = new SupervisorAgent({
      bus,
      sharedState,
      workers: [{ agentId: "researcher" }],
      policy: { taskTimeoutMs: 1000, retryLimit: 0, maxRounds: 2 },
    });

    const result = await supervisor.orchestrate("research via bus");
    expect(result.status).toBe("completed");
    expect(result.tasks[0].output).toBe("bus result for research via bus");
    expect(sharedState.snapshot().artifacts[0]).toMatchObject({ artifactId: "art_bus", contributedBy: "researcher" });
  });

  it("requires a task port (onTask or bus)", () => {
    const sharedState = new SharedStateStore({ goal: "g" });
    expect(() => new SupervisorAgent({ sharedState, workers })).toThrow("onTask or a bus");
  });
});
