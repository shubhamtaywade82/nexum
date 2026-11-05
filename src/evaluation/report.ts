/**
 * Evaluation reports: markdown rendering + JSON persistence (baselines for
 * regression gating).
 */

import { promises as fs } from "node:fs";
import type { EvaluationReport, RegressionResult, ScenarioResult } from "./types.js";

/** Compact one-line summary of a scenario for tables. */
function keyMetrics(result: ScenarioResult): string {
  const byId = new Map(result.metrics.map((m) => [m.metricId, m]));
  const parts: string[] = [];
  const goal = byId.get("goal.completion");
  if (goal) parts.push(`goal ${goal.value.toFixed(2)}`);
  const tools = byId.get("tool.selection");
  if (tools) parts.push(`tools ${tools.value.toFixed(2)}`);
  const judge = byId.get("judge.overall");
  if (judge) parts.push(`judge ${judge.value.toFixed(2)}`);
  const latency = byId.get("run.latency_ms");
  if (latency) parts.push(`${Math.round(latency.value)}ms`);
  const tokens = byId.get("run.tokens");
  if (tokens) parts.push(`${Math.round(tokens.value)}t`);
  return parts.length > 0 ? parts.join(" · ") : "(no metrics)";
}

/** Render a report as GitHub-flavored markdown. */
export function renderMarkdownReport(report: EvaluationReport): string {
  const lines: string[] = [
    `# Evaluation report — ${report.datasetName} (\`${report.datasetId}\`)`,
    "",
    `- **Run at:** ${report.runAt}`,
    `- **Verdict:** ${report.pass ? "✅ PASS" : "❌ FAIL"}`,
    `- **Scenarios:** ${report.summary.passed}/${report.summary.total} passed (${report.summary.errors} errors)`,
    "",
    "| Scenario | Verdict | Key metrics |",
    "|---|---|---|",
  ];
  for (const result of report.results) {
    const verdict = result.error ? "⚠️ error" : result.pass ? "pass" : "FAIL";
    lines.push(`| ${result.scenarioId} | ${verdict} | ${keyMetrics(result)} |`);
  }
  lines.push("", "## Metric averages", "", "| Metric | Average |", "|---|---|");
  for (const [metricId, avg] of Object.entries(report.summary.metricAverages)) {
    lines.push(`| ${metricId} | ${avg} |`);
  }
  return lines.join("\n");
}

/** Render a regression comparison summary. */
export function renderRegression(regression: RegressionResult): string {
  const header = regression.pass ? "No regressions beyond policy." : `Regressions detected (${regression.mode} mode):`;
  const lines = [header];
  for (const finding of regression.regressions) {
    lines.push(
      `  - ${finding.metricId}: ${finding.baseline} → ${finding.current} (Δ ${finding.delta}, allowed ${-finding.maxRegression})`,
    );
  }
  return lines.join("\n");
}

/** JSON file persistence for reports / baselines. */
export class ReportStore {
  constructor(private readonly directory: string) {}

  async save(report: EvaluationReport, fileName?: string): Promise<string> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.directory, { recursive: true });
    const name = fileName ?? `${report.datasetId}-${report.runAt.replace(/[:.]/g, "-")}.json`;
    const path = `${this.directory}/${name}`;
    await fs.writeFile(path, JSON.stringify(report, null, 2), "utf8");
    return path;
  }

  async load(fileName: string): Promise<EvaluationReport> {
    const raw = await fs.readFile(`${this.directory}/${fileName}`, "utf8");
    return JSON.parse(raw) as EvaluationReport;
  }

  /** Latest report file for a dataset id (by runAt), for baseline resolution. */
  async latestFor(datasetId: string): Promise<EvaluationReport | undefined> {
    const files = (await fs.readdir(this.directory)).filter(
      (f) => f.startsWith(`${datasetId}-`) && f.endsWith(".json"),
    );
    if (files.length === 0) return undefined;
    files.sort();
    return this.load(files[files.length - 1]);
  }
}
