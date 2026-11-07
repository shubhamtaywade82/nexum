import { activateRuntimeIfNeeded } from "../../src/evolution/cli.js";
import type { ActivationEvidence } from "../../src/evolution/delivery/activation-gate.js";

/**
 * The CLI's activation helper composes the evidence the engine decides on, and
 * it confirms the runtime landed on the verified merge commit. These tests use
 * stubs for the engine and runtime, and check only the helper's own contract.
 */

const CANDIDATE = "a".repeat(40);
const MERGE = "b".repeat(40);
const OTHER = "c".repeat(40);

type Outcome = Parameters<typeof activateRuntimeIfNeeded>[3];

function cycleOutcome(github: boolean): Outcome {
  const base = {
    ok: true as const,
    outcome: { experiment: { candidate: { harness: "H1", commit: CANDIDATE } } },
    mutation: {},
  };
  if (!github) return base as unknown as Outcome;
  return {
    ...base,
    github: {
      handle: { branch: "evolution/h1", headSha: CANDIDATE, prNumber: 42, prUrl: "u" },
      ci: { passed: true, failedRuns: [], pending: false, runs: [] },
      review: { state: "approved" },
      accepted: true,
      merge: { status: "merged", mergeCommitSha: MERGE },
      verification: { mergedFromReviewedHead: true, mergeCommitMatches: true, contentMatches: true },
      merged: true,
      facts: {
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
      },
    },
  } as unknown as Outcome;
}

function controllerReporting(pointerCommit: string | null, active = "H1") {
  return {
    name: "stub-runtime",
    activeHarness: () => active,
    readPointer: () => (pointerCommit === null ? null : { id: "H1", commitSha: pointerCommit, activatedAt: 1 }),
  };
}

describe("activateRuntimeIfNeeded (CLI composition)", () => {
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  it("respects the explicit per-run activation opt-out", async () => {
    const activateOnRuntime = jest.fn(async () => ({ ok: true as const, commitSha: MERGE }));
    const result = await activateRuntimeIfNeeded(
      { activateOnRuntime },
      controllerReporting(MERGE),
      "exp-1",
      cycleOutcome(true),
      false,
    );
    expect(activateOnRuntime).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/);
  });

  it("without --github, passes githubDelivery:false and no facts, so the gate refuses", async () => {
    let seen: ActivationEvidence | undefined;
    const activateOnRuntime = jest.fn(async (_id: string, evidence: ActivationEvidence) => {
      seen = evidence;
      return { ok: false as const, reason: "no GitHub delivery: nothing was reviewed, merged or verified" };
    });
    const result = await activateRuntimeIfNeeded(
      { activateOnRuntime },
      controllerReporting(null),
      "exp-1",
      cycleOutcome(false),
      true,
    );
    expect(seen).toMatchObject({
      activationEnabled: true,
      githubDelivery: false,
      candidateCommit: CANDIDATE,
      review: null,
      ci: null,
      merge: null,
      verification: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no GitHub delivery/);
  });

  it("passes the GitHub facts through unchanged and records the verified merge commit", async () => {
    let seen: ActivationEvidence | undefined;
    const activateOnRuntime = jest.fn(async (_id: string, evidence: ActivationEvidence) => {
      seen = evidence;
      return { ok: true as const, commitSha: MERGE };
    });
    const result = await activateRuntimeIfNeeded(
      { activateOnRuntime },
      controllerReporting(MERGE),
      "exp-1",
      cycleOutcome(true),
      true,
    );
    expect(seen).toMatchObject({
      activationEnabled: true,
      githubDelivery: true,
      candidateCommit: CANDIDATE,
      review: { headSha: CANDIDATE, approved: true },
      ci: { headSha: CANDIDATE, passed: true },
      merge: { status: "merged", mergeCommitSha: MERGE },
    });
    expect(result).toMatchObject({ ok: true, commitSha: MERGE, harnessId: "H1" });
  });

  it("fails closed when the runtime pointer does not match the verified merge commit", async () => {
    const activateOnRuntime = jest.fn(async () => ({ ok: true as const, commitSha: MERGE }));
    const result = await activateRuntimeIfNeeded(
      { activateOnRuntime },
      controllerReporting(OTHER),
      "exp-1",
      cycleOutcome(true),
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match the verified merge commit/);
  });

  it("records a thrown runtime refusal as a failure instead of propagating it", async () => {
    const activateOnRuntime = jest.fn(async () => {
      throw new Error("runtime refused the switch");
    });
    const result = await activateRuntimeIfNeeded(
      { activateOnRuntime },
      controllerReporting(null),
      "exp-1",
      cycleOutcome(true),
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("runtime refused the switch");
  });
});
