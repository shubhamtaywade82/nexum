import { applyTaskTransition, canTransition, readyTasks, transitionTask } from "../../src/runtime/task-machine.js";
import { Task } from "../../src/runtime/types.js";

function task(id: string, status: Task["status"], deps: string[] = []): Task {
  return { id, title: id, status, dependencies: deps };
}

describe("task state machine", () => {
  it("allows the documented transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("blocked", "running")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
  });

  it("applyTaskTransition updates only on valid transitions", () => {
    const tasks = [task("a", "queued"), task("b", "completed")];
    const next = applyTaskTransition(tasks, "a", "running", 0.5);
    expect(next.find((t) => t.id === "a")).toMatchObject({ status: "running", progress: 0.5 });

    const unchanged = applyTaskTransition(next, "b", "running");
    expect(unchanged).toBe(next);
  });

  it("applyTaskTransition ignores unknown tasks", () => {
    const tasks = [task("a", "queued")];
    expect(applyTaskTransition(tasks, "zzz", "running")).toBe(tasks);
  });

  it("updates progress without a status change", () => {
    const tasks = [task("a", "running")];
    const next = applyTaskTransition(tasks, "a", "running", 0.9);
    expect(next[0].progress).toBe(0.9);
  });

  it("readyTasks returns queued/blocked tasks whose deps completed", () => {
    const tasks = [
      task("a", "completed"),
      task("b", "queued", ["a"]),
      task("c", "queued", ["b"]),
      task("d", "blocked", ["a"]),
    ];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["b", "d"]);
  });
});

describe("dependency failure propagation", () => {
  const byId = (tasks: Task[], id: string) => tasks.find((t) => t.id === id)!;

  it("failing a task blocks its queued dependents transitively, names the failed root, and keeps the reason", () => {
    const tasks = [task("a", "running"), task("b", "queued", ["a"]), task("c", "queued", ["b"]), task("d", "queued")];

    const step = transitionTask(tasks, "a", "failed", { reason: "tests failed" });

    expect(byId(step.tasks, "a").status).toBe("failed");
    expect(byId(step.tasks, "b")).toMatchObject({
      status: "blocked",
      blockedBy: "a",
      blockReason: 'dependency "a" failed: tests failed',
    });
    expect(byId(step.tasks, "c")).toMatchObject({ status: "blocked", blockedBy: "a" });
    expect(byId(step.tasks, "d").status).toBe("queued");
    expect(step.transitions).toEqual(
      expect.arrayContaining([
        { taskId: "a", from: "running", to: "failed", reason: "tests failed" },
        { taskId: "b", from: "queued", to: "blocked", reason: 'dependency "a" failed: tests failed' },
        { taskId: "c", from: "queued", to: "blocked", reason: 'dependency "a" failed: tests failed' },
      ]),
    );
    expect(step.rejected).toBeUndefined();
  });

  it("a dependent is never ready while its dependency has failed", () => {
    const step = transitionTask([task("a", "running"), task("b", "queued", ["a"])], "a", "failed");
    expect(readyTasks(step.tasks)).toEqual([]);
  });

  it("retrying the failed task releases the dependents it blocked, and only those", () => {
    const blockedByA = { ...task("b", "blocked", ["a"]), blockedBy: "a", blockReason: 'dependency "a" failed: x' };
    const blockedElsewhere = { ...task("e", "blocked", ["a"]) };
    const step = transitionTask([task("a", "failed"), blockedByA, blockedElsewhere], "a", "queued");

    expect(byId(step.tasks, "a").status).toBe("queued");
    expect(byId(step.tasks, "b")).toMatchObject({ status: "queued" });
    expect(byId(step.tasks, "b").blockedBy).toBeUndefined();
    expect(byId(step.tasks, "e").status).toBe("blocked");
    expect(step.transitions).toContainEqual({
      taskId: "b",
      from: "blocked",
      to: "queued",
      reason: 'dependency "a" retried',
    });
  });

  it("an invalid transition is reported as a rejection and leaves the graph unchanged", () => {
    const tasks = [task("b", "completed")];
    const step = transitionTask(tasks, "b", "running");

    expect(step.rejected).toEqual({ kind: "invalid-transition", taskId: "b", from: "completed", to: "running" });
    expect(step.tasks).toBe(tasks);
    expect(step.transitions).toEqual([]);
  });

  it("an unknown task is reported as a rejection, not silently ignored", () => {
    const step = transitionTask([task("a", "queued")], "zzz", "running");
    expect(step.rejected).toEqual({ kind: "unknown-task", taskId: "zzz", to: "running" });
  });

  it("a progress-only update is a no-op, not a rejection", () => {
    const step = transitionTask([task("a", "running")], "a", "running", { progress: 0.4 });
    expect(step.rejected).toBeUndefined();
    expect(step.tasks[0].progress).toBe(0.4);
  });
});

describe("release with several failing roots", () => {
  it("a dependent of two failed roots stays blocked until both are retried, and so does its downstream task", () => {
    const start = [
      task("a", "running"),
      task("c", "running"),
      task("b", "queued", ["a", "c"]),
      task("d", "queued", ["b"]),
    ];
    const failedA = transitionTask(start, "a", "failed", { reason: "x" });
    const failedC = transitionTask(failedA.tasks, "c", "failed", { reason: "y" });

    // Retrying a alone must not release b or d: c still fails.
    const retriedA = transitionTask(failedC.tasks, "a", "queued");
    expect(retriedA.tasks.find((t) => t.id === "b")).toMatchObject({ status: "blocked", blockedBy: "c" });
    expect(retriedA.tasks.find((t) => t.id === "d")).toMatchObject({ status: "blocked", blockedBy: "c" });
    expect(retriedA.transitions.filter((t) => t.to === "queued" && t.from === "blocked")).toEqual([]);

    // Once c is retried too, both are released.
    const retriedC = transitionTask(retriedA.tasks, "c", "queued");
    expect(retriedC.tasks.find((t) => t.id === "b")?.status).toBe("queued");
    expect(retriedC.tasks.find((t) => t.id === "d")?.status).toBe("queued");
  });
});

describe("a dependency-blocked task cannot become runnable while its dependency still fails", () => {
  it("refuses to make a blocked dependent runnable while its failed dependency is still failed", () => {
    const failed = transitionTask([task("a", "running"), task("b", "queued", ["a"])], "a", "failed").tasks;
    const forced = transitionTask(failed, "b", "queued");

    expect(forced.rejected).toEqual({ kind: "dependency-failed", taskId: "b", blockedBy: "a", to: "queued" });
    expect(forced.tasks).toBe(failed);
  });

  it("still allows cancelling a dependency-blocked task", () => {
    const failed = transitionTask([task("a", "running"), task("b", "queued", ["a"])], "a", "failed").tasks;
    const cancelled = transitionTask(failed, "b", "cancelled");
    expect(cancelled.rejected).toBeUndefined();
    expect(cancelled.tasks.find((t) => t.id === "b")?.status).toBe("cancelled");
  });
});
