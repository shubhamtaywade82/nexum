import type { PlanStep } from "./types.js";

const MARK: Partial<Record<PlanStep["status"], string>> = {
  completed: "✓",
  failed: "✗",
  blocked: "⊘",
  skipped: "–",
  rolledback: "↺",
};

/** One-screen summary of a finished plan for the chat transcript. */
export function summarizePlan(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === "completed").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const head =
    failed > 0
      ? `Ran as a plan: ${done}/${steps.length} steps completed, ${failed} failed. /plan resumes what is left.`
      : `Ran as a plan: ${done}/${steps.length} steps completed.`;
  const lines = steps.map((s) => `${MARK[s.status] ?? "·"} ${s.description}`);
  return [head, ...lines].join("\n");
}
