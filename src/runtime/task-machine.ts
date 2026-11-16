/**
 * Task state machine for the runtime task graph.
 *
 * A transition outside TRANSITIONS is rejected and reported, never applied. A failed task blocks every queued
 * dependent, transitively, and records the failed root and the reason. Retrying the root releases exactly the
 * dependents it blocked, and a dependent that still has a failing dependency stays blocked. Every applied
 * change, including the propagated ones, comes back as a transition record, so the caller can publish it.
 *
 * The production scheduler for plan steps is src/orchestration/orchestrator.ts, which cascades a failure to
 * its dependents as "skipped". This graph is the runtime's task view (store.tasks).
 */

import { Task, TaskStatus } from "./types.js";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "blocked", "cancelled"],
  blocked: ["queued", "running", "cancelled"],
  running: ["completed", "failed", "blocked", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TaskTransition {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason?: string;
}

export type TaskTransitionRejection =
  | { kind: "unknown-task"; taskId: string; to: TaskStatus }
  | { kind: "invalid-transition"; taskId: string; from: TaskStatus; to: TaskStatus };

export interface TaskGraphStep {
  tasks: Task[];
  /** Every change applied, the requested one first, then the propagated ones. */
  transitions: TaskTransition[];
  /** Set when the requested transition was refused. The graph is then returned unchanged. */
  rejected?: TaskTransitionRejection;
}

export interface TaskTransitionOptions {
  progress?: number;
  /** Why the task moved (for a failure: the failed checks or error). Carried onto the blocked dependents. */
  reason?: string;
}

const failedDependencyReason = (rootId: string, reason: string) => `dependency "${rootId}" failed: ${reason}`;

function withStatus(task: Task, status: TaskStatus, progress: number | undefined): Task {
  const { blockedBy: _blockedBy, blockReason: _blockReason, ...rest } = task;
  const keepBlock = task.status === status;
  const base = keepBlock ? task : rest;
  return { ...base, status, progress: progress ?? task.progress };
}

/** Blocks every queued task that depends, directly or transitively, on the failed root. */
function blockDependents(
  tasks: Task[],
  rootId: string,
  reason: string,
): { tasks: Task[]; transitions: TaskTransition[] } {
  const blockReason = failedDependencyReason(rootId, reason);
  const transitions: TaskTransition[] = [];
  let next = tasks;
  const frontier = [rootId];
  const seen = new Set(frontier);
  while (frontier.length > 0) {
    const id = frontier.shift()!;
    for (const candidate of next) {
      if (seen.has(candidate.id) || candidate.status !== "queued" || !candidate.dependencies.includes(id)) continue;
      seen.add(candidate.id);
      next = next.map((t) => (t.id === candidate.id ? { ...t, status: "blocked", blockedBy: rootId, blockReason } : t));
      transitions.push({ taskId: candidate.id, from: "queued", to: "blocked", reason: blockReason });
      frontier.push(candidate.id);
    }
  }
  return { tasks: next, transitions };
}

/**
 * Releases the dependents blocked by a retried root, to a fixed point. A candidate stays blocked while any of
 * its dependencies is still failed or still blocked by a failure, and its recorded cause is re-pointed there.
 */
function releaseDependents(tasks: Task[], rootId: string): { tasks: Task[]; transitions: TaskTransition[] } {
  const transitions: TaskTransition[] = [];
  let next = tasks;
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of next) {
      if (candidate.status !== "blocked" || candidate.blockedBy !== rootId) continue;
      const deps = candidate.dependencies.map((id) => next.find((t) => t.id === id));
      const failedDep = deps.find((d) => d?.status === "failed");
      const stillBlockedByFailure = deps.find((d) => d?.status === "blocked" && d.blockedBy !== undefined);
      if (failedDep || stillBlockedByFailure) {
        const newRoot = failedDep ? failedDep.id : stillBlockedByFailure!.blockedBy!;
        if (newRoot !== rootId) {
          next = next.map((t) =>
            t.id === candidate.id
              ? { ...t, blockedBy: newRoot, blockReason: failedDependencyReason(newRoot, "still failing") }
              : t,
          );
          changed = true;
        }
        continue;
      }
      const { blockedBy: _blockedBy, blockReason: _blockReason, ...rest } = candidate;
      next = next.map((t) => (t.id === candidate.id ? { ...rest, status: "queued" } : t));
      transitions.push({
        taskId: candidate.id,
        from: "blocked",
        to: "queued",
        reason: `dependency "${rootId}" retried`,
      });
      changed = true;
    }
  }
  return { tasks: next, transitions };
}

/**
 * Applies one status change and its consequences. Invalid or unknown requests are reported in `rejected`
 * and leave the graph untouched. A progress-only update on an unchanged status is a no-op, not a rejection.
 */
export function transitionTask(
  tasks: Task[],
  taskId: string,
  status: TaskStatus,
  options: TaskTransitionOptions = {},
): TaskGraphStep {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return { tasks, transitions: [], rejected: { kind: "unknown-task", taskId, to: status } };

  const statusChanges = task.status !== status;
  if (statusChanges && !canTransition(task.status, status)) {
    return {
      tasks,
      transitions: [],
      rejected: { kind: "invalid-transition", taskId, from: task.status, to: status },
    };
  }
  if (!statusChanges && options.progress === undefined) return { tasks, transitions: [] };

  const reason = options.reason ?? (status === "failed" ? "failed" : undefined);
  let next = tasks.map((t) => (t.id === taskId ? withStatus(t, status, options.progress) : t));
  const transitions: TaskTransition[] = [];
  if (statusChanges) transitions.push({ taskId, from: task.status, to: status, ...(reason ? { reason } : {}) });

  if (statusChanges && status === "failed") {
    const blocked = blockDependents(next, taskId, reason ?? "failed");
    next = blocked.tasks;
    transitions.push(...blocked.transitions);
  }
  if (statusChanges && task.status === "failed" && status === "queued") {
    const released = releaseDependents(next, taskId);
    next = released.tasks;
    transitions.push(...released.transitions);
  }
  return { tasks: next, transitions };
}

/**
 * Graph-only view of transitionTask: returns the tasks and discards the transition records and rejections.
 * Prefer transitionTask, which reports both.
 */
export function applyTaskTransition(tasks: Task[], taskId: string, status: TaskStatus, progress?: number): Task[] {
  return transitionTask(tasks, taskId, status, { progress }).tasks;
}

/** Tasks whose dependencies are all completed and are ready to run. */
export function readyTasks(tasks: Task[]): Task[] {
  const done = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
  return tasks.filter(
    (t) => (t.status === "queued" || t.status === "blocked") && t.dependencies.every((d) => done.has(d)),
  );
}
