import type { WorkflowRun } from "./types.js";

const PASSING = new Set(["success", "skipped", "neutral"]);
const FAILING = new Set(["failure", "timed_out"]);

export type CheckVerdict =
  | { verdict: "pending" }
  | { verdict: "indeterminate" }
  | { verdict: "green" }
  | { verdict: "failing"; run: WorkflowRun };

/**
 * Keeps only the latest attempt of each (workflow, event) pair, so a re-run that
 * passed does not count as a failure.
 */
export function latestPerWorkflow(runs: readonly WorkflowRun[]): WorkflowRun[] {
  const groups = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = `${run.workflowName}\u0000${run.event}`;
    const current = groups.get(key);
    if (!current || isNewer(run, current)) groups.set(key, run);
  }
  return [...groups.values()];
}

function isNewer(candidate: WorkflowRun, current: WorkflowRun): boolean {
  if (candidate.attempt !== current.attempt) return candidate.attempt > current.attempt;
  return candidate.createdAt > current.createdAt;
}

/**
 * Verdict for the runs on one PR head. Pending means wait. Indeterminate means a
 * conclusion the healer does not recognise (cancelled, startup_failure, …), so it
 * neither heals nor claims green.
 */
export function deriveChecks(runsOnHead: readonly WorkflowRun[]): CheckVerdict {
  const latest = latestPerWorkflow(runsOnHead);
  if (latest.length === 0 || latest.some((run) => run.status !== "completed")) return { verdict: "pending" };
  const failing = latest.find((run) => FAILING.has(run.conclusion));
  if (failing) return { verdict: "failing", run: failing };
  if (!latest.every((run) => PASSING.has(run.conclusion))) return { verdict: "indeterminate" };
  return { verdict: "green" };
}
