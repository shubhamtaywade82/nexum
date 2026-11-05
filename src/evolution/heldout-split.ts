import { createHash } from "node:crypto";

/**
 * The held-out split of the benchmark suite.
 *
 * A case is held out by a hash of its id, not by its category: a category label
 * is a property the mutation agent can see and sometimes choose, so it cannot
 * mark an independent test set. The version string is part of the hash input,
 * so reassigning cases means bumping it, and the campaign records the version it
 * used.
 *
 * Held-out results are reported, never decided on. The selector, the acceptance
 * gate and the mutation planner read only development results.
 */
export const HELD_OUT_SPLIT_VERSION = "heldout-split-v1";

/** One case in five is held out. */
const HELD_OUT_MODULUS = 5;

export function isHeldOutCase(caseId: string): boolean {
  const digest = createHash("sha256").update(`${HELD_OUT_SPLIT_VERSION}:${caseId}`).digest();
  return digest[0] % HELD_OUT_MODULUS === 0;
}

/** Digest of the split as applied to a suite, recorded so a report can show which assignment it used. */
export function heldOutSplitDigest(caseIds: readonly string[]): string {
  const assignments = [...new Set(caseIds)]
    .sort()
    .map((id) => `${id}=${isHeldOutCase(id) ? "held_out" : "development"}`)
    .join("\n");
  return createHash("sha256").update(`${HELD_OUT_SPLIT_VERSION}\n${assignments}`).digest("hex");
}
