import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskScheduler,
  sweepOnce,
  cadenceMs,
  SweepOutcome,
  SchedulerRunSummary,
} from "../../../src/evolution/tasks/task-scheduler.js";
import { buildEngineWiring } from "../../../src/evolution/tasks/engine-wiring.js";
import { Episode } from "../../../src/learning/types.js";

/**
 * The cadence scheduler: schedules.yml declared per-category cadences and an
 * initial batch, but nothing ever consumed them. These tests pin the sweep
 * contract: initial-batch bootstrap, priority order afterwards, cadence and
 * evidence-delta ceilings that DEFER (never force) a run, anti-rule results
 * that are not failures, and the budgeted-failure loop.
 */

function failureEpisode(id: string, goal: string, startedAt = 1000): Episode {
  return {
    id,
    goal,
    startedAt,
    endedAt: startedAt + 1000,
    terminal: "loop_abort",
    toolEvents: [
      {
        name: "run_shell",
        args: {},
        ok: false,
        durationMs: 100,
        at: startedAt + 1,
        errorLabel: "Argument validation failed",
      },
      {
        name: "run_shell",
        args: {},
        ok: false,
        durationMs: 100,
        at: startedAt + 2,
        errorLabel: "Argument validation failed",
      },
    ],
    activatedSkillIds: [],
    finalAssistantText: "",
    grade: {
      verdict: "failure",
      score: 0.2,
      signals: {
        testsRan: true,
        testsPassed: false,
        toolErrorRate: 0.7,
        pathEscapes: 0,
        patchFailures: 0,
        loopAborted: true,
        turnCount: 5,
        retriedSameToolMax: 2,
      },
    },
  };
}

describe("cadenceMs", () => {
  it("maps cadence names to intervals, per-release to null, unknown to daily", () => {
    expect(cadenceMs("hourly")).toBe(60 * 60 * 1000);
    expect(cadenceMs("daily")).toBe(24 * 60 * 60 * 1000);
    expect(cadenceMs("weekly")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cadenceMs("per-release")).toBeNull();
    expect(cadenceMs("something-else")).toBe(cadenceMs("daily"));
  });
});

describe("sweepOnce", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "nexum-sweep-"));
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function wire(episodes: Episode[], now?: () => number, currentCommit = "a".repeat(40)) {
    const wiring = buildEngineWiring({
      workspaceRoot: workspace,
      currentCommit,
      episodes,
    });
    return {
      wiring,
      sweep: () =>
        sweepOnce({
          runner: wiring.runner,
          registry: wiring.registry,
          backlog: wiring.backlog,
          schedules: wiring.schedules,
          getCurrentCommit: wiring.deps.getCurrentCommit,
          getNewEvidenceCount: wiring.deps.getNewEvidenceCount,
          ...(now ? { now } : {}),
        }),
    };
  }

  it("bootstraps from the initial batch while the backlog is empty", async () => {
    const { wiring, sweep } = wire([failureEpisode("ep-1", "Fix tool selection")]);
    try {
      const outcome = await sweep();
      // schedules.yml initial_batch[0] is EVO-001 (diagnose mode).
      expect(outcome.ran).toBe(true);
      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("EVO-001");
      expect(wiring.backlog.get("EVO-001")?.state).toBe("investigated");
    } finally {
      wiring.close();
    }
  });

  it("runs the next task by priority after the backlog is no longer empty", async () => {
    // Enough episodes for the learning category's min-evidence delta (5).
    const episodes = [1, 2, 3, 4, 5, 6].map((i) => failureEpisode(`ep-${i}`, `goal ${i}`));
    const { wiring, sweep } = wire(episodes);
    try {
      const first = await sweep(); // initial batch → EVO-001
      expect(first.ran).toBe(true);
      const second = await sweep(); // EVO-001 now deferred (evidence delta) → next rank runs
      expect(second.ran).toBe(true);
      expect(second.detail).not.toContain("EVO-001 deferred"); // deferral must not wedge the sweep
    } finally {
      wiring.close();
    }
  });

  it("defers a re-evaluation below the category's evidence delta", async () => {
    const episodes = [failureEpisode("ep-1", "Fix tool selection")];
    const { wiring } = wire(episodes);
    try {
      // EVO-004 (learning, min delta 5) was already investigated.
      wiring.backlog.ensurePending("EVO-004");
      wiring.backlog.transition("EVO-004", "investigated", { lastEvaluatedCommit: "a".repeat(40) });
      const outcome = await sweepOnce({
        runner: {
          pickRanked: async () => [
            {
              task: wiring.registry.get("EVO-004")!,
              rank: 1,
              route: "execute",
              contributions: { impact: 0, frequency: 0, evidence_confidence: 0, potential: 0 },
            },
          ],
          runOne: async () => {
            throw new Error("the deferral must fire before runOne");
          },
        } as unknown as import("../../../src/evolution/tasks/task-runner.js").TaskRunner,
        registry: wiring.registry,
        backlog: wiring.backlog,
        schedules: wiring.schedules,
        getCurrentCommit: async () => "a".repeat(40),
        getNewEvidenceCount: () => 1, // learning requires >= 5
      });
      expect(outcome.ran).toBe(false);
      expect(outcome.deferred).toBe(true);
      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("EVO-004 deferred");
      expect(outcome.detail).toContain("< 5");
    } finally {
      wiring.close();
    }
  });

  it("reports an anti-rule block from runOne as a RESULT (ran, ok), not a failure", async () => {
    // Direct contract test: when the ceilings allow a task but runOne's
    // anti-rules block it, the sweep reports ran+ok (a result), never a
    // failure — same distinction as a clean hypothesis rejection.
    const { wiring } = wire([failureEpisode("ep-1", "Fix tool selection")]);
    try {
      const blocked = await sweepOnce({
        runner: {
          pickRanked: async () => [
            {
              task: wiring.registry.get("EVO-004")!,
              rank: 1,
              route: "execute",
              contributions: { impact: 0, frequency: 0, evidence_confidence: 0, potential: 0 },
            },
          ],
          runOne: async () => ({
            task: wiring.registry.get("EVO-004")!,
            mode: "diagnose" as const,
            validated: false,
            validationCode: "no_new_evidence" as const,
            summary: "Blocked by anti-rule (no_new_evidence): same commit, no new evidence.",
          }),
        } as unknown as import("../../../src/evolution/tasks/task-runner.js").TaskRunner,
        registry: wiring.registry,
        backlog: wiring.backlog,
        schedules: wiring.schedules,
        getCurrentCommit: async () => "a".repeat(40),
        getNewEvidenceCount: () => 99,
      });
      expect(blocked.ran).toBe(true);
      expect(blocked.ok).toBe(true);
      expect(blocked.detail).toContain("no_new_evidence");
    } finally {
      wiring.close();
    }
  });

  it("per-release categories defer while HEAD has not advanced", async () => {
    const episodes = [failureEpisode("ep-1", "docs task")];
    const commit = "a".repeat(40);
    // First run: pick an evolution_safety task directly (per-release cadence).
    const { wiring } = wire(episodes, undefined, commit);
    try {
      // Run EVO-012 (evolution_safety, per-release) manually through the runner.
      await wiring.runner.runOne({ taskId: "EVO-012" });
      const entry = wiring.backlog.get("EVO-012");
      expect(entry?.state).toBe("investigated");
      // Same commit → sweep defers any per-release re-evaluation.
      const outcome = await sweepOnce({
        runner: wiring.runner,
        registry: wiring.registry,
        backlog: wiring.backlog,
        schedules: wiring.schedules,
        getCurrentCommit: async () => commit,
        getNewEvidenceCount: () => 999, // evidence is irrelevant for per-release
      });
      // The sweep picked SOME task; if it picked EVO-012 it must defer.
      if (outcome.detail.includes("EVO-012")) {
        expect(outcome.deferred).toBe(true);
        expect(outcome.detail).toContain("per-release");
      } else {
        expect(outcome.ok).toBe(true);
      }
    } finally {
      wiring.close();
    }
  });

  it("with zero episodes the sweep still runs the task, which declines to commit", async () => {
    const { wiring, sweep } = wire([]);
    try {
      const outcome = await sweep();
      expect(outcome.ran).toBe(true); // runOne executed; the HOOK declined
      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("declined to commit");
    } finally {
      wiring.close();
    }
  });

  it("returns a clean idle outcome when no task is eligible at all", async () => {
    const { wiring } = wire([failureEpisode("ep-1", "Fix tool selection")]);
    try {
      // A tracked entry makes the sweep skip the initial-batch bootstrap
      // and go straight to the (empty) ranked list.
      wiring.backlog.ensurePending("EVO-001");
      const outcome = await sweepOnce({
        runner: {
          pickRanked: async () => [],
          runOne: async () => {
            throw new Error("should not be called");
          },
        } as unknown as import("../../../src/evolution/tasks/task-runner.js").TaskRunner,
        registry: wiring.registry,
        backlog: wiring.backlog,
        schedules: wiring.schedules,
        getCurrentCommit: async () => "a".repeat(40),
        getNewEvidenceCount: () => 0,
      });
      expect(outcome.ran).toBe(false);
      expect(outcome.deferred).toBe(false);
      expect(outcome.ok).toBe(true);
      expect(outcome.detail).toContain("no eligible task");
    } finally {
      wiring.close();
    }
  });
});

describe("TaskScheduler loop", () => {
  function makeScheduler(
    outcomes: SweepOutcome[],
    opts: { intervalMs?: number; maxTasks?: number; maxIdleTicks?: number; maxConsecutiveFailures?: number } = {},
  ) {
    const log: string[] = [];
    let i = 0;
    const sleeps: number[] = [];
    const scheduler = new TaskScheduler({
      sweep: async () => outcomes[Math.min(i++, outcomes.length - 1)],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logger: { log: (m) => log.push(m), error: (m) => log.push(m) },
      ...opts,
    });
    return { scheduler, log, sleeps };
  }

  it("stops at max-tasks and reports what ran", async () => {
    const { scheduler, log } = makeScheduler([{ ran: true, deferred: false, ok: true, detail: "EVO-001 diagnosed" }], {
      maxTasks: 2,
      intervalMs: 5,
    });
    const summary = await scheduler.run();
    expect(summary.tasksRun).toBe(2);
    expect(summary.stoppedReason).toBe("max-tasks");
    expect(log.some((l) => l.includes("EVO-001"))).toBe(true);
  });

  it("counts deferrals toward the idle budget (an all-deferred loop must be bounded)", async () => {
    const { scheduler } = makeScheduler([{ ran: false, deferred: true, ok: true, detail: "deferred by cadence" }], {
      maxIdleTicks: 2,
      intervalMs: 0,
    });
    const summary = await scheduler.run();
    expect(summary.tasksDeferred).toBe(2);
    expect(summary.idleTicks).toBe(2);
    expect(summary.stoppedReason).toBe("max-idle-ticks");
  });

  it("stops after consecutive FAILED sweeps (thrown errors), not blocked results", async () => {
    const { scheduler } = makeScheduler([{ ran: false, deferred: false, ok: false, detail: "boom" }], {
      maxConsecutiveFailures: 2,
      intervalMs: 0,
    });
    const summary = await scheduler.run();
    expect(summary.failedSweeps).toBe(2);
    expect(summary.stoppedReason).toBe("consecutive-failures");
  });

  it("a successful run resets the failure budget", async () => {
    const outcomes: SweepOutcome[] = [
      { ran: false, deferred: false, ok: false, detail: "boom" },
      { ran: true, deferred: false, ok: true, detail: "EVO-001 diagnosed" },
      { ran: false, deferred: false, ok: false, detail: "boom" },
      { ran: false, deferred: false, ok: false, detail: "boom" },
    ];
    const { scheduler } = makeScheduler(outcomes, { maxConsecutiveFailures: 2, maxTasks: 2, intervalMs: 0 });
    const summary = await scheduler.run();
    // fail(1) → success resets → fail(1) → fail(2) stops.
    expect(summary.failedSweeps).toBe(3);
    expect(summary.tasksRun).toBe(1);
    expect(summary.stoppedReason).toBe("consecutive-failures");
  });

  it("idle ticks exhaust the evidence budget and stop the loop", async () => {
    const { scheduler } = makeScheduler([{ ran: false, deferred: false, ok: true, detail: "no eligible task" }], {
      maxIdleTicks: 3,
      intervalMs: 0,
    });
    const summary = await scheduler.run();
    expect(summary.idleTicks).toBe(3);
    expect(summary.stoppedReason).toBe("max-idle-ticks");
  });

  it("stop() exits the loop cleanly after the current step", async () => {
    const { scheduler } = makeScheduler([{ ran: true, deferred: false, ok: true, detail: "EVO-001 diagnosed" }], {
      intervalMs: 0,
    });
    const p: Promise<SchedulerRunSummary> = scheduler.run();
    scheduler.stop();
    const summary = await p;
    expect(summary.stoppedReason).toBe("stopped");
  });
});
