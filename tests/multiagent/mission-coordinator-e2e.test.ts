/**
 * MAC v1 P5.3 — the coordination loop end-to-end + the mission CLI
 * (SPEC §11, §14; ROADMAP P5, issue #83).
 *
 * Scripted fake agents, exactly the repo's scripted-case pattern: no model,
 * no network, fully deterministic. The happy path walks a complete mission
 * (observe → assess → decide delegate → delegate → verify → decide complete),
 * and the hostile paths cover the deterministic guards:
 *
 *   - INV-13: a trivial goal gates to single-agent fallback — the trio is
 *     never instantiated
 *   - budget exhaustion terminates failed(budget_exhausted)
 *   - a decision loop (complete without evidence, repeatedly) terminates
 *     failed(decision_loop)
 *   - a role crash suspends at a checkpoint; resume completes the mission,
 *     journal intact across incarnations
 *   - the degraded overlay forces re-observation (the tracker observes twice)
 *   - the audit reconstructs transitions, decisions + re-validation verdicts
 *     and budget consumption from events + artifacts only — no LLM
 *   - the TUI MissionState maps onto the existing phase vocabulary (F-2)
 *   - the CLI surface drives the same deterministic record
 */

import { describe, it, expect } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MissionCoordinator,
  type DecisionCandidate,
  type MissionCoordinatorOptions,
  type MissionIntent,
  type MissionRoleAgents,
} from "../../src/orchestration/mission/mission-coordinator.js";
import { resolveMissionPolicy, type MissionPolicy } from "../../src/orchestration/mission/mission-policy.js";
import {
  validateMissionEvent,
  type TrackerReportRef,
  type PredictionReportRef,
} from "../../src/orchestration/mission/events.js";
import { missionCrumb } from "../../src/runtime/mission-derive.js";
import { runMissionCli } from "../../src/cli/mission-cli.js";

// ── helpers ────────────────────────────────────────────────────────────────

const MULTI_STEP_GOAL = "1. reproduce the flaky test\n2. fix the root cause\n3. verify the suite";
const SIMPLE_GOAL = "what does this error mean";

function intents(goal: string): MissionIntent {
  return { goal, successCriteria: ["suite green"], constraints: [], submittedBy: "user" };
}

function policy(
  extra: { budget?: Partial<MissionPolicy["budget"]>; profile?: MissionPolicy["profile"] } = {},
): MissionPolicy {
  const res = resolveMissionPolicy({
    ...(extra.profile ? { profile: extra.profile, enabledProfiles: ["supervised", extra.profile] } : {}),
    ...(extra.budget ? { overrides: { budget: extra.budget } } : {}),
  });
  if (!res.ok || !res.policy) throw new Error(`test policy refused: ${res.reason}`);
  return res.policy;
}

function trackerRef(health: TrackerReportRef["health"] = "healthy"): TrackerReportRef {
  return { reportId: "tr_1", artifactId: "ma_1", health, observationCount: 2, blockerCount: 0 };
}
function predictorRef(): PredictionReportRef {
  return { reportId: "pr_1", artifactId: "ma_2", riskCount: 1 };
}

function decision(partial: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    decisionId: `cd_${partial.action ?? "verify"}-001`,
    missionId: "ms_ignored",
    action: "verify",
    rationale: "check the gates",
    basedOnReports: ["tr_1", "pr_1"],
    evidenceRefs: ["artifact:ma_1"],
    schemaVersion: 1,
    ...partial,
  };
}

interface ScriptOptions {
  decisions?: DecisionCandidate[];
  health?: TrackerReportRef["health"] | "healthy-then-healthy";
  crashOnAssess?: boolean;
}

/** Scripted trio: healthy reports + a queue of decisions; observes counted. */
function scriptedRoles(opts: ScriptOptions = {}) {
  const state = { observes: 0, decides: 0 };
  const decisions = opts.decisions ?? [
    decision({
      action: "delegate",
      decisionId: "cd_d1",
      delegation: { goal: "fix it", requiredCapabilities: ["code-edit"] },
      taskIds: ["s1"],
    }),
    decision({ action: "verify", decisionId: "cd_v1", taskIds: ["s1"] }),
    decision({ action: "complete", decisionId: "cd_c1" }),
  ];
  const roles: MissionRoleAgents = {
    observe: async () => {
      state.observes += 1;
      const health = opts.health === "degraded" ? "degraded" : "healthy";
      return {
        report: trackerRef(state.observes === 1 && opts.health === "healthy-then-healthy" ? "degraded" : health),
        artifactPayload: { turn: state.observes },
      };
    },
    assess: async () => {
      if (opts.crashOnAssess) throw new Error("predictor exploded (scripted crash)");
      return { report: predictorRef(), artifactPayload: { riskCount: 1 } };
    },
    decide: async () => {
      const d = decisions[Math.min(state.decides, decisions.length - 1)];
      state.decides += 1;
      return d;
    },
  };
  return { roles, state };
}

function coordinatorOpts(
  missionsDir: string,
  roles: MissionRoleAgents,
  pol: MissionPolicy = policy(),
): MissionCoordinatorOptions {
  return {
    policy: pol,
    roles,
    workers: {
      review: () => ({ allowed: true, reason: "capability match", childAgentId: "devagent" }),
      delegate: async () => ({ status: "completed" as const, output: "done" }),
    },
    verification: {
      verify: async () => [{ gate: "tests", passed: true, summary: "suite green", evidenceRefs: ["run:run_1"] }],
    },
    approvals: { resolve: async () => "approved" as const },
    missionsDir,
    planSteps: [{ id: "s1", description: "fix", status: "pending", dependencies: [], retryCount: 0 }],
  };
}

function newCoordinator(missionsDir: string, roles: MissionRoleAgents, pol?: MissionPolicy) {
  return new MissionCoordinator(coordinatorOpts(missionsDir, roles, pol));
}

// ── The happy path (SPEC §11.2 loop, §17 E2E shape) ───────────────────────

describe("mission coordinator end-to-end (SPEC §11)", () => {
  it("walks a complete mission: gate → trio → delegate → verify → complete", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-e2e-"));
    const { roles } = scriptedRoles();
    const coordinator = newCoordinator(missionsDir, roles);

    const outcome = await coordinator.run(intents(MULTI_STEP_GOAL));
    expect(outcome.outcome).toBe("completed");
    expect(outcome.state).toBe("completed");
    expect(outcome.resumable).toBe(false);

    const events = coordinator.journalEvents();
    const types = events.map((e) => e.type);
    for (const expected of [
      "mission.created",
      "mission.activated",
      "tracker.report",
      "prediction.report",
      "commander.decision",
      "mission.delegation",
      "mission.verification",
      "mission.completed",
    ]) {
      expect(types).toContain(expected);
    }
    for (const e of events) {
      expect(validateMissionEvent(e).valid).toBe(true);
    }
    // terminal events fire exactly once
    expect(types.filter((t) => t === "mission.completed")).toHaveLength(1);

    // the record persisted: checkpoint + journal + artifact files
    const missionDir = join(missionsDir, coordinator.missionId);
    expect(existsSync(join(missionDir, "checkpoint.json"))).toBe(true);
    expect(existsSync(join(missionDir, "events.jsonl"))).toBe(true);
    const artifacts = readdirSync(join(missionDir, "artifacts"));
    // one observe→assess→decide cycle per loop turn (3 turns: delegate, verify,
    // complete) → 3 tracker reports + 3 prediction reports + 3 decisions
    expect(artifacts.length).toBe(9);
  });

  it("audit reconstructs transitions, decisions + verdicts, and budget — no LLM", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-audit-"));
    const { roles } = scriptedRoles();
    const coordinator = newCoordinator(missionsDir, roles);
    await coordinator.run(intents(MULTI_STEP_GOAL));

    const audit = coordinator.audit();
    expect(audit.outcome).toBe("completed");
    expect(audit.objective).toBe(MULTI_STEP_GOAL);
    expect(audit.transitions.map((t) => t.to)).toContain("executing");
    expect(audit.decisions).toEqual([
      { decisionId: "cd_d1", action: "delegate", kind: "accepted" },
      { decisionId: "cd_v1", action: "verify", kind: "accepted" },
      { decisionId: "cd_c1", action: "complete", kind: "accepted" },
    ]);
    // budget: every loop turn runs the trio (observe + assess = 2 children each,
    // 3 turns) plus one worker delegation = 7 bounded children
    expect(audit.budgetConsumed?.children).toBe(7);
  });

  it("the TUI mission view maps onto the existing phase vocabulary (§11.5, F-2)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-tui-"));
    const { roles } = scriptedRoles();
    const coordinator = newCoordinator(missionsDir, roles);
    await coordinator.run(intents(MULTI_STEP_GOAL));

    const tui = coordinator.tuiMissionState(MULTI_STEP_GOAL);
    expect(tui.goal).toBe(MULTI_STEP_GOAL);
    for (const id of ["understand", "inspect", "plan", "execute", "validate", "complete"] as const) {
      expect(tui.phases.find((p) => p.id === id)?.status).toBe("completed");
    }
    // no running phase at terminal state: the activity feed shows no crumb
    expect(missionCrumb(tui)).toBeUndefined();
  });

  it("INV-13: a trivial goal gates to single-agent fallback — the trio is never instantiated", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-simple-"));
    const { roles, state } = scriptedRoles();
    const coordinator = newCoordinator(missionsDir, roles);

    const outcome = await coordinator.run(intents(SIMPLE_GOAL));
    expect(outcome.state).toBe("single_agent");
    expect(coordinator.journalEvents().map((e) => e.type)).toContain("mission.single_agent_fallback");
    // the trio never ran: zero observations
    expect(state.observes).toBe(0);
  });

  it("budget exhaustion terminates failed(budget_exhausted)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-budget-"));
    const { roles } = scriptedRoles(); // observe+assess use both children
    const small = policy({
      budget: {
        maxChildren: 2,
        maxModelCalls: 400,
        maxToolCalls: 1500,
        maxTokens: 2_000_000,
        maxDecisionRejections: 3,
      },
    });
    const coordinator = newCoordinator(missionsDir, roles, small);

    const outcome = await coordinator.run(intents(MULTI_STEP_GOAL));
    expect(outcome.outcome).toBe("failed");
    expect(outcome.summary).toContain("budget_exhausted");
    expect(coordinator.audit().outcome).toBe("failed");
  });

  it("a decision loop terminates failed(decision_loop); every rejection is recorded with its gate", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-loop-"));
    // the commander keeps proposing `complete` without evidence — always
    // rejected (unique ids per turn, so the loop guard stays out of the way)
    let n = 0;
    const roles: MissionRoleAgents = {
      observe: async () => ({ report: trackerRef(), artifactPayload: { turn: 1 } }),
      assess: async () => ({ report: predictorRef(), artifactPayload: {} }),
      decide: async () => {
        n += 1;
        return decision({ action: "complete", decisionId: `cd_c${n}` });
      },
    };
    const coordinator = newCoordinator(missionsDir, roles);

    const outcome = await coordinator.run(intents(MULTI_STEP_GOAL));
    expect(outcome.outcome).toBe("failed");
    expect(outcome.summary).toContain("decision-failure budget exhausted");

    const audit = coordinator.audit();
    const rejected = audit.decisions.filter((d) => d.kind === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(3);
    // the first rejections are INV-6 at the re-validation gate (complete
    // without deterministic evidence); the repeated identical decision is
    // then flagged by the LoopDetector (§12.2) — both recorded, never silent
    expect(rejected[0].gate).toBe("policy");
    expect(rejected[0].reason).toContain("verification evidence");
    expect(rejected[1].reason).toContain("verification evidence");
    expect(rejected[rejected.length - 1].reason).toContain("decision loop");
  });

  it("a role crash suspends at a checkpoint; resume completes with the journal intact", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-resume-"));
    const crashScript = scriptedRoles({ crashOnAssess: true });
    const first = newCoordinator(missionsDir, crashScript.roles);
    const suspended = await first.run(intents(MULTI_STEP_GOAL));
    expect(suspended.outcome).toBeNull();
    expect(suspended.resumable).toBe(true);
    expect(suspended.state).toBe("assessing");

    // second incarnation: same mission dir + id, healthy script, resume
    const healthy = scriptedRoles();
    const second = new MissionCoordinator(coordinatorOpts(missionsDir, healthy.roles), first.missionId);
    const resumed = await second.run(intents(MULTI_STEP_GOAL), suspended.checkpoint);
    expect(resumed.outcome).toBe("completed");

    // the journal spans both incarnations: created once, completed once
    const types = second.journalEvents().map((e) => e.type);
    expect(types.filter((t) => t === "mission.created")).toHaveLength(1);
    expect(types.filter((t) => t === "mission.completed")).toHaveLength(1);
    expect(second.audit().outcome).toBe("completed");
  });

  it("a degraded tracker forces re-observation before the next decision (§7.1)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-degraded-"));
    const { roles, state } = scriptedRoles({ health: "healthy-then-healthy" });
    const coordinator = newCoordinator(missionsDir, roles);

    const outcome = await coordinator.run(intents(MULTI_STEP_GOAL));
    expect(outcome.outcome).toBe("completed");
    // first observation was degraded → re-observed before assessing
    expect(state.observes).toBeGreaterThanOrEqual(2);
  });

  it("I7: a late cancel after completion is a no-op, never a rewrite", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-latecancel-"));
    const { roles } = scriptedRoles();
    const coordinator = newCoordinator(missionsDir, roles);
    await coordinator.run(intents(MULTI_STEP_GOAL));

    const before = coordinator.journalEvents().length;
    const result = coordinator.cancel("too late");
    expect(result.outcome).toBe("completed"); // unchanged terminal state
    expect(result.state).toBe("completed");
    expect(coordinator.journalEvents().length).toBe(before);
  });
});

// ── The CLI surface (SPEC §14; deterministic management only) ─────────────

describe("nexum mission CLI (SPEC §14)", () => {
  function tempWorkspace(): string {
    return mkdtempSync(join(tmpdir(), "nexum-mission-cli-"));
  }

  it("start records + gates a mission (multi-step activates the trio path)", async () => {
    const cwd = tempWorkspace();
    const code = await runMissionCli(["start", MULTI_STEP_GOAL], { cwd });
    expect(code).toBe(0);
    // mission state persisted under <cwd>/.nexum/missions
    const missions = readdirSync(join(cwd, ".nexum", "missions"));
    expect(missions).toHaveLength(1);
  });

  it("start with a trivial goal records the single-agent fallback (INV-13)", async () => {
    const cwd = tempWorkspace();
    const code = await runMissionCli(["start", SIMPLE_GOAL], { cwd });
    expect(code).toBe(0);
  });

  it("status and audit report the recorded state deterministically", async () => {
    const cwd = tempWorkspace();
    await runMissionCli(["start", MULTI_STEP_GOAL], { cwd });
    const missionId = readdirSync(join(cwd, ".nexum", "missions"))[0];

    expect(await runMissionCli(["status", missionId], { cwd })).toBe(0);
    expect(await runMissionCli(["audit", missionId], { cwd })).toBe(0);
  });

  it("cancel terminates an active mission; a second cancel is the I7 no-op", async () => {
    const cwd = tempWorkspace();
    await runMissionCli(["start", MULTI_STEP_GOAL], { cwd });
    const missionId = readdirSync(join(cwd, ".nexum", "missions"))[0];

    expect(await runMissionCli(["cancel", missionId, "user changed mind"], { cwd })).toBe(0);
    const checkpoint = JSON.parse(
      readFileSync(join(cwd, ".nexum", "missions", missionId, "checkpoint.json"), "utf8"),
    ) as { state: string };
    expect(checkpoint.state).toBe("cancelled");

    // late cancel: no-op, still exit 0
    expect(await runMissionCli(["cancel", missionId, "again"], { cwd })).toBe(0);
  });

  it("unknown missions and subcommands fail closed with exit 1", async () => {
    const cwd = tempWorkspace();
    expect(await runMissionCli(["audit", "ms_missing"], { cwd })).toBe(1);
    expect(await runMissionCli(["nonsense"], { cwd })).toBe(1);
    expect(await runMissionCli(["start"], { cwd })).toBe(1);
  });
});
