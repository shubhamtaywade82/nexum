/**
 * MAC v1 P7 — multi-agent evaluation report rendering (markdown + JSON).
 *
 * The markdown mirrors the existing eval report style: a subject table with
 * metrics, the calibration status (the ≥ 100 rule made visible), the
 * mission_* telemetry counters, and the per-case audit trail. Held-out cases
 * are listed separately with their split digest — never merged into the
 * development numbers.
 */

import type { CaseOutcome, MultiAgentEvalReport } from "./types.js";

export function renderMultiAgentMarkdown(report: MultiAgentEvalReport, caseResults: CaseOutcome[]): string {
  const lines: string[] = [];
  lines.push(`# Multi-agent evaluation — ${report.datasetVersion}`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Held-out split digest: \`${report.heldOutSplitDigest.slice(0, 16)}…\` (heldout-split-v1)`);
  lines.push("");

  lines.push(`## Subjects (development set; ${report.totalPassed}/${report.totalCases} cases passed)`);
  lines.push("");
  lines.push("| Subject | Cases (pass) | Held out | Metrics |");
  lines.push("| --- | --- | --- | --- |");
  for (const subject of report.subjects) {
    const metrics = Object.entries(subject.metrics)
      .map(([key, value]) => `${key}=${formatMetric(value)}`)
      .join(", ");
    lines.push(
      `| ${subject.subject} | ${subject.casesPassed}/${subject.casesTotal} | ${subject.heldOutCases} | ${metrics} |`,
    );
  }
  lines.push("");

  lines.push("## Calibration (labeled outcomes — the ≥ 100 rule)");
  lines.push("");
  lines.push("| Subject | Labeled outcomes | Dataset usable (≥ 100) | Brier | ECE |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const cal of report.calibration) {
    lines.push(
      `| ${cal.subject} | ${cal.labeledOutcomes} | ${cal.datasetUsable ? "yes" : "no"} | ${cal.brier ?? "—"} | ${cal.ece ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    "Probability fields are only permitted for subjects with a usable dataset — calibration is earned, not asserted (SPEC §15).",
  );
  lines.push("");

  lines.push("## Telemetry counters (mission_*)");
  lines.push("");
  lines.push("| Counter | Value |");
  lines.push("| --- | --- |");
  for (const [counter, value] of Object.entries(report.counters)) {
    lines.push(`| ${counter} | ${value} |`);
  }
  lines.push("");

  lines.push("## Case audit trail");
  lines.push("");
  lines.push("| Case | Subject | Result | Details |");
  lines.push("| --- | --- | --- | --- |");
  for (const result of caseResults) {
    lines.push(
      `| ${result.caseId} | ${result.subject} | ${result.pass ? "pass" : "FAIL"} | ${escapeCell(result.details)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120);
}
