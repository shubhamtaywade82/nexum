import {
  decideActivation,
  type ActivationEvidence,
  type MergeVerification,
} from "../../src/evolution/delivery/activation-gate.js";

/**
 * The activation gate is the only decision that may switch the live runtime.
 * Every case here is an adversarial shape of evidence. Each must fail closed.
 */

const CANDIDATE = "a".repeat(40);
const MERGE = "b".repeat(40);
const OTHER = "c".repeat(40);

function verified(over: Partial<MergeVerification> = {}): MergeVerification {
  return {
    mergeCommitSha: MERGE,
    candidateCommit: CANDIDATE,
    mergedFromReviewedHead: true,
    mergeCommitMatches: true,
    contentMatches: true,
    ...over,
  };
}

function complete(over: Partial<ActivationEvidence> = {}): ActivationEvidence {
  return {
    explicitOptIn: true,
    githubDelivery: true,
    candidateCommit: CANDIDATE,
    review: { headSha: CANDIDATE, approved: true },
    ci: { headSha: CANDIDATE, passed: true },
    merge: { status: "merged", mergeCommitSha: MERGE },
    verification: verified(),
    ...over,
  };
}

describe("decideActivation: the complete chain", () => {
  it("activates the merge commit when every link is proven for the candidate commit", () => {
    expect(decideActivation(complete())).toEqual({ ok: true, mergeCommitSha: MERGE });
  });
});

describe("decideActivation fails closed on every broken link", () => {
  const cases: Array<[string, Partial<ActivationEvidence>, RegExp]> = [
    ["no explicit opt-in", { explicitOptIn: false }, /explicitly requested/],
    ["no GitHub delivery (--mutate without --github)", { githubDelivery: false }, /no GitHub delivery/],
    ["candidate commit is not a full sha", { candidateCommit: "main" }, /full commit sha/],
    ["review never read", { review: null }, /no review verdict/],
    ["review not approved", { review: { headSha: CANDIDATE, approved: false } }, /not approved/],
    ["approval of an older commit", { review: { headSha: OTHER, approved: true } }, /stale/],
    ["CI never read", { ci: null }, /no CI verdict/],
    ["CI failed", { ci: { headSha: CANDIDATE, passed: false } }, /CI failed/],
    ["CI still pending (timeout)", { ci: { headSha: CANDIDATE, passed: null } }, /has not passed/],
    ["CI result for another commit", { ci: { headSha: OTHER, passed: true } }, /stale/],
    ["merge never attempted", { merge: null }, /not merged/],
    [
      "merge rejected: 405 not mergeable",
      { merge: { status: "rejected", httpStatus: 405, reason: "not mergeable" } },
      /merge not confirmed/,
    ],
    [
      "merge rejected: 409 head moved",
      { merge: { status: "rejected", httpStatus: 409, reason: "head moved" } },
      /merge not confirmed/,
    ],
    [
      "merge rejected: 422 invalid",
      { merge: { status: "rejected", httpStatus: 422, reason: "invalid" } },
      /merge not confirmed/,
    ],
    ["merge outcome ambiguous", { merge: { status: "uncertain", reason: "socket hang up" } }, /merge not confirmed/],
    ["merged status with a malformed sha", { merge: { status: "merged", mergeCommitSha: "xyz" } }, /merge commit sha/],
    ["merge never verified against GitHub", { verification: null }, /not verified/],
    [
      "GitHub reports the pull is not merged from the reviewed head",
      { verification: verified({ mergedFromReviewedHead: false }) },
      /not merged/,
    ],
    [
      "merge commit differs from the one GitHub reports",
      { verification: verified({ mergeCommitMatches: false }) },
      /merge commit/,
    ],
    ["merged content differs from the candidate", { verification: verified({ contentMatches: false }) }, /content/],
    [
      "verification spliced from a different merge commit",
      { verification: verified({ mergeCommitSha: OTHER }) },
      /different merge commit/,
    ],
    [
      "verification spliced from a different candidate",
      { verification: verified({ candidateCommit: OTHER }) },
      /different candidate commit/,
    ],
  ];

  it.each(cases)("%s", (_name, override, reason) => {
    const decision = decideActivation(complete(override));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(reason);
  });

  it("refuses evidence where an unverified merge would otherwise have passed every other check", () => {
    // Everything except the verification is valid: the gate still refuses.
    const decision = decideActivation(complete({ verification: null }));
    expect(decision.ok).toBe(false);
  });
});
