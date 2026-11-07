/**
 * Activation gate: the single decision of whether a candidate may be switched onto
 * the live runtime.
 *
 * Pure by design. It reads live delivery evidence gathered from GitHub in the
 * current run, never the stored experiment record, so a rewritten local record
 * cannot authorise an activation on its own.
 *
 * Fail closed: every shape that is not an affirmative, consistent proof of the
 * full chain (opt-in, delivery, approval, CI, verified merge, matching content)
 * is refused, and the first broken link is reported.
 */

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && FULL_COMMIT_SHA.test(value);
}

/**
 * Typed result of the merge call. Only "merged" carries a commit, and even that
 * is not trusted until verifyMergedPull() confirms it against GitHub.
 */
export type MergeOutcome =
  | { status: "merged"; mergeCommitSha: string }
  /** A definitive refusal: 405 not mergeable, 409 head moved, 422 invalid. */
  | { status: "rejected"; httpStatus: number; reason: string }
  /** Transport failure, unexpected status, or a body that does not confirm a merge. */
  | { status: "uncertain"; reason: string };

/**
 * Independent confirmation of a merge, read back from GitHub after the merge call.
 * It names the merge and candidate commits it checked, so a verification cannot be
 * spliced onto evidence for a different merge or candidate.
 */
export interface MergeVerification {
  /** The merge commit that was read back and checked. */
  mergeCommitSha: string;
  /** The candidate commit whose file contents were compared against the merge. */
  candidateCommit: string;
  /** The pull is merged and its head is the SHA that was reviewed and CI-checked. */
  mergedFromReviewedHead: boolean;
  /** The pull's merge_commit_sha equals the sha the merge call returned. */
  mergeCommitMatches: boolean;
  /** The merge commit carries the candidate's file contents (path, status and blob sha). */
  contentMatches: boolean;
  reason?: string;
}

export interface ActivationEvidence {
  /** --activate-runtime was passed explicitly. */
  explicitOptIn: boolean;
  /** GitHub delivery ran (--github). */
  githubDelivery: boolean;
  /** The commit the candidate artifact records. */
  candidateCommit: string;
  /** Latest review verdict for the head sha; null when no review was read. */
  review: { headSha: string; approved: boolean } | null;
  /** CI verdict for the head sha; null when CI was not read. */
  ci: { headSha: string; passed: boolean | null } | null;
  /** Result of the merge call; null when no merge was attempted. */
  merge: MergeOutcome | null;
  /** Read-back verification of the merge; null when it was not performed. */
  verification: MergeVerification | null;
}

/** The GitHub-observed facts a delivery produces. The activation gate adds the operator's opt-in. */
export type DeliveryFacts = Pick<ActivationEvidence, "candidateCommit" | "review" | "ci" | "merge" | "verification">;

export type ActivationDecision = { ok: true; mergeCommitSha: string } | { ok: false; reason: string };

/**
 * Merging is not automatic. A human merges the PR in GitHub until branch
 * protection enforces review, so this default stays false. Enabling it is an
 * explicit, separate decision.
 */
export const DEFAULT_MERGE_ON_ACCEPT = false;

/** Resolves the delivery policy for one run. Pure, so the defaults are testable. */
export function resolveDeliveryPolicy(opts: { autoAccept?: boolean; mergeOnAccept?: boolean }): {
  autoAccept: boolean;
  mergeOnAccept: boolean;
} {
  return {
    autoAccept: opts.autoAccept ?? true,
    mergeOnAccept: opts.mergeOnAccept ?? DEFAULT_MERGE_ON_ACCEPT,
  };
}

const refuse = (reason: string): ActivationDecision => ({ ok: false, reason });

export function decideActivation(evidence: ActivationEvidence): ActivationDecision {
  if (!evidence.explicitOptIn) {
    return refuse("runtime activation was not explicitly requested (--activate-runtime)");
  }
  if (!evidence.githubDelivery) {
    return refuse("no GitHub delivery: nothing was reviewed, merged or verified");
  }
  if (!isCommitSha(evidence.candidateCommit)) {
    return refuse("candidate commit is not a full commit sha");
  }

  const review = evidence.review;
  if (!review) return refuse("no review verdict was read");
  if (!review.approved) return refuse("review is not approved");
  if (review.headSha !== evidence.candidateCommit) {
    return refuse("review approval is for a different commit (stale)");
  }

  const ci = evidence.ci;
  if (!ci) return refuse("no CI verdict was read");
  if (ci.passed === false) return refuse("CI failed");
  if (ci.passed !== true) return refuse("CI has not passed");
  if (ci.headSha !== evidence.candidateCommit) {
    return refuse("CI result is for a different commit (stale)");
  }

  const merge = evidence.merge;
  if (!merge) return refuse("the candidate was not merged");
  if (merge.status !== "merged") return refuse(`merge not confirmed: ${merge.reason}`);
  if (!isCommitSha(merge.mergeCommitSha)) return refuse("merge commit sha is not a full commit sha");

  const verification = evidence.verification;
  if (!verification) return refuse("merge was not verified against GitHub");
  if (verification.mergeCommitSha !== merge.mergeCommitSha) {
    return refuse("verification is for a different merge commit");
  }
  if (verification.candidateCommit !== evidence.candidateCommit) {
    return refuse("verification is for a different candidate commit");
  }
  if (!verification.mergedFromReviewedHead) {
    return refuse("the pull is not merged from the reviewed head");
  }
  if (!verification.mergeCommitMatches) {
    return refuse("merge commit differs from the one GitHub reports");
  }
  if (!verification.contentMatches) {
    return refuse("merged content does not match the candidate");
  }

  return { ok: true, mergeCommitSha: merge.mergeCommitSha };
}
