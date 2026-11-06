/**
 * TaskValidator — runtime checks that go beyond schema validation.
 *
 * Schema validation lives in task-loader.ts (zod). This module enforces the
 * anti-rules from policies.yml that depend on cross-task or cross-run state:
 *   - no duplicate experiments for the same hypothesis
 *   - no re-diagnosis without new evidence
 *   - no self-evaluation (implementation agent may not be the evaluator)
 *
 * Architecture: docs/evolution/architecture.md
 * Policy:       docs/evolution/evolution-policy.md §4
 */

import { createHash } from "node:crypto";
import { BacklogEntry, TaskDefinition } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  /** Machine-readable reason code, suitable for logging. */
  code:
    | "ok"
    | "duplicate_hypothesis"
    | "no_new_evidence"
    | "self_evaluation_forbidden"
    | "dependency_not_investigated"
    | "schema_version_mismatch";
  /** Human-readable explanation. */
  message: string;
}

export interface ValidationContext {
  /**
   * Hashes of hypotheses already evaluated for this task. The runner
   * maintains this set; a new hypothesis whose hash collides with an existing
   * one is rejected. Re-formulating the hypothesis text to dodge the check is
   * itself a validation failure (the hash is content-based, not text-based:
   * whitespace and case are normalized before hashing).
   */
  knownHypothesisHashes: Set<string>;
  /** The hypothesis text being proposed for this run. */
  proposedHypothesis: string;
  /** Current backlog entry for the task, or null if never evaluated. */
  backlog: BacklogEntry | null;
  /** Current HEAD commit of the repository. */
  currentCommit: string;
  /** Number of new evidence items since the last report. */
  newEvidenceCount: number;
  /** Whether the candidate evaluator would be the same agent that produced the candidate. */
  evaluatorIsImplementer: boolean;
}

/**
 * Validates that a task may be run now under the proposed hypothesis.
 * Returns `ok: false` with a code if the anti-rules block the run.
 */
export function validateTaskRun(task: TaskDefinition, ctx: ValidationContext): ValidationResult {
  // Anti-rule: no duplicate experiments for the same hypothesis.
  const h = normalizeHypothesis(ctx.proposedHypothesis);
  const hash = sha256(h);
  if (ctx.knownHypothesisHashes.has(hash)) {
    return {
      ok: false,
      code: "duplicate_hypothesis",
      message: `A hypothesis with the same normalized content already exists for ${task.id}. Re-formulating the text to dodge this check is itself a validation error.`,
    };
  }

  // Anti-rule: no re-diagnosis without new evidence or code change.
  if (ctx.backlog) {
    const sameCommit = ctx.backlog.lastEvaluatedCommit === ctx.currentCommit;
    const noNewEvidence = ctx.newEvidenceCount <= 0;
    if (sameCommit && noNewEvidence) {
      return {
        ok: false,
        code: "no_new_evidence",
        message: `Task ${task.id} was last evaluated at ${ctx.backlog.lastEvaluatedCommit} with no new evidence. Re-diagnosis is blocked until either HEAD advances or new evidence arrives.`,
      };
    }
  }

  // Anti-rule: no self-evaluation. The evaluator must be on a different code
  // path from the proposing agent. (This is structural — the runner wires it —
  // but we re-check here so a future refactor cannot silently bypass it.)
  if (task.execution.mode === "implement" && ctx.evaluatorIsImplementer) {
    return {
      ok: false,
      code: "self_evaluation_forbidden",
      message: `Task ${task.id} is in implement mode and the proposed evaluator is the same agent that produced the candidate. The evaluator must be the FixedExecutor + TwoStageSelector pair on a separate code path.`,
    };
  }

  return { ok: true, code: "ok", message: "" };
}

/**
 * Normalizes a hypothesis text for hashing: trims, lowercases, collapses
 * whitespace. This makes "Fix the bug" and "fix  the   BUG" hash to the same
 * value, so trivial rewording does not dodge the duplicate check.
 */
export function normalizeHypothesis(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** SHA-256 hex of a string. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Computes the hypothesis hash that would be used for the given text. The
 * runner uses this to record the hash before evaluation so a duplicate can be
 * detected on the next attempt.
 */
export function hypothesisHash(text: string): string {
  return sha256(normalizeHypothesis(text));
}
