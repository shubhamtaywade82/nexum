import { HarnessRegistry } from "../../src/evolution/registry.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { ActivationMonitor } from "../../src/evolution/monitoring/activation-monitor.js";
import type { ActivationEvidence } from "../../src/evolution/delivery/activation-gate.js";
import { resolveDeliveryPolicy } from "../../src/evolution/delivery/activation-gate.js";
import type { RuntimeActivationController } from "../../src/evolution/monitoring/runtime-activation.js";

/**
 * Activation authority, end to end through the engine. Each adversarial case must
 * leave the live runtime exactly where it was. The positive case proves the switch
 * is pinned to the verified merge commit and nothing else.
 */

const PARENT = "1".repeat(40);
const CANDIDATE = "2".repeat(40);
const MERGE = "3".repeat(40);
const OTHER = "4".repeat(40);

class PinnedRuntime implements RuntimeActivationController {
  readonly name = "pinned-runtime";
  active = "H0";
  switches: Array<{ harnessId: string; pinned?: string }> = [];
  failNext = false;
  activeHarness(): string {
    return this.active;
  }
  async switchTo(harnessId: string, pinned?: string): Promise<void> {
    if (this.failNext) throw new Error("runtime refused the switch");
    this.switches.push({ harnessId, pinned });
    this.active = harnessId;
  }
  async harnessHealth(): Promise<boolean> {
    return true;
  }
  async freeze(): Promise<void> {}
}

function completeEvidence(over: Partial<ActivationEvidence> = {}): ActivationEvidence {
  return {
    explicitOptIn: true,
    githubDelivery: true,
    candidateCommit: CANDIDATE,
    review: { headSha: CANDIDATE, approved: true },
    ci: { headSha: CANDIDATE, passed: true },
    merge: { status: "merged", mergeCommitSha: MERGE },
    verification: {
      mergeCommitSha: MERGE,
      candidateCommit: CANDIDATE,
      mergedFromReviewedHead: true,
      mergeCommitMatches: true,
      contentMatches: true,
    },
    ...over,
  };
}

describe("activation authority (engine)", () => {
  let registry: HarnessRegistry;
  let runtime: PinnedRuntime;
  let engine: ClosedLoopEngine;

  beforeEach(() => {
    registry = new HarnessRegistry(":memory:");
    runtime = new PinnedRuntime();
    engine = new ClosedLoopEngine({
      registry,
      monitor: new ActivationMonitor({ minSampleSize: 10 }),
      runtimeActivation: runtime,
      executorModels: ["qwen"],
    });
    registry.saveVersion({
      id: "H0",
      commitSha: PARENT,
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.6, verificationPassRate: 0.8 },
        reliability: { toolErrorRate: 0.2, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.5, transferScore: 0.5 },
      },
      status: "promoted",
    });
    engine.experiments.startExperiment({
      id: "exp-auth-1",
      parentHarness: "H0",
      parentCommit: PARENT,
      candidateHarness: "H1",
      candidateCommit: CANDIDATE,
      targetId: "t1",
      targetCapability: "tool_utilization",
      desiredOutcome: "fewer tool errors",
      hypothesisId: "hyp-1",
      hypothesisStatement: "prune schemas",
      predictedEffect: "reliability +10%",
      executorPrimary: "qwen",
      executorTransfer: [],
    });
    for (const s of ["EVALUATING", "VALIDATED", "GENERALIZED", "ELIGIBLE", "DELIVERED"] as const) {
      engine.experiments.advance("exp-auth-1", s);
    }
    engine.reportCi("exp-auth-1", true);
    engine.reportReview("exp-auth-1", true, "maintainer");
  });

  afterEach(() => {
    registry.close();
  });

  it("switches the runtime onto the verified merge commit, and only after a verified merge", async () => {
    expect(engine.acceptApprovedCandidate("exp-auth-1")).toBe(true);
    expect(engine.experiments.machine("exp-auth-1").current()).toBe("ACCEPTED");
    expect(engine.promoteMergedCandidate("exp-auth-1", MERGE)).toBe(true);
    expect(engine.experiments.machine("exp-auth-1").current()).toBe("ACTIVE");

    const result = await engine.activateOnRuntime("exp-auth-1", completeEvidence());

    expect(result).toEqual({ ok: true, commitSha: MERGE });
    expect(runtime.switches).toEqual([{ harnessId: "H1", pinned: MERGE }]);
  });

  it("a candidate finalized locally (ACTIVE, no merge) is never activated, even with complete-looking evidence", async () => {
    expect(engine.finalizeAcceptance("exp-auth-1")).toBe(true);

    const result = await engine.activateOnRuntime("exp-auth-1", completeEvidence());

    expect(result.ok).toBe(false);
    expect(runtime.switches).toEqual([]);
    expect(runtime.active).toBe("H0");
  });

  it("an accepted but unmerged candidate is not ACTIVE and is not activated", async () => {
    engine.acceptApprovedCandidate("exp-auth-1");

    const result = await engine.activateOnRuntime("exp-auth-1", completeEvidence());

    expect(result).toEqual({ ok: false, reason: "experiment is not ACTIVE" });
    expect(runtime.switches).toEqual([]);
  });

  it("refuses to promote on a merge commit that is not a full sha", () => {
    engine.acceptApprovedCandidate("exp-auth-1");
    expect(engine.promoteMergedCandidate("exp-auth-1", "main")).toBe(false);
    expect(engine.experiments.machine("exp-auth-1").current()).toBe("ACCEPTED");
  });

  it("refuses to promote an experiment that is not ACCEPTED (an approval alone is not a merge)", () => {
    expect(engine.experiments.machine("exp-auth-1").current()).toBe("APPROVED");
    expect(engine.promoteMergedCandidate("exp-auth-1", MERGE)).toBe(false);
    expect(engine.experiments.machine("exp-auth-1").current()).toBe("APPROVED");
  });

  it("refuses evidence whose merge commit differs from the one recorded on promotion", async () => {
    engine.acceptApprovedCandidate("exp-auth-1");
    engine.promoteMergedCandidate("exp-auth-1", MERGE);

    const result = await engine.activateOnRuntime(
      "exp-auth-1",
      completeEvidence({ merge: { status: "merged", mergeCommitSha: OTHER } }),
    );

    expect(result.ok).toBe(false);
    expect(runtime.switches).toEqual([]);
  });

  it("refuses evidence for a different candidate commit, even when the evidence is internally consistent", async () => {
    engine.acceptApprovedCandidate("exp-auth-1");
    engine.promoteMergedCandidate("exp-auth-1", MERGE);

    const result = await engine.activateOnRuntime(
      "exp-auth-1",
      completeEvidence({
        candidateCommit: OTHER,
        review: { headSha: OTHER, approved: true },
        ci: { headSha: OTHER, passed: true },
        verification: {
          mergeCommitSha: MERGE,
          candidateCommit: OTHER,
          mergedFromReviewedHead: true,
          mergeCommitMatches: true,
          contentMatches: true,
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "evidence is for a different candidate commit" });
    expect(runtime.switches).toEqual([]);
  });

  it("refuses when called without evidence (a JavaScript caller cannot fall through into a switch)", async () => {
    engine.acceptApprovedCandidate("exp-auth-1");
    engine.promoteMergedCandidate("exp-auth-1", MERGE);

    const result = await engine.activateOnRuntime("exp-auth-1", undefined as unknown as ActivationEvidence);

    expect(result.ok).toBe(false);
    expect(runtime.switches).toEqual([]);
  });

  it.each([
    ["no explicit opt-in", { explicitOptIn: false }],
    ["no GitHub delivery", { githubDelivery: false }],
    ["review approved for a stale commit", { review: { headSha: OTHER, approved: true } }],
    ["CI still pending", { ci: { headSha: CANDIDATE, passed: null } }],
    ["merge rejected", { merge: { status: "rejected" as const, httpStatus: 405, reason: "not mergeable" } }],
    ["merge ambiguous", { merge: { status: "uncertain" as const, reason: "timeout" } }],
    ["merge not verified", { verification: null }],
  ])("refuses activation with %s and leaves the runtime untouched", async (_name, override) => {
    engine.acceptApprovedCandidate("exp-auth-1");
    engine.promoteMergedCandidate("exp-auth-1", MERGE);

    const result = await engine.activateOnRuntime(
      "exp-auth-1",
      completeEvidence(override as Partial<ActivationEvidence>),
    );

    expect(result.ok).toBe(false);
    expect(runtime.switches).toEqual([]);
  });

  it("reports a runtime refusal as a thrown error, so the caller can roll back", async () => {
    engine.acceptApprovedCandidate("exp-auth-1");
    engine.promoteMergedCandidate("exp-auth-1", MERGE);
    runtime.failNext = true;

    await expect(engine.activateOnRuntime("exp-auth-1", completeEvidence())).rejects.toThrow("runtime refused");
    expect(runtime.active).toBe("H0");
  });

  it("refuses when no runtime controller is wired", async () => {
    const bare = new ClosedLoopEngine({
      registry,
      monitor: new ActivationMonitor({ minSampleSize: 10 }),
      executorModels: ["qwen"],
    });
    const result = await bare.activateOnRuntime("exp-auth-1", completeEvidence());
    expect(result.ok).toBe(false);
  });
});

describe("delivery policy defaults", () => {
  it("never merges automatically unless explicitly enabled", () => {
    expect(resolveDeliveryPolicy({})).toEqual({ autoAccept: true, mergeOnAccept: false });
    expect(resolveDeliveryPolicy({ mergeOnAccept: true }).mergeOnAccept).toBe(true);
  });
});
