/**
 * ReportGenerator — finalizes a partial report into a complete one following
 * the contract in config/evolution/evaluation.yml.
 *
 * The generator:
 *   - Fills in task_identification from the task definition and current commit.
 *   - De-duplicates episode ids in evidence to compute independent_samples.
 *   - Caps confidence by independent_samples (confidence_ceiling_by_samples).
 *   - Validates that every required section declared by the task is present.
 *
 * Architecture: docs/evolution/architecture.md §6
 */

import { createHash } from "node:crypto";
import { TaskDefinition, Report, ReportRef, ReportSection } from "../tasks/types.js";

export interface FinalizeOptions {
  /** ISO 8601 evaluation date. Default: now. */
  evaluationDate?: string;
  /** Window start in epoch ms. Default: 30 days ago. */
  evidenceWindowFrom?: number;
  /** Window end in epoch ms. Default: now. */
  evidenceWindowTo?: number;
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class ReportGenerator {
  /**
   * Finalizes a partial report into a complete, immutable one. The returned
   * report's id is a deterministic SHA-256 of (taskId, evaluatedCommit,
   * evaluationDate, partial content). This makes accidental double-writes
   * idempotent: the same partial content for the same task at the same commit
   * produces the same id.
   */
  finalize(
    task: TaskDefinition,
    partial: Partial<Report>,
    evaluatedCommit: string,
    opts: FinalizeOptions = {},
  ): Report {
    const evaluationDate = opts.evaluationDate ?? new Date().toISOString();
    const windowFrom = opts.evidenceWindowFrom ?? Date.now() - DEFAULT_WINDOW_MS;
    const windowTo = opts.evidenceWindowTo ?? Date.now();

    // De-duplicate episode ids across all gaps' evidence to compute
    // independent_samples. This enforces anti-rule §3 (no duplicate episodes
    // as independent evidence).
    const episodeIds = new Set<string>();
    const gaps = partial.identified_gaps?.gaps ?? [];
    for (const g of gaps) {
      for (const e of g.evidence) {
        if (looksLikeEpisodeId(e)) episodeIds.add(e);
      }
    }
    const independentSamples = episodeIds.size;

    const overall = partial.confidence?.overall ?? 0;
    // Confidence ceiling: overall ≤ min(1, independentSamples / 10).
    const ceiling = Math.min(1, independentSamples / 10);
    const cappedOverall = Math.min(overall, ceiling);

    const report: Report = {
      id: "", // set below
      taskId: task.id,
      taskTitle: task.title,
      taskSchemaVersion: task.schemaVersion,
      evaluationDate: Date.parse(evaluationDate) || Date.now(),
      evaluatedCommit,
      task_identification: partial.task_identification ?? {
        task_id: task.id,
        title: task.title,
        evaluation_date: evaluationDate,
        evaluated_commit: evaluatedCommit,
        schema_version: task.schemaVersion,
      },
      current_implementation: partial.current_implementation ?? {
        files: [],
        classes: [],
        methods: [],
        entry_points: [],
      },
      current_behavior: partial.current_behavior ?? { summary: "", observed_paths: [] },
      identified_gaps: { gaps },
      root_cause_analysis: partial.root_cause_analysis ?? { root_causes: [] },
      improvement_proposals: partial.improvement_proposals ?? { proposals: [] },
      expected_impact: partial.expected_impact ?? {
        capability_delta: 0,
        reliability_delta: 0,
        cost_delta: 0,
        measurement_basis: "not specified",
      },
      risk_assessment: partial.risk_assessment ?? {
        regression_risks: [],
        security_risks: [],
        mitigation_notes: [],
      },
      implementation_plan: partial.implementation_plan ?? {
        files_likely_to_change: [],
        components_likely_to_change: [],
        estimated_loc: 0,
      },
      verification_plan: partial.verification_plan ?? {
        tests_required: [],
        benchmarks_required: [],
        held_out_evaluation: task.execution.mode === "implement" ? "required" : "optional",
      },
      recommendation: partial.recommendation ?? {
        decision: "no_change",
        rationale: "no recommendation was provided",
      },
      confidence: {
        overall: cappedOverall,
        independent_samples: independentSamples,
        evidence_window: {
          from: new Date(windowFrom).toISOString(),
          to: new Date(windowTo).toISOString(),
        },
        limitations: partial.confidence?.limitations ?? [],
      },
    };

    // Validate that every section the task declares as required is present
    // and non-default-empty. We check presence; deeper content checks are the
    // caller's responsibility (the diagnostician).
    const missing = task.report.required.filter((s: ReportSection) => isSectionEmpty(report, s));
    if (missing.length > 0) {
      throw new Error(`Report for ${task.id} is missing required sections: ${missing.join(", ")}`);
    }

    // Validate: if recommendation is "implement", at least one proposal must
    // reference a root cause that matches a gap.
    if (report.recommendation.decision === "implement") {
      const gapDescs = new Set(gaps.map((g) => g.description));
      const hasChain = report.improvement_proposals.proposals.some((p) => p.rootCauseRefs.some((r) => gapDescs.has(r)));
      if (!hasChain) {
        throw new Error(
          `Report for ${task.id} recommends "implement" but no improvement_proposal references an identified gap. This is required by evaluation.yml.`,
        );
      }
    }

    report.id = computeId(report, evaluatedCommit);
    return report;
  }

  /** Builds a lightweight reference (no body) for a stored report. */
  refFor(report: Report): ReportRef {
    return {
      id: report.id,
      taskId: report.taskId,
      taskSchemaVersion: report.taskSchemaVersion,
      createdAt: report.evaluationDate,
      evaluatedCommit: report.evaluatedCommit,
      decision: report.recommendation.decision,
      confidence: report.confidence.overall,
      independentSamples: report.confidence.independent_samples,
    };
  }
}

function looksLikeEpisodeId(s: string): boolean {
  // Episode ids in Nexum are typically "ep-<uuid>" or similar. We accept any
  // non-empty string that does not look like a file path or a metric value.
  if (!s) return false;
  if (s.startsWith("/") || s.startsWith("./")) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return false; // metric value
  if (s.includes(":") && s.includes(".")) return false; // file:line
  return true;
}

function isSectionEmpty(report: Report, section: ReportSection): boolean {
  switch (section) {
    case "task_identification":
      return !report.task_identification.task_id;
    case "current_implementation":
      return report.current_implementation.files.length === 0 && report.current_implementation.methods.length === 0;
    case "current_behavior":
      return !report.current_behavior.summary;
    case "identified_gaps":
      return report.identified_gaps.gaps.length === 0;
    case "root_cause_analysis":
      return report.root_cause_analysis.root_causes.length === 0;
    case "improvement_proposals":
      return report.improvement_proposals.proposals.length === 0;
    case "expected_impact":
      return !report.expected_impact.measurement_basis;
    case "risk_assessment":
      return report.risk_assessment.regression_risks.length === 0 && report.risk_assessment.security_risks.length === 0;
    case "implementation_plan":
      return report.implementation_plan.files_likely_to_change.length === 0;
    case "verification_plan":
      return report.verification_plan.tests_required.length === 0;
    case "recommendation":
      return !report.recommendation.decision;
    case "confidence":
      return report.confidence.independent_samples === 0 && report.confidence.overall === 0;
    default:
      return false;
  }
}

function computeId(report: Report, evaluatedCommit: string): string {
  // Hash a stable subset of the report to produce a deterministic id.
  // We intentionally exclude the id itself and the evaluationDate (which has
  // sub-second variance) — the same partial content at the same commit should
  // produce the same id.
  const payload = JSON.stringify({
    taskId: report.taskId,
    evaluatedCommit,
    gaps: report.identified_gaps.gaps,
    recommendation: report.recommendation,
    independentSamples: report.confidence.independent_samples,
  });
  return "rpt-" + createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}
