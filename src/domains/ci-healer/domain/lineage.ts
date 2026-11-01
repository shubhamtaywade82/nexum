/**
 * Lineage state machine, keyed by heal branch. Pure: no I/O.
 *
 *   HEALING ──► PR_OPEN ◄──► GREEN
 *   PR_OPEN ──► EXHAUSTED ──► GREEN
 *   PR_OPEN | GREEN | EXHAUSTED ──► CLOSED   (PR merged or closed; terminal)
 *
 * HEALING is set before a side effect. Crash recovery resumes it as PR_OPEN, with
 * the attempt already counted, so a crash never grants an extra attempt.
 */

export const LINEAGE_STATES = ["HEALING", "PR_OPEN", "GREEN", "EXHAUSTED", "CLOSED"] as const;
export type LineageState = (typeof LINEAGE_STATES)[number];

export const ACTIVE_STATES: readonly LineageState[] = ["HEALING", "PR_OPEN", "GREEN", "EXHAUSTED"];

const TRANSITIONS: Readonly<Record<LineageState, readonly LineageState[]>> = {
  HEALING: ["PR_OPEN", "CLOSED"],
  PR_OPEN: ["HEALING", "GREEN", "EXHAUSTED", "CLOSED"],
  GREEN: ["HEALING", "PR_OPEN", "EXHAUSTED", "CLOSED"],
  EXHAUSTED: ["GREEN", "CLOSED"],
  CLOSED: [],
};

export class IllegalTransitionError extends Error {}

/** Same-state moves are allowed as attribute updates. */
export function canTransition(from: LineageState, to: LineageState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(healBranch: string, from: LineageState, to: LineageState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(`illegal transition ${from} -> ${to} for ${healBranch}`);
  }
}

/** Per-head outcome, recorded so the same failing commit is never retried. */
export const HEAD_OUTCOMES = ["HEALING", "PR_OPEN", "NO_PATCH", "ERRORED"] as const;
export type HeadOutcome = (typeof HEAD_OUTCOMES)[number];

/** Attempts are counted in total, including the initial heal. */
export function attemptsExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
