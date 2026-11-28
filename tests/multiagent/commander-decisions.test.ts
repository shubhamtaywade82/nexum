/**
 * MAC v1 P5.2 — commander decision contracts + re-validation
 * (SPEC §4.3, §11.4; ROADMAP P5, issue #83).
 *
 * The authority boundary is the load-bearing rule: a CommanderDecision is
 * a PROPOSAL; the coordinator re-validates every decision deterministically
 * before anything executes. All tests are model-free — the decisions are
 * forged fixtures, exactly the hostile inputs the validation exists for.
 *
 *   - INV-4: a "valid-looking" forged decision exceeding profile
 *     allowedActions, budget, or caps is refused; refusal is attributable
 *   - INV-5: an invalid DAG is rejected by validatePlanDag; rejection is
 *     final for the proposal — never auto-repaired by the coordinator
 *   - INV-6: `complete` without deterministic verification evidence is
 *     refused; a commander's claim is never evidence
 *   - approval-class routing: request_approval always routes to the
 *     ApprovalManager (human resolution); the decision layer has no code
 *     path that resolves an approval
 *   - the delegation request is CONSTRUCTED by the coordinator from the
 *     proposal — allowlisted fields only, never trusted wholesale from the
 *     model; the Delegator picks the worker
 *   - the mission plane's mirrored decision schema stays in sync with the
 *     commander plane's contract
 */

import { describe, it, expect } from "@jest/globals";
import type { PlanStep } from "../../src/core/plan/plan-contracts.js";
import {
  buildCommanderDecision,
  commanderDecisionSchema,
  newCommanderDecisionId,
  type CommanderDecision,
} from "../../src/agents/commander/contracts.js";
import { createCommanderEvaluatorStub } from "../../src/agents/commander/evaluator.js";
import {
  reValidateDecision,
  type DecisionCandidate,
  type DecisionValidationContext,
} from "../../src/orchestration/mission/mission-coordinator.ts";
import { SUPERVISED_DEFAULTS, type MissionPolicy } from "../../src/orchestration/mission/mission-policy.js";
import { decisionRejectionSchema } from "../../src/orchestration/mission/events.js";

// ── helpers ────────────────────────────────────────────────────────────────

function step(id: string, dependencies: string[] = []): PlanStep {
  return { id, description: `step ${id}`, status: "pending", dependencies, retryCount: 0 };
}

const PLAN: PlanStep[] = [step("s1"), step("s2", ["s1"]), step("s3", ["s2"])];

/** Supervised policy with small caps so the budget gates trip deterministically. */
const POLICY: MissionPolicy = {
  ...SUPERVISED_DEFAULTS,
  budget: { ...SUPERVISED_DEFAULTS.budget, maxChildren: 2, maxReplans: 2 },
  delegationPolicy: { maxConcurrentChildren: 2, maxTotalChildren: 8, inheritPolicy: true, cancelWithParent: true },
};

function context(overrides: Partial<DecisionValidationContext> = {}): DecisionValidationContext {
  return {
    policy: POLICY,
    planSteps: PLAN,
    verificationVerdicts: [],
    replansUsed: 0,
    replansUsedByTask: {},
    retriesByTask: {},
    childrenInFlight: 0,
    childrenStarted: 0,
    kitJournalVerified: false,
    ...overrides,
  };
}

function decision(partial: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    decisionId: "cd_00000000-0000-4000-8000-000000000001",
    missionId: "ms_1",
    action: "verify",
    rationale: "verify the fix",
    basedOnReports: ["tr_1", "pr_1"],
    evidenceRefs: ["artifact:ma_1"],
    schemaVersion: 1,
    ...partial,
  };
}

const DELEGATE = {
  action: "delegate" as const,
  delegation: {
    goal: "write the regression test",
    requiredCapabilities: ["code-edit"],
    budgetShare: 0.25,
  },
};

// ── Commander plane: the decision contract (SPEC §4.3) ─────────────────────

describe("commander decision contract (SPEC §4.3)", () => {
  it("round-trips a valid delegate decision through the strict schema", () => {
    const built = buildCommanderDecision({
      missionId: "ms_1",
      action: "delegate",
      rationale: "t2 needs a worker",
      taskIds: ["s2"],
      delegation: {
        goal: "write the regression test",
        requiredCapabilities: ["code-edit", "test-execution"],
        budgetShare: 0.25,
        maxToolTurns: 12,
      },
      basedOnReports: ["tr_1", "pr_1"],
      evidenceRefs: ["artifact:ma_1", "run:run_2"],
    });
    expect(built.decisionId).toMatch(/^cd_/);
    expect(commanderDecisionSchema.safeParse(built).success).toBe(true);
  });

  it("enforces the SPEC §4.3 iff-rules: each action needs exactly its record", () => {
    // delegate without a delegation proposal
    expect(commanderDecisionSchema.safeParse(decision({ action: "delegate" })).success).toBe(false);
    // a delegation proposal on a non-delegate decision
    expect(commanderDecisionSchema.safeParse(decision({ ...DELEGATE, action: "verify" })).success).toBe(false);
    // replan without its record / with a foreign record
    expect(commanderDecisionSchema.safeParse(decision({ action: "replan" })).success).toBe(false);
    expect(
      commanderDecisionSchema.safeParse(decision({ action: "verify", replan: { reason: "x", changedNodes: ["s1"] } }))
        .success,
    ).toBe(false);
    // retry / approval iff-rules
    expect(commanderDecisionSchema.safeParse(decision({ action: "retry" })).success).toBe(false);
    expect(commanderDecisionSchema.safeParse(decision({ action: "request_approval" })).success).toBe(false);
    expect(
      commanderDecisionSchema.safeParse(
        decision({
          action: "abort",
          approvalRequest: { subject: "push", riskClass: "REMOTE", description: "push branch" },
        }),
      ).success,
    ).toBe(false);
  });

  it("no evidence, no decision: basedOnReports and evidenceRefs are non-empty", () => {
    expect(commanderDecisionSchema.safeParse(decision({ basedOnReports: [] })).success).toBe(false);
    expect(commanderDecisionSchema.safeParse(decision({ evidenceRefs: [] })).success).toBe(false);
    expect(commanderDecisionSchema.safeParse(decision({ evidenceRefs: ["not-a-ref"] })).success).toBe(false);
  });

  it("the approval risk class is a closed enum (forgery fails at the schema)", () => {
    expect(
      commanderDecisionSchema.safeParse(
        decision({
          action: "request_approval",
          approvalRequest: { subject: "s", riskClass: "SUPERUSER", description: "d" },
        }),
      ).success,
    ).toBe(false);
  });

  it("hostile extra fields are rejected (strict on write) — including injected childAgentId", () => {
    const hostile = {
      ...decision(DELEGATE),
      delegation: { ...DELEGATE.delegation, childAgentId: "devagent" },
    } as DecisionCandidate;
    expect(commanderDecisionSchema.safeParse(hostile).success).toBe(false);
  });

  it("buildCommanderDecision fails closed on an invalid decision", () => {
    expect(() =>
      buildCommanderDecision({
        missionId: "ms_1",
        action: "delegate",
        rationale: "no proposal",
        basedOnReports: ["tr_1"],
        evidenceRefs: ["run:run_1"],
      } as Parameters<typeof buildCommanderDecision>[0]),
    ).toThrow(/invalid commander decision/);
    expect(newCommanderDecisionId()).toMatch(/^cd_/);
  });

  it("evaluator stub fails closed (P7 wiring point; never an invented score)", () => {
    const evaluator = createCommanderEvaluatorStub();
    expect(evaluator.evaluate(decision(DELEGATE) as unknown as CommanderDecision)).toBeNull();
  });
});

// ── reValidateDecision (SPEC §11.4) ────────────────────────────────────────

describe("reValidateDecision — profile + schema gates (SPEC §11.4, INV-4)", () => {
  it("accepts a valid delegate decision and constructs the DelegationRequest itself", () => {
    const result = reValidateDecision(decision({ ...DELEGATE, taskIds: ["s2"] }), context());
    expect(result.ok).toBe(true);
    expect(result.delegationRequest).toEqual({
      goal: "write the regression test",
      requiredCapabilities: ["code-edit"],
      budgetShare: 0.25,
    });
    // the worker is NOT chosen by the model: no childAgentId, no metadata
    expect(result.delegationRequest).not.toHaveProperty("childAgentId");
    expect(result.delegationRequest).not.toHaveProperty("metadata");
  });

  it("INV-4: a forged action outside allowedActions is refused (gate: profile)", () => {
    const narrowedPolicy: MissionPolicy = {
      ...POLICY,
      allowedActions: ["delegate", "verify", "abort"],
    };
    const result = reValidateDecision(
      decision({ action: "complete", basedOnReports: ["tr_1"] }),
      context({ policy: narrowedPolicy }),
    );
    expect(result.ok).toBe(false);
    expect(result.gate).toBe("profile");
    expect(result.reason).toContain("allowedActions");
    expect(result.decisionId).toMatch(/^cd_/);
  });

  it("INV-4: a malformed decision is refused (gate: schema) — never executed on faith", () => {
    expect(reValidateDecision(decision({ rationale: "" }), context()).gate).toBe("schema");
    expect(reValidateDecision(decision({ basedOnReports: [] }), context()).gate).toBe("schema");
    expect(reValidateDecision(decision({ evidenceRefs: ["bogus"] }), context()).gate).toBe("schema");
    expect(reValidateDecision(decision({ action: "delegate" }), context()).gate).toBe("schema");
  });

  it("INV-4: delegation caps are enforced before any dispatch (gate: budget)", () => {
    // concurrency cap reached
    const concurrent = reValidateDecision(decision(DELEGATE), context({ childrenInFlight: 2 }));
    expect(concurrent.ok).toBe(false);
    expect(concurrent.gate).toBe("budget");
    expect(concurrent.reason).toContain("maxConcurrentChildren");

    // total children cap reached
    const total = reValidateDecision(decision(DELEGATE), context({ childrenStarted: 2 }));
    expect(total.ok).toBe(false);
    expect(total.gate).toBe("budget");
    expect(total.reason).toContain("maxChildren");
  });

  it("rejections carry the P2 decisionRejection payload shape (attributable, never silent)", () => {
    const result = reValidateDecision(decision({ action: "complete" }), context());
    const payload = {
      decisionId: result.decisionId!,
      reason: result.reason,
      gate: result.gate,
    };
    expect(decisionRejectionSchema.safeParse(payload).success).toBe(true);
  });
});

describe("reValidateDecision — DAG gate (SPEC §11.4 point 2, INV-5)", () => {
  it("an invalid DAG rejects every decision, with the validator's errors verbatim", () => {
    const cyclic = [step("c1", ["c2"]), step("c2", ["c1"]), step("c3")];
    const result = reValidateDecision(decision(DELEGATE), context({ planSteps: cyclic }));
    expect(result.ok).toBe(false);
    expect(result.gate).toBe("dag");
    expect(result.reason).toContain("dependency cycle detected");
    // the coordinator never auto-repairs: the raw cycle error surfaces, no
    // sanitized plan is constructed or returned
    expect(result).not.toHaveProperty("planSteps");
    expect(result.reason).toContain("c1");
  });

  it("dangling task references are rejected (gate: dag)", () => {
    const result = reValidateDecision(decision({ ...DELEGATE, taskIds: ["s2", "s-ghost"] }), context());
    expect(result.ok).toBe(false);
    expect(result.gate).toBe("dag");
    expect(result.reason).toContain("s-ghost");
  });

  it("a self-dependency is caught by validatePlanDag and refused (never silently repaired)", () => {
    const selfDep = [step("d1", ["d1"])];
    const result = reValidateDecision(decision(DELEGATE), context({ planSteps: selfDep }));
    expect(result.ok).toBe(false);
    expect(result.gate).toBe("dag");
    expect(result.reason).toContain("depends on itself");
  });
});

describe("reValidateDecision — attempt budgets (SPEC §11.4 point 4, INV-2)", () => {
  it("retry beyond maxRetriesPerTask is refused (gate: budget)", () => {
    const beyond = reValidateDecision(decision({ action: "retry", retry: { taskId: "s1", attempt: 3 } }), context());
    expect(beyond.ok).toBe(false);
    expect(beyond.gate).toBe("budget");
    expect(beyond.reason).toContain("maxRetriesPerTask");

    const exhausted = reValidateDecision(
      decision({ action: "retry", retry: { taskId: "s1", attempt: 1 } }),
      context({ retriesByTask: { s1: 2 } }),
    );
    expect(exhausted.ok).toBe(false);
    expect(exhausted.gate).toBe("budget");
    expect(exhausted.reason).toContain('"s1"');
  });

  it("replan beyond the mission-wide or per-task bound is refused (gate: budget)", () => {
    const mission = reValidateDecision(
      decision({ action: "replan", replan: { reason: "gate failed", changedNodes: ["s1"] } }),
      context({ replansUsed: 2 }),
    );
    expect(mission.ok).toBe(false);
    expect(mission.reason).toContain("replan budget exhausted");

    const perTask = reValidateDecision(
      decision({ action: "replan", replan: { reason: "gate failed", changedNodes: ["s1"] } }),
      context({ replansUsed: 0, replansUsedByTask: { s1: 1 } }),
    );
    expect(perTask.ok).toBe(false);
    expect(perTask.reason).toContain('"s1"');
  });
});

describe("reValidateDecision — approval routing (SPEC §11.4 point 5, INV-5)", () => {
  it("request_approval is accepted only as a routing directive resolved by a human", () => {
    const result = reValidateDecision(
      decision({
        action: "request_approval",
        approvalRequest: { subject: "open draft PR", riskClass: "GITHUB", description: "publish the branch" },
      }),
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.approvalRouting).toEqual({
      subject: "open draft PR",
      riskClass: "GITHUB",
      description: "publish the branch",
      resolvedBy: "human",
    });
  });

  it("no autonomy profile lets the decision layer resolve an approval itself", () => {
    // the same request under a wider-enabled profile still resolves as human
    const researchish: MissionPolicy = {
      ...POLICY,
      profile: "controlled-autonomous",
    };
    const result = reValidateDecision(
      decision({
        action: "request_approval",
        approvalRequest: { subject: "push", riskClass: "REMOTE", description: "push to origin" },
      }),
      context({ policy: researchish }),
    );
    expect(result.approvalRouting?.resolvedBy).toBe("human");
    // structurally: there is no field through which a decision could arrive
    // pre-approved — resolvedBy is the only resolution marker and is fixed.
    expect(Object.keys(result.approvalRouting!)).toEqual(["subject", "riskClass", "description", "resolvedBy"]);
  });
});

describe("reValidateDecision — completion evidence (SPEC §11.4 point 6, INV-6)", () => {
  it("complete without any verification verdicts is refused", () => {
    const result = reValidateDecision(decision({ action: "complete" }), context());
    expect(result.ok).toBe(false);
    expect(result.gate).toBe("policy");
    expect(result.reason).toContain("no deterministic verification evidence");
  });

  it("complete with a failed gate verdict is refused — a commander claim is not evidence", () => {
    const result = reValidateDecision(
      decision({ action: "complete" }),
      context({
        verificationVerdicts: [
          { gate: "tests", passed: true },
          { gate: "lint", passed: false },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("lint");
  });

  it("complete with all gates passed is accepted", () => {
    const result = reValidateDecision(
      decision({ action: "complete" }),
      context({
        verificationVerdicts: [
          { gate: "tests", passed: true },
          { gate: "lint", passed: true },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("a Kit-bound mission additionally requires journal-verify evidence", () => {
    const kitPolicy: MissionPolicy = { ...POLICY, requireKitWorkflow: true };
    const without = reValidateDecision(
      decision({ action: "complete" }),
      context({ policy: kitPolicy, verificationVerdicts: [{ gate: "tests", passed: true }] }),
    );
    expect(without.ok).toBe(false);
    expect(without.reason).toContain("journal-verify");

    const withJournal = reValidateDecision(
      decision({ action: "complete" }),
      context({
        policy: kitPolicy,
        verificationVerdicts: [{ gate: "tests", passed: true }],
        kitJournalVerified: true,
      }),
    );
    expect(withJournal.ok).toBe(true);
  });
});

describe("decision mirror stays in sync across the planes", () => {
  it("a decision built by the commander plane passes the mission plane's mirror schema", () => {
    const built: CommanderDecision = buildCommanderDecision({
      missionId: "ms_1",
      action: "delegate",
      rationale: "t2 needs a worker",
      taskIds: ["s2"],
      delegation: { goal: "write the regression test", requiredCapabilities: ["code-edit"] },
      basedOnReports: ["tr_1"],
      evidenceRefs: ["artifact:ma_1"],
    });
    const result = reValidateDecision(built as unknown as DecisionCandidate, context());
    // accepted through every gate (not gate: schema) — the mirrors agree
    expect(result.ok).toBe(true);
    expect(result.gate).not.toBe("schema");
  });

  it("a decision rejected by the commander plane's schema is rejected by the mirror too", () => {
    const hostile = decision({ action: "delegate" }); // missing delegation
    expect(commanderDecisionSchema.safeParse(hostile).success).toBe(false);
    expect(reValidateDecision(hostile, context()).gate).toBe("schema");
  });
});
