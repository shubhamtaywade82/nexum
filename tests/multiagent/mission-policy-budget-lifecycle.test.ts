/**
 * MAC v1 P5.1 — mission policy, budget envelope, lifecycle (SPEC §7, §9, §12).
 *
 * The deterministic core, testable without any model (scripted fake
 * consumption instead of role runtimes — the coordinator loop wiring lands
 * with the CLI PR):
 *
 *   - INV-1: missions exceeding wallClockMs / maxModelCalls / maxToolCalls /
 *     maxTokens / maxChildren terminate failed(budget_exhausted) with an
 *     itemized consumption record
 *   - INV-2: budgets are checked BEFORE each dispatch, not after; replan
 *     bounds (mission-wide and per-task) terminate failed; no infinite
 *     replan cycle is reachable (state space bounded by policy)
 *   - INV-3: repeated identical decisions / same-DAG-hash replans are
 *     flagged by LoopDetector and cannot re-enter the loop; child-count and
 *     replan limits cannot be raised by a model-generated decision
 *   - I7: terminal mission states are immutable; a late cancel on a
 *     completed mission is a no-op recorded as a warning
 *   - §7.1 transition table + degraded overlay (forced re-observation);
 *     §7.3 checkpoints + resume (orphaned delegations, completed nodes
 *     kept); §7.4 cancellation with the cancelled-scope count
 */

import { describe, it, expect } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUPERVISED_DEFAULTS,
  CONTROLLED_AUTONOMOUS_DEFAULTS,
  RESEARCH_DEFAULTS,
  COMMANDER_ACTIONS,
  resolveMissionPolicy,
  validateMissionPolicy,
  amendMissionPolicy,
  missionPolicySchema,
  type MissionPolicy,
  type MissionPolicyOverrides,
} from "../../src/orchestration/mission/mission-policy.js";
import { MissionBudgetLedger, MissionLoopGuard } from "../../src/orchestration/mission/mission-budget.js";
import {
  MissionLifecycle,
  MissionCheckpointStore,
  canTransitionMission,
  isTerminalMissionState,
  missionCheckpointSchema,
  missionLifecycleStateSchema,
  MISSION_LIFECYCLE_STATES,
  type MissionCheckpoint,
  type MissionLifecycleState,
} from "../../src/orchestration/mission/mission-lifecycle.js";
import { validateMissionEvent, type MissionEvent } from "../../src/orchestration/mission/events.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Small, exhausted-quickly envelope for budget tests (SPEC defaults are asserted separately). */
function smallPolicy(extra: MissionPolicyOverrides = {}): MissionPolicy {
  const base: MissionPolicyOverrides = {
    budget: {
      wallClockMs: 60_000,
      maxModelCalls: 3,
      maxToolCalls: 3,
      maxTokens: 100,
      maxChildren: 2,
      maxReplans: 2,
      maxDecisionRejections: 2,
    },
  };
  const merged: MissionPolicyOverrides = {
    ...base,
    ...extra,
    budget: { ...base.budget!, ...(extra.budget ?? {}) },
  };
  const res = resolveMissionPolicy({ overrides: merged });
  if (!res.ok || !res.policy) throw new Error(`small policy refused: ${res.reason}`);
  return res.policy;
}

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A lifecycle in a temp missions dir that records every emitted event. */
function freshLifecycle(policy: MissionPolicy) {
  const events: MissionEvent[] = [];
  const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-lifecycle-"));
  const lifecycle = MissionLifecycle.begin({
    missionId: "ms_test",
    policy,
    ledger: new MissionBudgetLedger(policy),
    missionsDir,
    emit: (e) => events.push(e),
  });
  return { lifecycle, events, missionsDir };
}

/** created → triaging → observing → assessing → planning → executing */
function driveToExecuting(lifecycle: MissionLifecycle) {
  for (const [to, reason] of [
    ["triaging", "complexity gate: multi-step"],
    ["observing", "trio activated"],
    ["assessing", "tracker report published"],
    ["planning", "prediction report in"],
    ["executing", "decision(delegate) validated"],
  ] as const) {
    const r = lifecycle.transition(to, reason);
    if (!r.ok) throw new Error(`drive failed at ${to}: ${r.reason}`);
  }
}

// ── Mission policy (SPEC §9, §12.1) ─────────────────────────────────────────

describe("mission policy (SPEC §9, §12.1)", () => {
  it("SUPERVISED_DEFAULTS match SPEC §9 verbatim", () => {
    expect(SUPERVISED_DEFAULTS).toEqual({
      profile: "supervised",
      maxReplans: 2,
      maxReplansPerTask: 1,
      maxRetriesPerTask: 2,
      budget: {
        wallClockMs: 30 * 60_000,
        maxModelCalls: 400,
        maxToolCalls: 1_500,
        maxTokens: 2_000_000,
        maxChildren: 8,
        maxDepth: 1,
        maxReplans: 2,
        maxDecisionRejections: 3,
      },
      delegationPolicy: { maxConcurrentChildren: 2, maxTotalChildren: 8, inheritPolicy: true, cancelWithParent: true },
      allowedActions: [...COMMANDER_ACTIONS],
      approvalTimeoutMs: 24 * 3_600_000,
      maxContextHandoffChars: 32_768,
      requireKitWorkflow: false,
    });
  });

  it("profile wall-clock defaults: 30 / 60 / 120 minutes; research forces worktree isolation", () => {
    expect(SUPERVISED_DEFAULTS.budget.wallClockMs).toBe(30 * 60_000);
    expect(CONTROLLED_AUTONOMOUS_DEFAULTS.profile).toBe("controlled-autonomous");
    expect(CONTROLLED_AUTONOMOUS_DEFAULTS.budget.wallClockMs).toBe(60 * 60_000);
    expect(RESEARCH_DEFAULTS.profile).toBe("research");
    expect(RESEARCH_DEFAULTS.budget.wallClockMs).toBe(120 * 60_000);
    expect(RESEARCH_DEFAULTS.isolation).toBe("worktree");
    expect(RESEARCH_DEFAULTS.delegationPolicy.maxConcurrentChildren).toBe(1);
  });

  it("defaults to supervised; profile escalation beyond the enabled set is refused fail-closed", () => {
    const def = resolveMissionPolicy();
    expect(def.ok).toBe(true);
    expect(def.policy?.profile).toBe("supervised");

    const research = resolveMissionPolicy({ profile: "research" });
    expect(research.ok).toBe(false);
    expect(research.reason).toContain("not enabled");

    const enabled = resolveMissionPolicy({
      profile: "research",
      enabledProfiles: ["supervised", "research"],
    });
    expect(enabled.ok).toBe(true);
    expect(enabled.policy?.isolation).toBe("worktree");
  });

  it("config overrides apply, and coherence validation still runs", () => {
    const ok = resolveMissionPolicy({
      overrides: { budget: { maxToolCalls: 500 }, allowedActions: ["delegate", "verify", "abort"] },
    });
    expect(ok.ok).toBe(true);
    expect(ok.policy?.budget.maxToolCalls).toBe(500);
    expect(ok.policy?.allowedActions).toEqual(["delegate", "verify", "abort"]);

    const tooManyChildren = validateMissionPolicy({
      ...SUPERVISED_DEFAULTS,
      budget: { ...SUPERVISED_DEFAULTS.budget, maxChildren: 16 },
    });
    expect(tooManyChildren).toContain("maxTotalChildren");

    const badDepth = validateMissionPolicy({
      ...SUPERVISED_DEFAULTS,
      budget: { ...SUPERVISED_DEFAULTS.budget, maxDepth: 2 },
    });
    expect(badDepth).toContain("maxDepth");

    const replanMismatch = validateMissionPolicy({
      ...SUPERVISED_DEFAULTS,
      maxReplans: 3,
    });
    expect(replanMismatch).toContain("maxReplans");
  });

  it("policy schema is strict on write (unknown fields rejected)", () => {
    expect(missionPolicySchema.safeParse(SUPERVISED_DEFAULTS).success).toBe(true);
    const hostile = { ...SUPERVISED_DEFAULTS, sneaky: true } as unknown as MissionPolicy;
    expect(missionPolicySchema.safeParse(hostile).success).toBe(false);
  });

  it("INV-3 (limits): a model-generated amendment cannot raise child-count or replan limits", () => {
    // raises refused
    const raiseReplans = amendMissionPolicy(SUPERVISED_DEFAULTS, { maxReplans: 5, budget: { maxReplans: 5 } }, "model");
    expect(raiseReplans.ok).toBe(false);
    expect(raiseReplans.reason).toContain("narrow");

    const raiseChildren = amendMissionPolicy(SUPERVISED_DEFAULTS, { budget: { maxChildren: 16 } }, "model");
    expect(raiseChildren.ok).toBe(false);

    const raiseDelegation = amendMissionPolicy(
      SUPERVISED_DEFAULTS,
      { delegationPolicy: { maxTotalChildren: 16 } },
      "model",
    );
    expect(raiseDelegation.ok).toBe(false);

    const raiseDepth = amendMissionPolicy(SUPERVISED_DEFAULTS, { budget: { maxDepth: 2 } }, "model");
    expect(raiseDepth.ok).toBe(false);

    const ungatedKit = amendMissionPolicy(
      { ...SUPERVISED_DEFAULTS, requireKitWorkflow: true },
      { requireKitWorkflow: false },
      "model",
    );
    expect(ungatedKit.ok).toBe(false);

    // widening a narrowed action set refused
    const narrowed = amendMissionPolicy(
      SUPERVISED_DEFAULTS,
      { allowedActions: ["delegate", "verify", "abort"] },
      "model",
    );
    expect(narrowed.ok).toBe(true);
    const widen = amendMissionPolicy(
      narrowed.policy!,
      { allowedActions: ["delegate", "verify", "abort", "complete"] },
      "model",
    );
    expect(widen.ok).toBe(false);

    // narrowing accepted
    const narrow = amendMissionPolicy(
      SUPERVISED_DEFAULTS,
      { maxReplans: 1, budget: { maxReplans: 1, maxChildren: 4 } },
      "model",
    );
    expect(narrow.ok).toBe(true);
    expect(narrow.policy?.budget.maxChildren).toBe(4);

    // config (human) may raise
    const config = amendMissionPolicy(SUPERVISED_DEFAULTS, { maxReplans: 3, budget: { maxReplans: 3 } }, "config");
    expect(config.ok).toBe(true);
  });
});

// ── Budget envelope (SPEC §12, INV-1 / INV-2) ───────────────────────────────

describe("mission budget envelope (SPEC §12, INV-1/INV-2)", () => {
  it("preflight is green within the envelope and itemizes the first exceeded dimension", () => {
    const clock = fakeClock();
    const ledger = new MissionBudgetLedger(smallPolicy(), { now: clock.now });
    expect(ledger.preflight().ok).toBe(true);

    ledger.recordModelCall({ promptTokens: 10, completionTokens: 5 });
    expect(ledger.preflight().ok).toBe(true);

    ledger.recordModelCall({ promptTokens: 10, completionTokens: 5 });
    ledger.recordModelCall({ promptTokens: 10, completionTokens: 5 });
    const pre = ledger.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.exceeded).toEqual([{ dimension: "maxModelCalls", consumed: 3, limit: 3 }]);
    expect(pre.snapshot.modelCalls).toBe(3);
    expect(pre.snapshot.totalTokens).toBe(45);
  });

  it("INV-2: preflight checks before dispatch and never consumes", () => {
    const ledger = new MissionBudgetLedger(smallPolicy());
    const first = ledger.preflight();
    expect(first.ok).toBe(true);
    expect(ledger.preflight().snapshot.modelCalls).toBe(first.snapshot.modelCalls);
  });

  it("INV-1: wall-clock exhaustion terminates with an itemized record (injectable clock)", () => {
    const clock = fakeClock();
    const ledger = new MissionBudgetLedger(smallPolicy(), { now: clock.now });
    clock.advance(60_000);
    const pre = ledger.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.exceeded[0]).toMatchObject({ dimension: "wallClockMs", limit: 60_000 });
    expect(pre.exceeded[0].consumed).toBeGreaterThanOrEqual(60_000);
  });

  it("INV-1: tool-call, token and children ceilings each itemized; depth capped at 1", () => {
    const ledger = new MissionBudgetLedger(smallPolicy());
    ledger.recordToolCall();
    ledger.recordToolCall();
    ledger.recordToolCall();
    expect(ledger.preflight().exceeded).toContainEqual({ dimension: "maxToolCalls", consumed: 3, limit: 3 });

    const tokens = new MissionBudgetLedger(smallPolicy());
    tokens.recordModelCall({ promptTokens: 60, completionTokens: 40 }); // exactly at the 100 ceiling
    expect(tokens.preflight().exceeded).toContainEqual({ dimension: "maxTokens", consumed: 100, limit: 100 });

    expect(ledger.recordChild().ok).toBe(true);
    expect(ledger.recordChild().ok).toBe(true);
    const thirdChild = ledger.recordChild();
    expect(thirdChild.ok).toBe(false);
    expect(thirdChild.reason).toContain("child budget exhausted");
    expect(ledger.preflight().exceeded).toContainEqual({ dimension: "maxChildren", consumed: 2, limit: 2 });

    const deep = ledger.recordChild(2);
    expect(deep.ok).toBe(false);
    expect(deep.reason).toContain("maxDepth");
  });

  it("INV-1: recordModelCall throws past the hard ceiling (BudgetManager backstop, never retried)", () => {
    const ledger = new MissionBudgetLedger(smallPolicy()); // maxModelCalls 3
    ledger.recordModelCall();
    ledger.recordModelCall();
    ledger.recordModelCall();
    expect(() => ledger.recordModelCall()).toThrow();
  });

  it("INV-2: mission-wide replan bound; exhaustion surfaces as an exceeded dimension", () => {
    const ledger = new MissionBudgetLedger(smallPolicy()); // maxReplans 2
    expect(ledger.requestReplan().ok).toBe(true);
    expect(ledger.requestReplan().ok).toBe(true);
    const third = ledger.requestReplan();
    expect(third.ok).toBe(false);
    expect(third.reason).toContain("replan budget exhausted");
    expect(ledger.exceededDimensions()).toContainEqual({ dimension: "maxReplans", consumed: 2, limit: 2 });
  });

  it("INV-2: per-task replan bound — the exhausted task is named, other tasks still may replan", () => {
    const ledger = new MissionBudgetLedger(smallPolicy()); // maxReplansPerTask 1
    expect(ledger.requestReplan("t1").ok).toBe(true);
    const again = ledger.requestReplan("t1");
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('"t1"');
    expect(ledger.requestReplan("t2").ok).toBe(true);
  });

  it("INV-2 (state-space bound): the verify→replan loop terminates within policy", () => {
    // Scripted fake role loop: the verification gate keeps failing and the
    // commander keeps replanning. The ledger bounds the cycle — after
    // maxReplans the refusal forces termination; an infinite replan loop is
    // unreachable because every cycle consumes bounded budget.
    const policy = smallPolicy(); // maxReplans 2
    const ledger = new MissionBudgetLedger(policy);
    const { lifecycle } = freshLifecycle(policy);
    driveToExecuting(lifecycle);
    expect(lifecycle.transition("verifying", "delegation results in").ok).toBe(true);

    let replans = 0;
    let terminated = false;
    for (let turn = 0; turn < 10; turn += 1) {
      const replan = ledger.requestReplan(); // mission-wide bound
      if (!replan.ok) {
        terminated = true;
        expect(replan.reason).toContain("replan budget exhausted");
        break;
      }
      replans += 1;
      expect(lifecycle.transition("planning", "gate failed, replans left").ok).toBe(true);
      expect(lifecycle.transition("executing", "decision(delegate) validated").ok).toBe(true);
      expect(lifecycle.transition("verifying", "delegation results in").ok).toBe(true);
    }
    expect(replans).toBe(2);
    expect(terminated).toBe(true);
    const failResult = lifecycle.fail("replan budget exhausted", ledger.exceededDimensions());
    expect(failResult.ok).toBe(true);
    expect(lifecycle.state).toBe("failed");
  });

  it("decision-rejection budget: consecutive rejections exhaust; an accepted decision resets it", () => {
    const ledger = new MissionBudgetLedger(smallPolicy()); // maxDecisionRejections 2
    expect(ledger.recordDecisionRejection().ok).toBe(true);
    const second = ledger.recordDecisionRejection();
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("decision-failure budget exhausted");

    ledger.acceptDecision();
    expect(ledger.recordDecisionRejection().ok).toBe(true);
  });

  it("child budget managers derive within the envelope; child consumption propagates up", () => {
    const policy = smallPolicy({ budget: { maxModelCalls: 8, maxToolCalls: 8, maxTokens: 10_000 } });
    const ledger = new MissionBudgetLedger(policy);
    const child = ledger.childBudgetManager(1.0);
    expect(child.limits().maxModelCalls).toBeLessThanOrEqual(policy.budget.maxModelCalls);
    expect(child.limits().maxToolCalls).toBeLessThanOrEqual(policy.budget.maxToolCalls);
    for (let i = 0; i < 8; i += 1) {
      child.consumeModelCall({ promptTokens: 10, completionTokens: 10 });
    }
    expect(ledger.snapshot().modelCalls).toBe(8);
    const pre = ledger.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.exceeded).toContainEqual({ dimension: "maxModelCalls", consumed: 8, limit: 8 });
  });
});

// ── Loop prevention (SPEC §12.2, INV-3) ─────────────────────────────────────

describe("decision / replan loop prevention (SPEC §12.2, INV-3)", () => {
  it("repeated identical decisions are flagged by LoopDetector and cannot re-enter the loop", () => {
    const guard = new MissionLoopGuard();
    const decision = { action: "delegate", taskIds: ["t2", "t1"], rationale: "Same   plan (whitespace varies)" };
    expect(guard.admitDecision(decision).admitted).toBe(true);
    // near-identical rationale (whitespace/case) normalizes to the same signature
    expect(
      guard.admitDecision({ ...decision, taskIds: ["t1", "t2"], rationale: "same plan (whitespace varies)" }).admitted,
    ).toBe(true);
    const third = guard.admitDecision(decision);
    expect(third.admitted).toBe(false);
    expect(third.flagged).toBe(true);
    expect(third.reason).toContain("decision loop");
  });

  it("a different decision resets the repeat counter (no false positives)", () => {
    const guard = new MissionLoopGuard();
    const a = { action: "delegate", taskIds: ["t1"], rationale: "first plan" };
    const b = { action: "verify", taskIds: ["t1"], rationale: "verify instead" };
    for (const d of [a, b, a, b, a, b]) {
      expect(guard.admitDecision(d).admitted).toBe(true);
    }
  });

  it("a replan cycle returning the same DAG hash cannot re-enter planning", () => {
    const guard = new MissionLoopGuard();
    expect(guard.admitReplan("dag-aaa").admitted).toBe(true);
    expect(guard.admitReplan("dag-bbb").admitted).toBe(true);
    const back = guard.admitReplan("dag-aaa");
    expect(back.admitted).toBe(false);
    expect(back.seenBefore).toBe(true);
    expect(back.reason).toContain("returned twice");
    const third = guard.admitReplan("dag-aaa");
    expect(third.admitted).toBe(false);
    expect(third.flagged).toBe(true);
  });
});

// ── Lifecycle (SPEC §7) ─────────────────────────────────────────────────────

describe("mission lifecycle state machine (SPEC §7.1)", () => {
  it("the §7.1 transition table, verbatim: every diagram edge legal, non-edges refused", () => {
    const legal: Array<[MissionLifecycleState, MissionLifecycleState]> = [
      ["created", "triaging"],
      ["triaging", "single_agent"],
      ["triaging", "observing"],
      ["single_agent", "completed"],
      ["observing", "assessing"],
      ["assessing", "planning"],
      ["assessing", "observing"],
      ["planning", "executing"],
      ["planning", "awaiting_approval"],
      ["planning", "aborted"],
      ["executing", "verifying"],
      ["executing", "awaiting_approval"],
      ["verifying", "completed"],
      ["verifying", "planning"],
      ["verifying", "failed"],
      ["awaiting_approval", "executing"],
      ["awaiting_approval", "aborted"],
    ];
    for (const [from, to] of legal) {
      expect(canTransitionMission(from, to)).toBe(true);
    }
    const illegal: Array<[MissionLifecycleState, MissionLifecycleState]> = [
      ["created", "completed"],
      ["observing", "executing"],
      ["executing", "planning"],
      ["triaging", "assessing"],
      ["planning", "completed"],
      ["awaiting_approval", "planning"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransitionMission(from, to)).toBe(false);
    }
    // closed state union; terminal states refuse ALL outgoing edges (I7)
    expect(MISSION_LIFECYCLE_STATES).toHaveLength(13);
    for (const terminal of ["completed", "failed", "aborted", "cancelled"] as const) {
      expect(isTerminalMissionState(terminal)).toBe(true);
      expect(canTransitionMission(terminal, "observing")).toBe(false);
    }
  });

  it("every applied transition emits valid mission.phase + mission.checkpoint events and persists a checkpoint", () => {
    const { lifecycle, events, missionsDir } = freshLifecycle(smallPolicy());
    driveToExecuting(lifecycle);
    expect(lifecycle.transition("verifying", "delegation results in").ok).toBe(true);
    expect(lifecycle.transition("completed", "deterministic gates passed").ok).toBe(true);

    const phases = events.filter((e) => e.type === "mission.phase");
    expect(phases).toHaveLength(7);
    for (const e of events) {
      expect(validateMissionEvent(e).valid).toBe(true);
    }
    const lastPhase = phases[phases.length - 1] as { payload?: { from: string; to: string } };
    expect(lastPhase.payload).toMatchObject({ from: "verifying", to: "completed" });

    const cpPath = join(missionsDir, "ms_test", "checkpoint.json");
    expect(existsSync(cpPath)).toBe(true);
    const cp = JSON.parse(readFileSync(cpPath, "utf8")) as MissionCheckpoint;
    expect(cp.state).toBe("completed");
    expect(cp.seq).toBe(lifecycle.lastEventSeq);
    expect(cp.missionId).toBe("ms_test");
    expect(missionCheckpointSchema.safeParse(cp).success).toBe(true);
  });

  it("I7: terminal states are immutable — late transitions are refused and recorded as warnings", () => {
    const { lifecycle, events } = freshLifecycle(smallPolicy());
    driveToExecuting(lifecycle);
    expect(lifecycle.transition("verifying").ok).toBe(true);
    expect(lifecycle.transition("completed", "gates passed").ok).toBe(true);

    const eventCount = events.length;
    const refused = lifecycle.transition("failed", "too late");
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("immutable");
    expect(lifecycle.state).toBe("completed");
    expect(lifecycle.record.warnings.some((w) => w.kind === "terminal-transition")).toBe(true);
    // the refusal is recorded but emits no new mission events
    expect(events.length).toBe(eventCount);
  });

  it("I7: a late cancel on a completed mission is a no-op recorded as a warning, never a rewrite", () => {
    const { lifecycle, events } = freshLifecycle(smallPolicy());
    driveToExecuting(lifecycle);
    lifecycle.transition("verifying", "delegation results in");
    lifecycle.transition("completed", "gates passed");

    const eventCount = events.length;
    const result = lifecycle.cancel("user changed their mind");
    expect(result.changed).toBe(false);
    expect(result.warning?.kind).toBe("late-cancel");
    expect(lifecycle.state).toBe("completed");
    expect(events.length).toBe(eventCount); // no mission.cancelled emitted
  });

  it("§7.4: cancel from an active state records mission.cancelled with the cancelled-scope count", () => {
    const { lifecycle, events } = freshLifecycle(smallPolicy());
    driveToExecuting(lifecycle);
    lifecycle.trackDelegation("dele_1");
    lifecycle.trackDelegation("dele_2");
    lifecycle.settleDelegation("dele_2"); // one settled: one still in flight

    const result = lifecycle.cancel("user abort");
    expect(result.changed).toBe(true);
    expect(result.cancelledScopeCount).toBe(2); // the mission scope + 1 in-flight child
    expect(lifecycle.state).toBe("cancelled");
    expect(lifecycle.record.pendingDelegations).toEqual([]);

    const cancelled = events.find((e) => e.type === "mission.cancelled") as
      { payload?: { summary?: string } } | undefined;
    expect(cancelled).toBeDefined();
    expect(cancelled?.payload?.summary).toContain("2 scopes");
    expect(validateMissionEvent(cancelled).valid).toBe(true);
  });

  it("§7.1: the degraded overlay forces re-observation and never unblocks by itself", () => {
    const { lifecycle } = freshLifecycle(smallPolicy());
    driveToExecuting(lifecycle);

    expect(lifecycle.markDegraded().ok).toBe(true);
    // productive transitions refused while degraded
    const refused = lifecycle.transition("verifying", "delegation results in");
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("degraded");

    // recovery path: any active state -> observing (§7.1 diagram)
    expect(lifecycle.transition("observing", "health degraded: re-observe").ok).toBe(true);
    // the overlay persists through the forced re-observation...
    expect(lifecycle.degraded).toBe(true);
    expect(lifecycle.transition("assessing", "tracker report").ok).toBe(false);
    // ...until the fresh tracker report lands
    expect(lifecycle.clearDegradedAfterObservation().ok).toBe(true);
    expect(lifecycle.transition("assessing", "tracker report").ok).toBe(true);
  });

  it("§7.1: degraded can be marked on active trio states, never on terminal ones", () => {
    const { lifecycle } = freshLifecycle(smallPolicy());
    driveToExecuting(lifecycle);
    expect(lifecycle.markDegraded().ok).toBe(true);
    // while degraded, the productive path is blocked — recover first
    expect(lifecycle.transition("observing", "re-observe").ok).toBe(true);
    expect(lifecycle.clearDegradedAfterObservation().ok).toBe(true);

    expect(lifecycle.transition("assessing", "tracker report").ok).toBe(true);
    expect(lifecycle.transition("planning", "prediction report in").ok).toBe(true);
    expect(lifecycle.transition("awaiting_approval", "approval-class action").ok).toBe(true);
    expect(lifecycle.markDegraded().ok).toBe(true); // awaiting_approval may carry the overlay
    expect(lifecycle.transition("aborted", "approval denied").ok).toBe(true); // stopping is always allowed

    expect(lifecycle.markDegraded().ok).toBe(false); // terminal: overlay does not apply
  });

  it("INV-1/INV-2 at the lifecycle: exhausted budgets refuse productive transitions, then fail with itemized consumption", () => {
    const policy = smallPolicy();
    const clock = fakeClock();
    const ledger = new MissionBudgetLedger(policy, { now: clock.now });
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-lifecycle-"));
    const events: MissionEvent[] = [];
    const lifecycle = MissionLifecycle.begin({
      missionId: "ms_broke",
      policy,
      ledger,
      missionsDir,
      emit: (e) => events.push(e),
    });

    expect(lifecycle.transition("triaging", "complexity gate").ok).toBe(true);
    // burn the whole model-call budget; the next dispatch (observing =
    // delegating to the trio) must be refused BEFORE it starts
    ledger.recordModelCall();
    ledger.recordModelCall();
    ledger.recordModelCall();

    const refused = lifecycle.transition("observing", "trio activated");
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("budget_exhausted");
    expect(refused.exceeded).toEqual([{ dimension: "maxModelCalls", consumed: 3, limit: 3 }]);

    const failed = lifecycle.fail("budget_exhausted", ledger.exceededDimensions());
    expect(failed.ok).toBe(true);
    expect(lifecycle.state).toBe("failed");
    const failEvent = events.find((e) => e.type === "mission.failed") as { payload?: { summary?: string } } | undefined;
    expect(failEvent?.payload?.summary).toContain("maxModelCalls 3/3");
    expect(validateMissionEvent(failEvent).valid).toBe(true);

    // I7 still holds after failing
    expect(lifecycle.cancel("too late").changed).toBe(false);
  });

  it("§7.3 resume: orphaned delegations marked, completed nodes kept, re-enters at observing", () => {
    const policy = smallPolicy();
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-mission-resume-"));
    const first = MissionLifecycle.begin({
      missionId: "ms_resume",
      policy,
      ledger: new MissionBudgetLedger(policy),
      missionsDir,
    });
    driveToExecuting(first);
    first.trackDelegation("dele_1");
    first.trackDelegation("dele_2");
    first.setTaskGraph({
      nodes: [
        { nodeId: "t1", status: "done", replanCount: 0 },
        { nodeId: "t2", status: "in_flight", replanCount: 0 },
        { nodeId: "t3", status: "pending", replanCount: 0 },
      ],
    });
    const cp = first.checkpoint();

    const resumed = MissionLifecycle.resume(cp, {
      missionId: "ms_resume",
      policy,
      ledger: new MissionBudgetLedger(policy),
      missionsDir,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const { lifecycle, orphaned, warnings } = resumed;
    expect(orphaned).toEqual(["dele_1", "dele_2"]);
    expect(warnings.filter((w) => w.kind === "resume-orphaned").length).toBe(3); // 2 delegations + 1 in-flight node
    expect(lifecycle.state).toBe("observing");
    expect(lifecycle.degraded).toBe(true); // fresh observation forced
    // completed verified nodes are never re-executed; in_flight became orphaned
    expect(lifecycle.record.taskGraph?.nodes).toEqual([
      { nodeId: "t1", status: "done", replanCount: 0 },
      { nodeId: "t2", status: "orphaned", replanCount: 0 },
      { nodeId: "t3", status: "pending", replanCount: 0 },
    ]);

    // a terminal checkpoint cannot be resumed (I7)
    const terminalCp: MissionCheckpoint = { ...cp, state: "completed" };
    const refused = MissionLifecycle.resume(terminalCp, {
      missionId: "ms_resume",
      policy,
      ledger: new MissionBudgetLedger(policy),
      missionsDir,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("terminal");
  });

  it("checkpoint store: strict schema on write; corrupted files load as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-mission-store-"));
    const store = new MissionCheckpointStore(join(dir, "ms_store"));
    const policy = smallPolicy();
    const lifecycle = MissionLifecycle.begin({
      missionId: "ms_store",
      policy,
      ledger: new MissionBudgetLedger(policy),
      missionsDir: dir,
    });
    driveToExecuting(lifecycle);
    const cp = lifecycle.checkpoint();
    expect(store.load()).toEqual(cp);

    writeFileSync(store.path, "{ not json");
    expect(store.load()).toBeNull();
    writeFileSync(store.path, JSON.stringify({ ...cp, sneaky: true }));
    expect(store.load()).toBeNull(); // strict: unknown fields fail validation

    expect(missionLifecycleStateSchema.safeParse("completed").success).toBe(true);
    expect(missionLifecycleStateSchema.safeParse("paused").success).toBe(false);
  });
});
