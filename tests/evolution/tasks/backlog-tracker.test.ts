import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogTracker } from "../../../src/evolution/tasks/backlog-tracker.js";

describe("BacklogTracker", () => {
  let tmp: string;
  let tracker: BacklogTracker;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nexum-backlog-"));
    tracker = new BacklogTracker(join(tmp, "backlog.db"));
  });
  afterEach(() => {
    tracker.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("ensurePending creates a pending entry, idempotent", () => {
    tracker.ensurePending("EVO-001");
    tracker.ensurePending("EVO-001"); // second call is a no-op
    const e = tracker.get("EVO-001");
    expect(e?.state).toBe("pending");
    expect(e?.lastEvaluatedCommit).toBeNull();
  });

  test("pending → investigated records the report", () => {
    tracker.ensurePending("EVO-001");
    const e = tracker.transition("EVO-001", "investigated", {
      lastEvaluatedCommit: "abc123",
      lastReportId: "rpt-1",
    });
    expect(e.state).toBe("investigated");
    expect(e.lastEvaluatedCommit).toBe("abc123");
    expect(e.lastReportId).toBe("rpt-1");
  });

  test("pending → in_progress is allowed (for experiment/implement)", () => {
    tracker.ensurePending("EVO-001");
    tracker.transition("EVO-001", "in_progress", { relatedExperimentId: "exp-1" });
    expect(tracker.get("EVO-001")?.state).toBe("in_progress");
    expect(tracker.get("EVO-001")?.relatedExperimentId).toBe("exp-1");
  });

  test("in_progress → completed is allowed", () => {
    tracker.ensurePending("EVO-001");
    tracker.transition("EVO-001", "in_progress");
    tracker.transition("EVO-001", "completed");
    expect(tracker.get("EVO-001")?.state).toBe("completed");
  });

  test("investigated → rejected_deferred records next_evaluation_condition", () => {
    tracker.ensurePending("EVO-001");
    tracker.transition("EVO-001", "investigated");
    tracker.transition("EVO-001", "rejected_deferred", {
      nextEvaluationCondition: "new_failure_class observed for tool_selection",
    });
    expect(tracker.get("EVO-001")?.state).toBe("rejected_deferred");
    expect(tracker.get("EVO-001")?.nextEvaluationCondition).toContain("tool_selection");
  });

  test("rejected_deferred → pending re-opens the task", () => {
    tracker.ensurePending("EVO-001");
    tracker.transition("EVO-001", "investigated");
    tracker.transition("EVO-001", "rejected_deferred");
    tracker.transition("EVO-001", "pending");
    expect(tracker.get("EVO-001")?.state).toBe("pending");
  });

  test("completed is terminal", () => {
    tracker.ensurePending("EVO-001");
    tracker.transition("EVO-001", "in_progress");
    tracker.transition("EVO-001", "completed");
    expect(() => tracker.transition("EVO-001", "in_progress")).toThrow(/Invalid backlog transition/);
  });

  test("invalid transition throws", () => {
    tracker.ensurePending("EVO-001");
    expect(() => tracker.transition("EVO-001", "completed")).toThrow(/Invalid backlog transition/);
  });

  test("byState filters correctly", () => {
    tracker.ensurePending("EVO-001");
    tracker.ensurePending("EVO-002");
    tracker.ensurePending("EVO-003");
    tracker.transition("EVO-001", "investigated");
    tracker.transition("EVO-002", "in_progress");
    expect(tracker.byState("pending").map((e) => e.taskId)).toEqual(["EVO-003"]);
    expect(tracker.byState("investigated").map((e) => e.taskId)).toEqual(["EVO-001"]);
    expect(tracker.byState("in_progress").map((e) => e.taskId)).toEqual(["EVO-002"]);
  });
});
