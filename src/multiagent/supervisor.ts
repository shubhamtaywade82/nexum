/**
 * SupervisorAgent — the generic supervisor pattern.
 *
 * The Delegator spawns children; a supervisor ORCHESTRATES: it owns the
 * coordination state, decomposes the goal, decides who works on what,
 * watches progress, retries failures, merges results, and decides when to
 * continue vs terminate — the dynamic loop, not a static spawn.
 *
 *   decompose(goal) ─┐
 *                    ├─→ round: assign idle workers → await results (timeout)
 *   shared state  ───┤            │
 *                    │            ├─ done → merge finding/artifact into state
 *                    │            ├─ failed → retry up to policy.retryLimit
 *                    │            └─ no progress → stall detection
 *                    └─→ terminal: all done (completed) | stalled | maxRounds
 *
 * Everything risky is injected: the PlannerPort decomposes goals, the
 * TaskPort executes assignments (default: bus request/response over
 * coord.task.assign/coord.task.result — swap for SubagentService or a
 * distributed transport without touching the loop).
 */

import { randomUUID } from "node:crypto";
import type { AgentAddress, AgentMessageBus } from "./bus/message-bus.js";
import type { SharedAgentState, SharedStateStore } from "./shared-state.js";

export interface WorkerAgent {
  agentId: AgentAddress;
  capabilities?: string[];
}

export type SupervisorTaskStatus = "pending" | "assigned" | "done" | "failed" | "permanently-failed";

export interface SupervisorTask {
  id: string;
  goal: string;
  input?: string;
  status: SupervisorTaskStatus;
  assignedTo?: AgentAddress;
  attempts: number;
  output?: string;
  error?: string;
}

export interface TaskPortResult {
  status: "done" | "failed" | "blocked";
  output: string;
  artifacts?: Array<{ artifactId: string; name?: string; version?: number }>;
  error?: string;
}

/** Executes one task assignment (default: bus request/response). */
export type TaskPort = (task: SupervisorTask, worker: WorkerAgent) => Promise<TaskPortResult>;

/** Decomposes a goal into tasks given the current shared state. */
export type PlannerPort = (goal: string, state: Readonly<SharedAgentState>) => SupervisorTask[];

export interface SupervisorPolicy {
  /** Max orchestration rounds (default 5). */
  maxRounds?: number;
  /** Per-assignment timeout in ms (default 30s). */
  taskTimeoutMs?: number;
  /** Retries per task before permanent failure (default 1). */
  retryLimit?: number;
  /** Concurrent assignments per round (default 4). */
  maxParallel?: number;
  /** Terminate as stalled when a round completes no task (default true). */
  stopOnNoProgress?: boolean;
}

export interface SupervisionResult {
  goal: string;
  status: "completed" | "stalled" | "max-rounds";
  rounds: number;
  tasks: SupervisorTask[];
  state: Readonly<SharedAgentState>;
  summary: string;
}

export class TaskPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPortError";
  }
}

/** Default planner: the goal as a single task. */
export function singleTaskPlanner(): PlannerPort {
  return (goal) => [newSupervisorTask(goal)];
}

export function newSupervisorTask(goal: string, input?: string): SupervisorTask {
  return {
    id: `supTask_${randomUUID()}`,
    goal,
    ...(input !== undefined ? { input } : {}),
    status: "pending",
    attempts: 0,
  };
}

/** Default TaskPort: assign over the bus, await the correlated result. */
export function busTaskPort(bus: AgentMessageBus, timeoutMs = 30_000): TaskPort {
  return async (task, worker) => {
    const reply = await bus.request(
      "supervisor",
      worker.agentId,
      "coord.task.assign",
      { taskId: task.id, goal: task.goal, ...(task.input !== undefined ? { input: task.input } : {}) },
      { timeoutMs, conversationId: `task:${task.id}` },
    );
    const payload = reply.payload as {
      status?: TaskPortResult["status"];
      output?: string;
      artifacts?: TaskPortResult["artifacts"];
      error?: string;
    };
    return {
      status: payload.status ?? "failed",
      output: payload.output ?? "",
      ...(payload.artifacts !== undefined ? { artifacts: payload.artifacts } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
    };
  };
}

export interface SupervisorOptions {
  bus?: AgentMessageBus;
  sharedState: SharedStateStore;
  workers: WorkerAgent[];
  policy?: SupervisorPolicy;
  planner?: PlannerPort;
  /** Task execution port (default: busTaskPort when a bus is given). */
  onTask?: TaskPort;
  supervisorId?: AgentAddress;
}

export class SupervisorAgent {
  readonly supervisorId: AgentAddress;
  private readonly sharedState: SharedStateStore;
  private readonly workers: WorkerAgent[];
  private readonly policy: Required<SupervisorPolicy>;
  private readonly planner: PlannerPort;
  private readonly port: TaskPort;

  constructor(opts: SupervisorOptions) {
    this.supervisorId = opts.supervisorId ?? "supervisor";
    this.sharedState = opts.sharedState;
    this.workers = opts.workers;
    this.policy = {
      maxRounds: opts.policy?.maxRounds ?? 5,
      taskTimeoutMs: opts.policy?.taskTimeoutMs ?? 30_000,
      retryLimit: opts.policy?.retryLimit ?? 1,
      maxParallel: opts.policy?.maxParallel ?? 4,
      stopOnNoProgress: opts.policy?.stopOnNoProgress ?? true,
    };
    this.planner = opts.planner ?? singleTaskPlanner();
    this.port = opts.onTask ?? (opts.bus ? busTaskPort(opts.bus, this.policy.taskTimeoutMs) : (undefined as never));
    if (!opts.onTask && !opts.bus) {
      throw new Error("SupervisorAgent needs either onTask or a bus (for the default task port)");
    }
    for (const worker of this.workers) {
      this.sharedState.setAgentStatus({ agentId: worker.agentId, state: "idle" });
    }
  }

  /**
   * Orchestrate the goal to a terminal state. Deterministic control flow:
   * every decision (assignment, retry, merge, termination) is recorded in
   * the shared state's changelog and decisions.
   */
  async orchestrate(goal: string): Promise<SupervisionResult> {
    this.sharedState.update({ owner: this.supervisorId, summary: `orchestration start: ${goal}` }, (draft) => {
      draft.goal = goal;
    });
    const tasks = this.planner(goal, this.sharedState.snapshot());
    let workerCursor = 0;

    for (let round = 1; round <= this.policy.maxRounds; round++) {
      const runnable = tasks.filter((t) => t.status === "pending" || t.status === "failed");
      if (runnable.length === 0) break;

      const batch = runnable.slice(0, this.policy.maxParallel);
      let advanced = 0;

      const executions = batch.map(async (task) => {
        const worker = this.workers[workerCursor++ % this.workers.length];
        task.status = "assigned";
        task.assignedTo = worker.agentId;
        task.attempts += 1;
        this.sharedState.setAgentStatus({
          agentId: worker.agentId,
          state: "working",
          currentTaskId: task.id,
        });

        let result: TaskPortResult;
        try {
          result = await this.port(task, worker);
        } catch (err) {
          result = {
            status: "failed",
            output: "",
            error: err instanceof Error ? err.message : String(err),
          };
        }

        if (result.status === "done") {
          task.status = "done";
          task.output = result.output;
          advanced++;
          this.sharedState.addFinding({
            summary: `${task.goal} → done`,
            detail: result.output.slice(0, 2000),
            owner: worker.agentId,
            ...(result.artifacts !== undefined ? { evidence: result.artifacts } : {}),
          });
          for (const artifact of result.artifacts ?? []) {
            this.sharedState.publishArtifact({ ...artifact, owner: worker.agentId });
          }
        } else if (task.attempts > this.policy.retryLimit) {
          task.status = "permanently-failed";
          task.error = result.error ?? result.status;
          this.sharedState.recordDecision({
            rationale: `task "${task.goal}" failed permanently after ${task.attempts} attempts (${task.error})`,
            decidedBy: this.supervisorId,
          });
        } else {
          task.status = "failed"; // retried next round
          task.error = result.error ?? result.status;
        }
        this.sharedState.setAgentStatus({ agentId: worker.agentId, state: result.status === "done" ? "done" : "idle" });
      });

      await Promise.all(executions);

      if (advanced === 0 && this.policy.stopOnNoProgress) {
        this.sharedState.recordDecision({
          rationale: `stalled: round ${round} completed no task`,
          decidedBy: this.supervisorId,
        });
        return this.finish(goal, "stalled", round, tasks, `no progress in round ${round}`);
      }
    }

    const outstanding = tasks.filter((t) => t.status !== "done" && t.status !== "permanently-failed");
    if (outstanding.length > 0) {
      return this.finish(
        goal,
        "max-rounds",
        this.policy.maxRounds,
        tasks,
        `${outstanding.length} task(s) unfinished after max rounds`,
      );
    }
    const done = tasks.filter((t) => t.status === "done").length;
    return this.finish(goal, "completed", this.policy.maxRounds, tasks, `${done}/${tasks.length} tasks completed`);
  }

  private finish(
    goal: string,
    status: SupervisionResult["status"],
    rounds: number,
    tasks: SupervisorTask[],
    summary: string,
  ): SupervisionResult {
    return {
      goal,
      status,
      rounds,
      tasks: tasks.map((t) => ({ ...t })),
      state: this.sharedState.snapshot(),
      summary,
    };
  }
}
