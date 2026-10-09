/**
 * Verification gate — the only path from `running` to `completed`.
 *
 *   model proposes "done"
 *        │
 *        ▼
 *   VerifierService.verify(answer)   deterministic checks (exit codes, files, content)
 *        │
 *   pass ├──► running → completed
 *   fail └──► running → failed  (retryable: failed → queued)   or  → blocked
 *
 * A model's claim that work succeeded is never itself a state transition.
 * The gate refuses to run for a task that is not `running`, so a late or
 * duplicated completion event cannot re-verify (and re-complete) a task
 * that already moved on — mirroring applyTaskTransition's idempotency.
 */

import type { Task, TaskStatus } from "./types.js";
import { applyTaskTransition } from "./task-machine.js";
import type { VerificationReport, VerifierService } from "./critic/verifier.js";

export type GateOutcome = "completed" | "failed" | "blocked" | "skipped";

export interface GateResult {
  tasks: Task[];
  outcome: GateOutcome;
  /** Present whenever checks actually ran. */
  report?: VerificationReport;
  reason: string;
}

export interface GateOptions {
  /** Status for a failed verification: `failed` (retryable) or `blocked` (needs input). Default `failed`. */
  onFailure?: Extract<TaskStatus, "failed" | "blocked">;
  /** Refuse to complete when no checks are registered (default true — an empty contract proves nothing). */
  requireChecks?: boolean;
}

export async function gateTaskCompletion(
  tasks: Task[],
  taskId: string,
  verifier: VerifierService,
  answer: string,
  options: GateOptions = {},
): Promise<GateResult> {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return { tasks, outcome: "skipped", reason: `unknown task "${taskId}"` };
  if (task.status !== "running") {
    return { tasks, outcome: "skipped", reason: `task "${taskId}" is ${task.status}, not running` };
  }

  const onFailure = options.onFailure ?? "failed";
  if ((options.requireChecks ?? true) && verifier.ids().length === 0) {
    return {
      tasks: applyTaskTransition(tasks, taskId, onFailure),
      outcome: onFailure,
      reason: "no verification checks registered",
    };
  }

  const report = await verifier.verify(answer);
  if (report.pass) {
    return {
      tasks: applyTaskTransition(tasks, taskId, "completed", 1),
      outcome: "completed",
      report,
      reason: `${report.results.length} check(s) passed`,
    };
  }

  const failed = report.results.filter((r) => !r.pass);
  return {
    tasks: applyTaskTransition(tasks, taskId, onFailure),
    outcome: onFailure,
    report,
    reason: failed.map((r) => `${r.checkId}${r.detail ? `: ${r.detail}` : ""}`).join("; "),
  };
}
