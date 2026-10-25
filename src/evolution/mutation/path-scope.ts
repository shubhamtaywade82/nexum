/**
 * Segment-aware path-prefix containment for mutation-scope enforcement.
 *
 * v2.3.1: every layer of the scope pipeline (runtime proposal checks, strategy
 * attribution, executor planned/actual audits) previously used plain
 * `startsWith(prefix)`, which admits sibling directories: allowed prefix
 * `src/evolution` would admit `src/evolution2/foo.ts`. The executor's
 * actual-diff audit was still the backstop, but the invariant is now explicit
 * at every layer instead of relying on the final defense.
 */

import { posix } from "node:path";

/**
 * True when `path` is `prefix` itself or lives strictly underneath it at a
 * path-segment boundary:
 *
 *   allowed: src/evolution
 *     src/evolution/foo.ts  → true
 *     src/evolution         → true (exact)
 *     src/evolution2/x.ts   → false (sibling, not contained)
 *     src/evolutionfoo.ts   → false (file-name overlap, not contained)
 */
export function pathWithinAllowedPrefix(path: string, prefix: string): boolean {
  if (!path || !prefix) return false;
  if (path === prefix) return true;
  const boundary = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(boundary);
}

/**
 * Paths a mutation may never read or edit: the evaluator and the benchmark suite.
 *
 * src/evolution holds the engine, selector, generalization gate and held-out
 * split; src/benchmark holds every benchmark case, development and held-out
 * alike. A candidate that can read them can fit the test set, and one that can
 * edit them judges its own successors, since an accepted candidate becomes the
 * next parent. The evaluator must stay fixed across a lineage, so no scope or
 * configuration can widen past this list.
 */
export const PROTECTED_EVALUATION_PATHS: readonly string[] = ["src/evolution/", "src/benchmark/"];

/** A violation message when `path` is evaluation code, otherwise null. Case-insensitive, for case-insensitive filesystems. */
export function protectedEvaluationPath(path: string): string | null {
  const normalized = posix.normalize(path.split("\\").join("/")).replace(/^\.\//, "");
  const lowered = normalized.toLowerCase();
  const hit = PROTECTED_EVALUATION_PATHS.find((prefix) => pathWithinAllowedPrefix(lowered, prefix));
  return hit
    ? `"${normalized}" is evaluation code (${hit}); a mutation may not read or change the evaluator or the benchmark suite`
    : null;
}

/**
 * The scope-violation verdict shared by EVERY runtime that turns model output
 * into proposed edits — legacy (NexumEngineeringAgentRuntime) and kernel
 * (KernelEvolutionAgentRuntime) alike. Single source so the queue-time check
 * and the fail-closed re-audit can never drift apart:
 *
 *   null  → path is a legal relative repo path under an allowed prefix
 *   string → human-readable violation (also fed back to the model)
 */
export function mutationScopeViolation(path: string, allowedPaths: readonly string[]): string | null {
  const normalized = path.split("\\").join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    return "path must be a relative repo path without traversal";
  }
  const protectedPath = protectedEvaluationPath(normalized);
  if (protectedPath) return protectedPath;
  if (!allowedPaths.some((prefix) => pathWithinAllowedPrefix(normalized, prefix))) {
    return `not under any allowed prefix (${allowedPaths.join(", ")})`;
  }
  return null;
}
