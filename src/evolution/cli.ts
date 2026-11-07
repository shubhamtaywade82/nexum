/**
 * CLI interface for the Nexum Harness Evolution System.
 *
 * Implements developer commands for diagnosing runtime weaknesses, inspecting
 * the H0 -> Hn evolutionary lineage, running benchmarks, and rolling back mutations.
 */

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { BenchmarkResult } from "../benchmark/types.js";
import { loadConfig, CliConfig } from "../cli/config.js";
import { Episode } from "../learning/types.js";
import { findWorkspaceRoot, workspaceStateDir } from "../platform/paths.js";
import { Provider } from "../models/adapters/provider.js";
import { runHarnessBenchmark, toTaskExecutionResult } from "./benchmarks.js";
import { CandidateEvaluationOutcome, EvolutionEngine } from "./engine.js";
import { ActivationResult, ClosedLoopEngine } from "./engine-v2.js";
import type { ActivationEvidence } from "./delivery/activation-gate.js";
import { ExperienceStore } from "./experience/experience-store.js";
import {
  buildExperimentArtifact,
  writeExperimentArtifact,
  ExperimentArtifactInput,
} from "./experiments/experiment-artifact.js";
import { ExperimentController } from "./experiments/experiment-controller.js";
import { ExperimentStore } from "./experiments/experiment-store.js";
import { TaskExecutionResult } from "./evaluator.js";
import { EvolutionMetricsTracker } from "./metrics.js";
import { AgentMutationStrategy } from "./mutation/agent-mutation.js";
import { GitWorktreeMutationExecutor, MutationStrategy } from "./mutation/mutation-executor.js";
import { NexumEngineeringAgentRuntime, chatClientFromProvider } from "./mutation/nexum-agent-runtime.js";
import { KernelEvolutionAgentRuntime, modelGatewayFromChatClient } from "./mutation/kernel-agent-runtime.js";
import { DefaultAgentRuntime } from "../runtime/agent/agent-runtime.js";
import { EvolutionVerificationProfile, verificationProfileByName } from "./mutation/verification-profile.js";
import { GitHubDeliveryAdapter } from "./delivery/github-adapter.js";
import { ActivationMonitor, OperationalTelemetry } from "./monitoring/activation-monitor.js";
import { ContinuousMonitorService } from "./monitoring/monitor-service.js";
import { ManifestRuntimeActivationController } from "./monitoring/manifest-runtime-activation.js";
import { EvolutionPlan } from "./planner.js";
import { EvolutionWorker, EvolutionCycleResult } from "./evolution-worker.js";
import { HarnessRegistry } from "./registry.js";
import { HarnessComponent, HarnessDiagnosis, HarnessVersion } from "./types.js";
import { isTaskCliInvocation, runTaskCli, runTaskContinuous } from "./tasks/cli.js";

const execFileAsync = promisify(execFile);

const HELP_TEXT = `
Nexum Evolution — Self-Developing Harness System (closed-loop v2)

Usage:
  nexum evolve [options]

Options:
  -d, --diagnose         Diagnose recent execution failures and recommend mutations
      --target           Form the capability-level improvement target (Aspire layer)
      --experience       Show evidence-grounded experience digest (S³Gym layer)
      --experiments      List experiment records with lifecycle states
      --report           Evolution health report (promotion precision, retention, …)
      --history          Show evolutionary lineage (H0 -> Hn) and active version
      --mutate           Run the self-development actuator: target → isolated
                         worktree → planned edits → verification → candidate commit
      --agent            Alias for --strategy agent.
      --strategy <name>  Mutation strategy for --mutate: "heuristic" (default,
                         policy-manifest edit), "agent" (the PRODUCTION
                         engineering agent run through the kernel —
                         KernelEvolutionAgentRuntime: policy, budgets,
                         concurrency gates, cancellation — proposing edits to
                         the actual implementation), or "agent-legacy" (the
                         previous private tool loop, for parity checks).
      --verify-profile <name>  Verification gates for the mutation worktree:
                         "smoke" (node liveness), "fast" (format + lint +
                         typecheck; default), "full" (fast + npm test,
                         CI-equivalent). Defaults to "full" with --github.
      --repo <path>      Harness repository to mutate (required with --mutate)
      --parent <sha>     Parent commit to mutate from (default: HEAD)
  -c, --candidate <id>   Evaluate candidate harness and check promotion criteria
  -r, --rollback <id>    Roll back active harness to a prior version
  -b, --benchmark        Run benchmark categories relevant to candidate; with
                         --mutate, benchmark the candidate worktree in a
                         SUBPROCESS (and the parent repository first for a
                         real baseline delta)
      --skip-baseline    With --mutate --benchmark: skip benchmarking the
                         parent repository for baseline deltas
      --github           Force GitHub delivery (enabled automatically when
                         NEXUM_GITHUB_OWNER + NEXUM_GITHUB_REPO are configured).
      --no-github         Keep this run local; skip GitHub delivery.
                         Optional NEXUM_GITHUB_TOKEN, NEXUM_GITHUB_BASE_BRANCH.
      --experiment-dir <path>  Directory for the immutable per-cycle experiment
                         artifact JSON (default: <workspace>/state/experiments).
      --activate-runtime Compatibility flag; activation is on by default.
      --no-activate-runtime
                         Disable the final runtime switch for this run. Activation
                         still requires same-commit human review, passing CI,
                         successful merge, and GitHub read-back verification.
  -a, --autonomous       Run the full autonomous cycle: ingest ALL experience,
                         observe failures AND successful patterns, form the
                         target, and — with --repo — execute the mutation
                         cycle (without --repo: observation + planning only)
      --continuous       With --mutate (or --autonomous --repo): keep evolving
                         in a policy-gated loop. A cycle only runs when a
                         capability target with sufficient confidence exists;
                         the worker never mutates because a schedule fired
      --interval <ms>    Tick interval for --continuous (default 3600000) and
                         --monitor --watch (default 60000)
      --max-cycles <n>   Stop after n mutation cycles in --continuous mode
      --generalization-policy <p>  "optional" | "required" |
                         "required-for-production" (default:
                         required-for-production when GitHub delivery is configured)
      --watch            With --monitor: continuously tail the telemetry file
                         and re-evaluate on every new sample instead of a
                         one-shot verdict
      --experiment <id>  With --monitor --watch: evaluate (and auto-rollback)
                         this experiment's harness through the closed-loop
                         engine's ACTIVE → REGRESSED → ROLLBACK path
      --limit <n>        Limit number of episodes analyzed (default: 20;
                         experience ingestion always covers every episode)
      --component <name> Target subsystem for candidate evaluation (default: execution)
      --hypothesis <txt> Remediation hypothesis statement for candidate
      --monitor          Evaluate post-activation health against the parent envelope
      --telemetry <file> JSONL file of OperationalTelemetry samples for --monitor
      --harness <id>     Harness id to evaluate with --monitor
      --task-catalog      List all tasks in the evolution task catalogue
      --task-validate     Validate the catalogue YAML against the schema
      --task-show <id>    Show one task definition from the catalogue
      --task-backlog      Show backlog state for all catalogue tasks
      --task-prioritize   Rank pending tasks using the policies.yml weights
      --task-run <id>     Run a catalogue task (diagnose mode) end-to-end
      --task-continuous   Sweep the catalogue on a schedule: every tick picks
                          the highest-priority eligible task (cadence ceilings
                          and anti-rules always apply). With --interval <ms>
                          and --max-cycles <n> to bound it
      --task-category <n> Filter --task-catalog/--task-prioritize by category
      --task-priority <p> Filter --task-catalog/--task-prioritize by P0/P1/P2
  -h, --help             Show this help message
`;

const CLI_OPTIONS = {
  help: { type: "boolean" as const, short: "h" },
  diagnose: { type: "boolean" as const, short: "d" },
  target: { type: "boolean" as const },
  experience: { type: "boolean" as const },
  experiments: { type: "boolean" as const },
  report: { type: "boolean" as const },
  mutate: { type: "boolean" as const },
  agent: { type: "boolean" as const },
  strategy: { type: "string" as const },
  "verify-profile": { type: "string" as const },
  "skip-baseline": { type: "boolean" as const },
  github: { type: "boolean" as const },
  "no-github": { type: "boolean" as const },
  "experiment-dir": { type: "string" as const },
  "activate-runtime": { type: "boolean" as const },
  "no-activate-runtime": { type: "boolean" as const },
  repo: { type: "string" as const },
  parent: { type: "string" as const },
  monitor: { type: "boolean" as const },
  telemetry: { type: "string" as const },
  harness: { type: "string" as const },
  history: { type: "boolean" as const },
  candidate: { type: "string" as const, short: "c" },
  rollback: { type: "string" as const, short: "r" },
  benchmark: { type: "boolean" as const, short: "b" },
  autonomous: { type: "boolean" as const, short: "a" },
  continuous: { type: "boolean" as const },
  interval: { type: "string" as const },
  "max-cycles": { type: "string" as const },
  "generalization-policy": { type: "string" as const },
  watch: { type: "boolean" as const },
  experiment: { type: "string" as const },
  limit: { type: "string" as const },
  component: { type: "string" as const },
  hypothesis: { type: "string" as const },
  "task-catalog": { type: "boolean" as const },
  "task-validate": { type: "boolean" as const },
  "task-show": { type: "string" as const },
  "task-backlog": { type: "boolean" as const },
  "task-prioritize": { type: "boolean" as const },
  "task-run": { type: "string" as const },
  "task-continuous": { type: "boolean" as const },
  "task-category": { type: "string" as const },
  "task-priority": { type: "string" as const },
};

/** Reads recent episodes from the workspace lesson database. */
export function loadRecentEpisodes(root: string, limit = 20): Episode[] {
  const dbPath = join(workspaceStateDir(root), "lessons.db");
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    const rows = db.prepare("SELECT payload FROM episodes ORDER BY started_at DESC LIMIT ?").all(limit) as Array<{
      payload: string;
    }>;
    return rows.map((r) => JSON.parse(r.payload) as Episode);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * v2.4: reads EVERY episode from the workspace lesson database. This is the
 * experience FEED: ingestion must cover all completed episodes, not just the
 * recent diagnosis window, so that cross-session evidence accumulates even
 * when evolution decisions only consult the last `--limit` episodes.
 */
export function loadAllEpisodes(root: string): Episode[] {
  const dbPath = join(workspaceStateDir(root), "lessons.db");
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    const rows = db.prepare("SELECT payload FROM episodes ORDER BY started_at DESC").all() as Array<{
      payload: string;
    }>;
    return rows.map((r) => JSON.parse(r.payload) as Episode);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Formats the formed improvement target (Aspire layer) for CLI display. */
export function formatTargetText(observation: ReturnType<ClosedLoopEngine["observe"]>): string {
  const lines: string[] = ["=== Target Formation (closed-loop v2) ==="];
  if (!observation.target) {
    lines.push(
      "No capability target could be operationalized from the available diagnoses.",
      "Gather more telemetry before mutating the harness (Aspire: vague targets waste the improvement budget).",
    );
    return lines.join("\n");
  }
  const t = observation.target;
  lines.push(`Capability:      ${t.capability} (confidence ${(t.confidence * 100).toFixed(0)}%)`);
  lines.push(`Desired Outcome: ${t.desiredOutcome}`);
  lines.push(`Symptoms:        ${t.observableSymptoms.length}`);
  t.observableSymptoms.slice(0, 5).forEach((s) => lines.push(`  - ${s}`));
  lines.push(`Must-Move Metrics: ${t.measurableMetrics.join(", ")}`);
  lines.push(`Affected Components: ${t.affectedComponents.join(", ")}`);
  lines.push(`Evaluation Plan: ${t.evaluationPlan.steps.map((s) => `${s.suite}(${s.split})`).join(", ")}`);
  if (observation.mutationScope) {
    lines.push(
      `Mutation Scope: ${observation.mutationScope.kind} [${observation.mutationScope.components.join(", ")} ]`,
    );
    lines.push(`Scope Rationale: ${observation.mutationScope.rationale}`);
  }
  return lines.join("\n");
}

/** Formats the experience digest (S³Gym layer) for CLI display. */
export function formatExperienceText(digests: ReturnType<ClosedLoopEngine["digestExperience"]>): string {
  if (digests.length === 0) return "No experience records stored yet. Experience accumulates from graded episodes.";
  const lines: string[] = [`=== Experience Digest (${digests.length} task class(es)) ===`];
  for (const d of digests) {
    lines.push(`\n[${d.taskClass}] records=${d.totalRecords} successRate=${(d.successRate * 100).toFixed(0)}%`);
    lines.push(`  Best representation: ${d.bestRepresentation} (S³Gym: no single representation wins everywhere)`);
    if (d.failureModes.length > 0) {
      lines.push(
        `  Top failure modes: ${d.failureModes
          .slice(0, 3)
          .map((f) => `${f.mode}(${(f.share * 100).toFixed(0)}%)`)
          .join(", ")}`,
      );
    }
    if (d.crossModelEvidence.length > 0) {
      lines.push(
        `  Cross-model deltas: ${d.crossModelEvidence.map((e) => `${e.fromModel}→${e.toModel}:${(e.outcomeDelta * 100).toFixed(0)}%`).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

/** Formats the experiment registry (persistent provenance) for CLI display. */
export function formatExperimentsText(records: ReturnType<ExperimentStore["listAll"]>): string {
  if (records.length === 0) return "No experiments recorded yet. Experiments are created by the closed-loop engine.";
  const lines: string[] = [`=== Experiment Records (${records.length}) ===`];
  for (const r of records) {
    lines.push(
      `${r.id}  ${r.parent.harness}→${r.candidate.harness}  state=${r.lifecycle.state}  decision=${r.decision.result}  ci=${r.ci.status}  review=${r.review.state}`,
    );
    lines.push(
      `  capability: ${r.target.capability} | executors: ${r.executor.primary}${r.executor.transfer.length ? ` + ${r.executor.transfer.join(", ")}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** Formats the loop health report (first-class evolution metrics). */
export function formatHealthReport(report: ReturnType<EvolutionMetricsTracker["report"]>): string {
  const pct = (v: number | null) => (v === null ? "n/a (not measured)" : `${(v * 100).toFixed(1)}%`);
  const lines: string[] = [
    "=== Evolution Health Report ===",
    `Versions tracked:        ${report.totalVersions}`,
    `Promoted candidates:     ${report.promotedCount}`,
    `Promotion precision:     ${pct(report.promotionPrecision)}`,
    `False promotion rate:    ${pct(report.falsePromotionRate)}`,
    `Retention rate:          ${pct(report.retentionRate)}`,
    `Regression rate:         ${pct(report.regressionRate)}`,
    `Rollback rate:           ${pct(report.rollbackRate)}`,
    `Mean visible gain:       ${pct(report.meanVisibleGain)}`,
    `Mean held-out gain:      ${pct(report.meanHeldOutGain)}`,
    `Mean transfer gain:      ${pct(report.meanTransferGain)}`,
    `Executor sensitivity:    ${pct(report.meanExecutorSensitivity)}`,
    `Experience→improvement r: ${report.experienceImprovementCorrelation?.toFixed(2) ?? "n/a (not measured)"}`,
    "",
    report.promotionPrecisionVerdict,
  ];
  return lines.join("\n");
}

/** Formats a tabular list of evolutionary versions. */
export function formatHistory(versions: HarnessVersion[], active: HarnessVersion | null): string {
  if (versions.length === 0) return "No harness versions registered. System is running unversioned base.";
  const header = "ID       STATUS     COMPONENT    CREATED                   HYPOTHESIS\n" + "-".repeat(80);
  const rows = versions.map((v) => {
    const activeMark = active?.id === v.id ? "* " : "  ";
    const date = new Date(v.createdAt).toISOString();
    const hyp = v.hypothesis.length > 32 ? `${v.hypothesis.slice(0, 29)}...` : v.hypothesis;
    return `${activeMark}${v.id.padEnd(7)} ${v.status.padEnd(10)} ${v.targetComponent.padEnd(12)} ${date}  ${hyp}`;
  });
  return `${header}\n${rows.join("\n")}\n\n* = currently active harness version`;
}

/**
 * Formats diagnoses and the recommended evolution plan into a readable report.
 * `episodeCount` is the number of episodes that were diagnosed. Zero episodes means
 * nothing was evaluated, which must not read as a clean bill of health.
 */
export function formatDiagnosesText(
  diagnoses: HarnessDiagnosis[],
  plan: EvolutionPlan | null,
  episodeCount?: number,
): string {
  if (diagnoses.length === 0) {
    if (episodeCount === 0) {
      return "No episodes recorded yet (lessons.db is empty or missing), so nothing was diagnosed. This is not evidence that the harness is healthy.";
    }
    const scope = episodeCount === undefined ? "evaluated episodes" : `${episodeCount} evaluated episode(s)`;
    return `No harness weaknesses detected across ${scope}.`;
  }
  const lines: string[] = [`=== Harness Diagnoses (${diagnoses.length} issue(s) detected) ===`];
  diagnoses.forEach((d, idx) => {
    lines.push(`\n${idx + 1}. [${d.component}] ${d.failureClass} (confidence: ${(d.confidence * 100).toFixed(0)}%)`);
    lines.push(`   Root Cause: ${d.rootCause}`);
    lines.push(`   Proposed Fix: ${d.proposedFix}`);
    lines.push(
      `   Expected Impact: capability +${(d.expectedImpact.capability * 100).toFixed(0)}%, reliability +${(d.expectedImpact.reliability * 100).toFixed(0)}%`,
    );
  });
  if (plan) {
    lines.push("\n=== Recommended Evolution Plan ===");
    lines.push(`Target Subsystem: ${plan.targetComponent}`);
    lines.push(`Hypothesis: ${plan.hypothesis.statement}`);
    lines.push(`Recommended Benchmarks: ${plan.recommendedBenchmarkCategories.join(", ")}`);
    if (plan.target) {
      lines.push(`Capability Target: ${plan.target.capability} → ${plan.target.desiredOutcome}`);
      lines.push(`Affected Components: ${plan.target.affectedComponents.join(", ")}`);
    }
    if (plan.mutationScope) {
      lines.push(
        `Mutation Scope: ${plan.mutationScope.kind} [${plan.mutationScope.components.join(", ")}] — ${plan.mutationScope.rationale}`,
      );
    }
  }
  return lines.join("\n");
}

function printOutcome(outcome: CandidateEvaluationOutcome): void {
  const v = outcome.version;
  const d = outcome.comparison.scoreDeltas;
  console.log(`\n=== Evaluation Outcome for ${v.id} ===`);
  console.log(`Decision:  ${outcome.comparison.decision.toUpperCase()}`);
  console.log(`Status:    ${v.status}`);
  console.log(`Rationale: ${outcome.comparison.rationale}\n`);
  console.log("Score Deltas vs Baseline:");
  console.log(`  Capability:     ${d.capability >= 0 ? "+" : ""}${(d.capability * 100).toFixed(1)}%`);
  console.log(`  Reliability:    ${d.reliability >= 0 ? "+" : ""}${(d.reliability * 100).toFixed(1)}%`);
  console.log(`  Efficiency:     ${d.efficiency >= 0 ? "+" : ""}${(d.efficiency * 100).toFixed(1)}%`);
  console.log(`  Generalization: ${d.generalization >= 0 ? "+" : ""}${(d.generalization * 100).toFixed(1)}%`);
  if (outcome.deliveryReport) {
    console.log(`\nDelivery Branch: ${outcome.deliveryReport.branchName}`);
    console.log(`PR Title:        ${outcome.deliveryReport.prTitle}`);
  }
}

async function runCandidateEvaluation(
  engine: EvolutionEngine,
  values: Record<string, unknown>,
  candidateId: string,
): Promise<void> {
  const cfg = loadConfig();
  const provider = new Provider({
    tier: cfg.tier,
    model: cfg.model,
    apiKey: cfg.apiKey,
    host: cfg.tier === "local" ? cfg.host : undefined,
  });
  const component = (values.component as HarnessComponent) || "execution";
  const hypothesis = (values.hypothesis as string) || "Automated harness mutation evaluation";

  console.log(`[Evolution] Benchmarking candidate ${candidateId} using model ${cfg.model} (${cfg.tier})...`);
  try {
    const results = await runHarnessBenchmark(provider, [component]);
    const outcome = engine.evaluateCandidate(
      { id: candidateId, commitSha: "HEAD", targetComponent: component, hypothesis },
      results,
    );
    printOutcome(outcome);
  } catch (err) {
    console.error(`[Evolution] Evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runBenchmarkSuites(engine: EvolutionEngine, root: string): Promise<void> {
  const episodes = loadRecentEpisodes(root, 20);
  const { plan } = engine.diagnoseEpisodes(episodes);
  const suites = plan?.recommendedBenchmarkCategories ?? ["execution", "agentic-looping"];
  console.log(`[Evolution] Running harness benchmark suites: ${suites.join(", ")}...`);

  const cfg = loadConfig();
  const provider = new Provider({
    tier: cfg.tier,
    model: cfg.model,
    apiKey: cfg.apiKey,
    host: cfg.tier === "local" ? cfg.host : undefined,
  });
  try {
    const results = await runHarnessBenchmark(provider, suites);
    const passed = results.filter((r) => r.success).length;
    console.log(`[Evolution] Benchmark completed: ${passed}/${results.length} cases passed.`);
  } catch (err) {
    console.log(
      `[Evolution] Recommended suites: ${suites.join(", ")} (run skipped: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Rebuilds the metrics tracker from persisted experiment records so that the
 * health report reflects the full history, not just the current process.
 */
/**
 * Rebuilds loop metrics from persisted experiments. Only quantities the record
 * actually carries are reported; the rest stay null/"unknown":
 *   - gains exist only when Stage B ran (its deltas are what the record stores)
 *   - transfer gain and executor sensitivity are not persisted per experiment
 *   - "genuinely better on held-out" needs a post-promotion re-evaluation the
 *     store does not hold (Stage B "improved" is a promotion precondition, so
 *     using it would make promotion precision 100% by construction)
 */
export function metricsFromExperimentStore(store: ExperimentStore): EvolutionMetricsTracker {
  const tracker = new EvolutionMetricsTracker();
  for (const r of store.listAll()) {
    const promoted = r.decision.result === "eligible";
    const accepted =
      r.lifecycle.state === "ACTIVE" || r.lifecycle.state === "REGRESSED" || r.lifecycle.state === "ROLLBACK";
    const stageBRan = r.decision.stageB !== "not_run";
    tracker.record({
      versionId: r.candidate.harness,
      parentVersionId: r.parent.harness,
      visibleGain: stageBRan ? r.metrics.capability : null,
      heldOutGain: stageBRan ? r.metrics.generalization : null,
      transferGain: null,
      promoted,
      genuinelyBetterOnHeldOut: "unknown",
      accepted,
      rolledBack: r.lifecycle.state === "ROLLBACK",
      retainedBySuccessor: "unknown",
      executorModels: [r.executor.primary, ...r.executor.transfer],
      executorSensitivity: null,
    });
  }
  return tracker;
}

async function executeCommand(engine: EvolutionEngine, values: Record<string, unknown>, root: string): Promise<void> {
  if (values.history) {
    console.log(formatHistory(engine.listVersions(), engine.getActiveVersion()));
    return;
  }
  if (typeof values.rollback === "string") {
    engine.rollback(values.rollback);
    console.log(`[Evolution] Active harness rolled back to ${values.rollback}.`);
    return;
  }
  if (typeof values.candidate === "string") {
    await runCandidateEvaluation(engine, values, values.candidate);
    return;
  }
  if (values.benchmark) {
    await runBenchmarkSuites(engine, root);
    return;
  }
  const limit = values.limit ? parseInt(values.limit as string, 10) : 20;
  const episodes = loadRecentEpisodes(root, limit);
  const { diagnoses, plan } = engine.diagnoseEpisodes(episodes);
  console.log(formatDiagnosesText(diagnoses, plan, episodes.length));
}

/** Formats a mutation actuator result for CLI display. */
export function formatMutationResult(res: {
  ok: boolean;
  stage?: string;
  reason?: string;
  mutation: {
    workspace?: { worktreePath: string; branchName: string };
    plan?: { summary: string; edits: unknown[] };
    result?: { diffStat: string };
    artifact?: { commitSha: string; changedFiles: string[] };
  };
}): string {
  const lines: string[] = ["=== Self-Development Actuator ==="];
  if (!res.ok) {
    lines.push(`FAILED at stage: ${res.stage}`, `Reason: ${res.reason}`);
    if (res.mutation.plan) lines.push(`Plan: ${res.mutation.plan.summary}`);
    return lines.join("\n");
  }
  if (res.mutation.workspace) {
    lines.push(`Worktree: ${res.mutation.workspace.worktreePath}`);
    lines.push(`Branch:   ${res.mutation.workspace.branchName}`);
  }
  if (res.mutation.plan) {
    lines.push(`Plan:     ${res.mutation.plan.summary} (${res.mutation.plan.edits.length} edit(s))`);
  }
  if (res.mutation.result) lines.push(`Diff:     ${res.mutation.result.diffStat.split("\n")[0] || "(no diff)"}`);
  if (res.mutation.artifact) {
    lines.push(`Commit:   ${res.mutation.artifact.commitSha}`);
    lines.push(`Files:    ${res.mutation.artifact.changedFiles.join(", ")}`);
  }
  return lines.join("\n");
}

/** Parses a JSONL telemetry file for the --monitor command. */
export function loadTelemetrySamples(path: string): OperationalTelemetry[] {
  const out: OperationalTelemetry[] = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as OperationalTelemetry);
  }
  return out;
}

/** Formats an activation health verdict for CLI display. */
export function formatActivationHealth(health: ReturnType<ActivationMonitor["evaluate"]>): string {
  const lines: string[] = [
    "=== Activation Monitor (post-deployment) ===",
    `Harness:   ${health.harnessId}`,
    `Status:    ${health.status.toUpperCase()}`,
    `Samples:   ${health.samples} sample(s), ${health.sampleEpisodes} episode(s)`,
  ];
  if (health.violations.length > 0) {
    lines.push("Violations:");
    health.violations.forEach((v) => lines.push(`  - [${v.severity}] ${v.detail}`));
  }
  if (health.distributionDrift !== null) {
    lines.push(`Task-class drift: ${(health.distributionDrift * 100).toFixed(1)}%`);
  }
  lines.push(health.rationale);
  return lines.join("\n");
}

// ── Production wiring helpers (v2.3.1) ──────────────────────────────────────

/** Builds the standard benchmark/eval Provider from CLI config. */
export function providerFromConfig(cfg: CliConfig): Provider {
  return new Provider({
    tier: cfg.tier,
    model: cfg.model,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.tier === "local" && cfg.host ? { host: cfg.host } : {}),
  });
}

/** Mutation strategy names accepted by `nexum evolve --strategy`. */
export const MUTATION_STRATEGIES = ["heuristic", "agent", "agent-legacy"] as const;

/**
 * Resolves the mutation strategy for `nexum evolve --mutate`:
 *   absent/"heuristic" → null (executor's built-in HeuristicMutationStrategy);
 *   "agent"            → AgentMutationStrategy backed by KernelEvolutionAgentRuntime
 *                        (same propose-only protocol, spawned through AgentRuntime.execute
 *                        so policy, budgets, gates and cancellation apply);
 *   "agent-legacy"     → AgentMutationStrategy backed by NexumEngineeringAgentRuntime
 *                        (the pre-kernel private loop, kept for parity comparison).
 * Throws for unknown names so typos fail loudly instead of silently
 * downgrading to the heuristic planner.
 */
export function buildMutationStrategy(name: string | undefined, cfg: CliConfig): MutationStrategy | null {
  if (!name || name === "heuristic") return null;
  const chat = () => chatClientFromProvider(providerFromConfig(cfg));
  if (name === "agent") {
    return new AgentMutationStrategy({
      runtime: new KernelEvolutionAgentRuntime({
        runtime: new DefaultAgentRuntime(),
        modelGateway: modelGatewayFromChatClient(chat()),
      }),
    });
  }
  if (name === "agent-legacy") {
    return new AgentMutationStrategy({ runtime: new NexumEngineeringAgentRuntime({ chat: chat() }) });
  }
  throw new Error(
    `Unknown mutation strategy "${name}" (expected ${MUTATION_STRATEGIES.map((n) => `"${n}"`).join(", ")}).`,
  );
}

/** Generalization evidence policies accepted by `nexum evolve --generalization-policy`. */
export const GENERALIZATION_POLICIES = ["optional", "required", "required-for-production"] as const;
export type GeneralizationPolicyName = (typeof GENERALIZATION_POLICIES)[number];

/**
 * v2.4: resolves the generalization evidence policy for `nexum evolve
 * --mutate`. Configured GitHub delivery defaults to
 * "required-for-production": a PR may only be opened for a candidate with
 * fixed-executor transfer evidence, so an improvement measured on one model
 * cannot silently ride a weaker evaluation. Local runs keep "optional".
 * Explicit `--generalization-policy` always wins. Throws on unknown names so
 * typos fail loudly instead of silently weakening the gate.
 */
export function resolveGeneralizationPolicy(
  values: Record<string, unknown>,
  githubEnabled: boolean = values.github === true,
): GeneralizationPolicyName {
  const explicit = values["generalization-policy"] as string | undefined;
  if (explicit) {
    if (!(GENERALIZATION_POLICIES as readonly string[]).includes(explicit)) {
      throw new Error(
        `Unknown generalization policy "${explicit}" (expected ${GENERALIZATION_POLICIES.map((n) => `"${n}"`).join(", ")}).`,
      );
    }
    return explicit as GeneralizationPolicyName;
  }
  return githubEnabled ? "required-for-production" : "optional";
}

export interface GithubDeliveryEnvConfig {
  owner: string;
  repo: string;
  token?: string;
  baseBranch: string;
}

/**
 * Resolves the GitHub delivery adapter configuration from the environment:
 * NEXUM_GITHUB_OWNER + NEXUM_GITHUB_REPO are required; NEXUM_GITHUB_TOKEN and
 * NEXUM_GITHUB_BASE_BRANCH (default "main") are optional. Returns null when
 * the required pair is absent so an explicit `--github` can report a precise error.
 */
export function resolveGithubDeliveryConfig(env: NodeJS.ProcessEnv = process.env): GithubDeliveryEnvConfig | null {
  const owner = env.NEXUM_GITHUB_OWNER?.trim();
  const repo = env.NEXUM_GITHUB_REPO?.trim();
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    ...(env.NEXUM_GITHUB_TOKEN?.trim() ? { token: env.NEXUM_GITHUB_TOKEN.trim() } : {}),
    baseBranch: env.NEXUM_GITHUB_BASE_BRANCH?.trim() || "main",
  };
}

/** GitHub delivery is the default whenever a destination is configured. */
export function resolveGithubDeliveryEnabled(
  values: Record<string, unknown>,
  config: GithubDeliveryEnvConfig | null,
): boolean {
  return values["no-github"] !== true && config !== null;
}

/** Runtime activation is on by default; the negative flag is a per-run opt-out. */
export function resolveRuntimeActivationEnabled(values: Record<string, unknown>): boolean {
  return values["no-activate-runtime"] !== true;
}

/** Parses the benchmark CLI's `--json` output into TaskExecutionResults. */
export function parseBenchmarkJson(stdout: string): TaskExecutionResult[] {
  // Extract JSON array, ignoring bracketed log messages on stdout like "[Learning]...".
  const match = stdout.match(/\[\s*\{[\s\S]*\}\s*\]/) ?? stdout.match(/(?:^|\n)\s*\[\s*\]/);
  if (!match) {
    throw new Error(`benchmark --json produced no results array: ${stdout.slice(0, 400)}`);
  }
  const results = JSON.parse(match[0].trim()) as BenchmarkResult[];
  return results.map(toTaskExecutionResult);
}

/**
 * Benchmarks a directory (the candidate worktree, or the parent repository
 * for the baseline) in a SUBPROCESS. Nexum's benchmark cases run in-process,
 * so evaluating "the candidate" inside the CLI process would benchmark the
 * HOST module graph, not the mutated code. The subprocess runs
 * `src/benchmark/cli.ts --json` with cwd = dir, so the mutated
 * implementation is what actually executes.
 */
export async function runBenchmarkInDir(
  repoRoot: string,
  dir: string,
  categories: string[],
): Promise<TaskExecutionResult[]> {
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxEntry)) {
    throw new Error(`tsx entry not found at ${tsxEntry} — install dependencies in the harness repository first.`);
  }
  if (dir !== repoRoot && !existsSync(join(dir, "node_modules"))) {
    // Worktrees share the repo's history but not its node_modules; link the
    // host's so the subprocess resolves the same toolchain. (The mutation
    // executor links it too when linkNodeModulesFrom is set — this is the
    // fallback for workspaces prepared without it.)
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
  }
  // The agent driver runs each case through the worktree's own Agent, so a mutation to the
  // runtime, prompts, routing or tool selection can move the score. The model driver could not.
  const args = [tsxEntry, "src/benchmark/cli.ts", "--json", "--driver", "agent"];
  for (const category of categories) args.push("--category", category);
  const { stdout } = await execFileAsync("node", args, { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
  return parseBenchmarkJson(stdout);
}

/** Resolves a git ref to its full commit SHA, or null when unresolvable. */
export async function resolveRepoCommit(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot });
    const sha = stdout.trim();
    return sha.length >= 40 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * v2.3.3: the S³Gym PRODUCTION FEED. The graded episodes the mutate path
 * loads are observations of the PARENT harness; converting them into
 * experience records (keyed by the resolved parent commit) is what makes
 * --experience digests and transfer analysis operate on measured evidence
 * instead of an empty store. Idempotent (episode_id is the store's primary
 * key) and best-effort: evidence accumulation must never break a mutation
 * cycle. Returns the number of records written (0 when nothing was stored).
 */
export async function ingestParentExperience(
  engine: ClosedLoopEngine,
  episodes: Episode[],
  repoRoot: string,
  parentRef: string,
): Promise<number> {
  if (episodes.length === 0) return 0;
  const harnessVersion = (await resolveRepoCommit(repoRoot, parentRef)) ?? parentRef;
  try {
    const records = engine.ingestExperience(episodes, harnessVersion);
    console.log(
      `[Evolution] Ingested ${records.length} experience record(s) (harness ${harnessVersion.slice(0, 12)}).`,
    );
    return records.length;
  } catch (err) {
    console.error(
      `[Evolution] WARNING: experience ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * v2.3.3: the RUNTIME half of acceptance; runtime activation is enabled by default.
 *
 * The switch happens only when the activation gate passes on live GitHub evidence
 * for the candidate commit: approval, CI, and a merge confirmed by read-back. The
 * runtime is then pinned to the verified merge commit. Everything else is recorded
 * as an honest skip, never as an activation.
 */
export async function activateRuntimeIfNeeded(
  engine: Pick<ClosedLoopEngine, "activateOnRuntime">,
  controller: Pick<ManifestRuntimeActivationController, "name" | "activeHarness" | "readPointer">,
  experimentId: string,
  outcome: Awaited<ReturnType<ClosedLoopEngine["runEvolutionCycle"]>>,
  activationEnabled: boolean,
): Promise<NonNullable<ExperimentArtifactInput["activation"]>> {
  const harnessId = outcome.ok ? outcome.outcome.experiment.candidate.harness : "";
  // The launcher in bin/cli.js (src/platform/harness-launcher.ts) runs the pointer's commit for
  // every agent command started from this checkout, so an activation changes what runs next.
  const base = { controller: controller.name, harnessId, consumedByRuntime: true };
  if (!outcome.ok) {
    return { ...base, commitSha: "", activatedAt: Date.now(), ok: false, error: "cycle did not produce a candidate" };
  }
  if (!activationEnabled) {
    const error = "runtime activation is disabled (--no-activate-runtime)";
    console.log(`[Evolution] Runtime activation skipped: ${error}.`);
    return { ...base, commitSha: "", activatedAt: Date.now(), ok: false, error };
  }

  const facts = outcome.github?.facts;
  const evidence: ActivationEvidence = {
    activationEnabled,
    githubDelivery: outcome.github !== undefined,
    candidateCommit: outcome.outcome.experiment.candidate.commit,
    review: facts?.review ?? null,
    ci: facts?.ci ?? null,
    merge: facts?.merge ?? null,
    verification: facts?.verification ?? null,
  };

  let result: ActivationResult;
  try {
    result = await engine.activateOnRuntime(experimentId, evidence);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[Evolution] Runtime activation FAILED: ${error}`);
    return { ...base, commitSha: "", activatedAt: Date.now(), ok: false, error };
  }
  if (!result.ok) {
    console.log(`[Evolution] Runtime activation skipped: ${result.reason}.`);
    return { ...base, commitSha: "", activatedAt: Date.now(), ok: false, error: result.reason };
  }

  // The runtime must have landed on exactly the verified merge commit, read back from the manifest.
  const pointer = controller.readPointer();
  if (controller.activeHarness() !== harnessId || pointer?.commitSha !== result.commitSha) {
    const error = `runtime pointer does not match the verified merge commit ${result.commitSha}`;
    console.error(`[Evolution] Runtime activation FAILED: ${error}`);
    return { ...base, commitSha: pointer?.commitSha ?? "", activatedAt: Date.now(), ok: false, error };
  }
  console.log(
    `[Evolution] Activated harness ${harnessId} @ ${result.commitSha.slice(0, 12)} (verified merge). The next agent command started from this checkout runs it; processes already running keep their code.`,
  );
  return { ...base, commitSha: result.commitSha, activatedAt: pointer.activatedAt ?? Date.now(), ok: true };
}

async function executeMutationCommand(root: string, values: Record<string, unknown>): Promise<void> {
  const repoRoot = values.repo as string | undefined;
  if (!repoRoot) {
    console.error("--mutate requires --repo <path> (the harness repository to mutate).");
    return;
  }
  const cfg = loadConfig();
  // --agent is an alias for --strategy agent; an explicit --strategy wins.
  const strategyName = (values.strategy as string | undefined) ?? (values.agent ? "agent" : undefined);
  if (values.agent && values.strategy && values.strategy !== "agent") {
    console.error(`--agent and --strategy ${values.strategy} conflict; pass only one.`);
    return;
  }
  if (strategyName && !(MUTATION_STRATEGIES as readonly string[]).includes(strategyName)) {
    console.error(
      `Unknown mutation strategy "${strategyName}" (expected ${MUTATION_STRATEGIES.map((n) => `"${n}"`).join(", ")}).`,
    );
    return;
  }
  // Verification profile: the gates the candidate must survive INSIDE the
  // worktree before it becomes a candidate commit. Default "fast" (format +
  // lint + typecheck); GitHub delivery defaults to "full" so a PR is only
  // opened for a candidate that passes the CI-equivalent gate.
  const githubCfg = resolveGithubDeliveryConfig();
  if (values.github && !githubCfg) {
    console.error(
      "--github requires NEXUM_GITHUB_OWNER and NEXUM_GITHUB_REPO (optionally NEXUM_GITHUB_TOKEN, NEXUM_GITHUB_BASE_BRANCH).",
    );
    return;
  }
  const githubEnabled = resolveGithubDeliveryEnabled(values, githubCfg);
  let profile: EvolutionVerificationProfile;
  try {
    profile = verificationProfileByName(
      (values["verify-profile"] as string | undefined) ?? (githubEnabled ? "full" : undefined),
    );
  } catch (err) {
    console.error((err as Error).message);
    return;
  }
  // v2.4: generalization evidence policy. Production delivery defaults to
  // "required-for-production" so a PR can only be opened for a candidate
  // backed by fixed-executor transfer evidence; local experiments remain optional.
  // Explicit --generalization-policy always wins.
  let policy: GeneralizationPolicyName;
  try {
    policy = resolveGeneralizationPolicy(values, githubEnabled);
  } catch (err) {
    console.error((err as Error).message);
    return;
  }
  if (policy !== "optional") {
    console.log(
      `[Evolution] Generalization policy: ${policy} (fixed-executor transfer evidence is required for eligibility).`,
    );
  }
  // v2.4: continuous-mode knobs, validated BEFORE any store is opened so a
  // typo cannot leak open SQLite handles.
  let intervalMs = 60 * 60 * 1000;
  let maxCycles: number | undefined;
  if (values.interval !== undefined) {
    intervalMs = parseInt(values.interval as string, 10);
    if (Number.isNaN(intervalMs) || intervalMs <= 0) {
      console.error("--interval must be a positive number of milliseconds.");
      return;
    }
  }
  if (values["max-cycles"] !== undefined) {
    maxCycles = parseInt(values["max-cycles"] as string, 10);
    if (Number.isNaN(maxCycles) || maxCycles < 1) {
      console.error("--max-cycles must be a positive integer.");
      return;
    }
  }
  const stateDir = workspaceStateDir(root);
  const experienceStore = new ExperienceStore(join(stateDir, "experience.db"));
  // v2.3.2: the mutate path PERSISTS experiment provenance. Without a
  // store-backed controller the full lifecycle ran in-memory and was lost at
  // process exit, while --experiments read an empty database.
  const experimentStore = new ExperimentStore(join(stateDir, "experiments.db"));
  const experimentDir = (values["experiment-dir"] as string | undefined) ?? join(stateDir, "experiments");
  const limit = values.limit ? parseInt(values.limit as string, 10) : 20;
  const parentRef = (values.parent as string) || "HEAD";
  // Production actuator wiring: the strategy decides WHO proposes the mutation
  // (heuristic planner vs the engineering agent); the verification profile
  // decides WHAT the candidate must survive; linkNodeModulesFrom makes real
  // gates executable inside the worktree. Explicit executor always wins over
  // the engine's agentRuntime auto-wiring, keeping gate control in one place.
  const strategy = buildMutationStrategy(strategyName, cfg);
  // v2.3.3: runtime activation is on by default. It wires the manifest-file
  // RuntimeActivationController plus the harness registry so the acceptance path
  // records real H0→Hn lineage. --no-activate-runtime keeps this run local.
  const activationRequested = resolveRuntimeActivationEnabled(values);
  const registry = activationRequested ? new HarnessRegistry(join(stateDir, "evolution.db")) : undefined;
  const activationController = activationRequested
    ? new ManifestRuntimeActivationController({ repoRoot, registry })
    : undefined;
  const engine = new ClosedLoopEngine({
    experienceStore,
    experimentController: new ExperimentController({ store: experimentStore }),
    ...(registry ? { registry } : {}),
    ...(activationController ? { runtimeActivation: activationController } : {}),
    generalizationPolicy: policy,
    mutationExecutor: new GitWorktreeMutationExecutor({
      verifyCommands: profile.commands,
      linkNodeModulesFrom: repoRoot,
      ...(strategy ? { strategy } : {}),
    }),
    ...(githubEnabled && githubCfg
      ? {
          githubDelivery: new GitHubDeliveryAdapter(
            {
              owner: githubCfg.owner,
              repo: githubCfg.repo,
              baseBranch: githubCfg.baseBranch,
              ...(githubCfg.token ? { token: githubCfg.token } : {}),
            },
            {},
          ),
        }
      : {}),
  });

  /**
   * v2.4: ONE full observe→mutate cycle as a reusable unit. Episode loading
   * and FULL experience ingestion happen INSIDE the cycle so that (a) every
   * completed episode feeds the experience store — not just the recent
   * diagnosis window — and (b) continuous mode picks up episodes recorded
   * while earlier cycles ran. `skipped` marks a no-target tick (idle, not a
   * cycle failure).
   */
  const runCycle = async (): Promise<EvolutionCycleResult> => {
    const allEpisodes = loadAllEpisodes(root);
    await ingestParentExperience(engine, allEpisodes, repoRoot, parentRef);
    const episodes = allEpisodes.slice(0, limit);
    const observation = engine.observe(episodes);
    if (!observation.target || !observation.mutationScope || observation.diagnoses.length === 0) {
      return {
        ok: false,
        skipped: true,
        detail: "no operationalizable target from recent episodes; refusing to mutate blind",
      };
    }
    const diagnosis = observation.diagnoses[0];
    const categories = observation.plan?.recommendedBenchmarkCategories ?? [];

    // Baseline: the parent repository benchmarked in a subprocess BEFORE the
    // mutation, so the two-stage comparison measures real deltas B(H0) vs
    // B(H1). Requires the checkout to sit at the parent commit (the default
    // --parent HEAD); --skip-baseline opts out explicitly.
    let baselineResults: TaskExecutionResult[] = [];
    if (values.benchmark && !values["skip-baseline"]) {
      console.log(`[Evolution] Benchmarking parent (baseline) across [${categories.join(", ") || "all"}]...`);
      baselineResults = await runBenchmarkInDir(repoRoot, repoRoot, categories);
    }
    // Captured so the experiment artifact can carry the raw candidate runs.
    let candidateResults: TaskExecutionResult[] = [];

    const experimentId = `exp-${Date.now()}`;
    const outcome = await engine.runEvolutionCycle({
      experimentId,
      parentHarnessId: "HEAD",
      parentCommit: parentRef,
      candidateHarnessId: `H${Date.now().toString(36)}`,
      repoRoot,
      target: observation.target,
      diagnosis,
      scope: observation.mutationScope,
      baselineResults,
      evaluateCandidate: async (artifact) => {
        if (!values.benchmark) {
          throw new Error(
            "Candidate evaluation requires --benchmark (subprocess benchmark of the mutated worktree); pass a custom evaluateCandidate for other suites.",
          );
        }
        console.log(`[Evolution] Benchmarking candidate worktree across [${categories.join(", ") || "all"}]...`);
        candidateResults = await runBenchmarkInDir(repoRoot, artifact.workspace.worktreePath, categories);
        return candidateResults;
      },
      ...(githubEnabled && githubCfg ? { github: {} } : {}),
    });
    console.log(formatMutationResult(outcome));
    // Runtime activation is enabled by default; the gate refuses without verified evidence.
    const activation = activationController
      ? await activateRuntimeIfNeeded(engine, activationController, experimentId, outcome, activationRequested)
      : null;
    writeCycleArtifact(outcome, {
      experimentId,
      strategyName: strategyName ?? "heuristic",
      model: cfg.model,
      tier: cfg.tier,
      verifyProfileName: profile.name,
      benchmarkCategories: categories,
      baselineAbsent: !values.benchmark || !!values["skip-baseline"],
      target: observation.target,
      diagnosis,
      scope: observation.mutationScope,
      baselineResults,
      candidateResults,
      experimentDir,
      activation,
    });
    if (outcome.ok) {
      const record = outcome.outcome.experiment;
      return {
        ok: true,
        detail: `candidate ${record.candidate.harness} → decision=${record.decision.result} state=${record.lifecycle.state}`,
      };
    }
    return { ok: false, detail: `stage ${outcome.stage}: ${outcome.reason}` };
  };

  try {
    if (values.continuous) {
      // v2.4: persistent, policy-controlled evolution. The worker re-observes
      // the evidence on every tick and only runs a cycle when a capability
      // target with sufficient confidence exists — it never mutates because
      // a schedule fired.
      const worker = new EvolutionWorker({
        observe: async () => {
          const allEpisodes = loadAllEpisodes(root);
          await ingestParentExperience(engine, allEpisodes, repoRoot, parentRef);
          return { target: engine.observe(allEpisodes.slice(0, limit)).target };
        },
        runCycle,
        intervalMs,
        ...(maxCycles !== undefined ? { maxCycles } : {}),
      });
      const onSigint = () => {
        console.log("\n[Evolution] Interrupted — finishing the current step, then exiting.");
        worker.stop();
      };
      process.once("SIGINT", onSigint);
      try {
        await worker.run();
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    } else {
      const outcome = await runCycle();
      if (outcome.skipped) {
        console.error("No operationalizable target from recent episodes; refusing to mutate blind.");
      }
    }
  } finally {
    experienceStore.close();
    experimentStore.close();
    registry?.close();
  }
}

/**
 * Composes and writes the immutable experiment artifact for one completed
 * cycle (success OR stage failure). A filesystem failure here must not mask
 * the cycle result: the SQLite record already persists the provenance.
 */
function writeCycleArtifact(
  outcome: Awaited<ReturnType<ClosedLoopEngine["runEvolutionCycle"]>>,
  ctx: {
    experimentId: string;
    strategyName: string;
    model: string;
    tier: string;
    verifyProfileName: string;
    benchmarkCategories: string[];
    baselineAbsent: boolean;
    target: ReturnType<ClosedLoopEngine["observe"]>["target"];
    diagnosis: ReturnType<ClosedLoopEngine["observe"]>["diagnoses"][number];
    scope: ReturnType<ClosedLoopEngine["observe"]>["mutationScope"];
    baselineResults: TaskExecutionResult[];
    candidateResults: TaskExecutionResult[];
    experimentDir: string;
    activation: ExperimentArtifactInput["activation"];
  },
): void {
  try {
    const envelope = buildExperimentArtifact({
      experimentId: ctx.experimentId,
      strategyName: ctx.strategyName,
      model: ctx.model,
      tier: ctx.tier,
      verifyProfileName: ctx.verifyProfileName,
      benchmarkCategories: ctx.benchmarkCategories,
      baselineAbsent: ctx.baselineAbsent,
      target: ctx.target,
      diagnosis: ctx.diagnosis,
      scope: ctx.scope,
      record: outcome.ok ? outcome.outcome.experiment : null,
      mutation: outcome.mutation,
      baselineResults: ctx.baselineResults,
      candidateResults: ctx.candidateResults,
      github:
        outcome.ok && outcome.github
          ? {
              branch: outcome.github.handle.branch,
              prNumber: outcome.github.handle.prNumber,
              prUrl: outcome.github.handle.prUrl,
              ciPassed: outcome.github.ci.passed,
              reviewApproved: outcome.github.facts.review?.approved ?? false,
              accepted: outcome.github.accepted,
              mergeStatus: outcome.github.merge?.status ?? "not-attempted",
              mergeCommitSha: outcome.github.merge?.status === "merged" ? outcome.github.merge.mergeCommitSha : null,
              contentVerified: outcome.github.verification?.contentMatches ?? null,
              merged: outcome.github.merged,
            }
          : null,
      localDelivery:
        outcome.ok && !outcome.github && outcome.outcome.delivery
          ? { branchName: outcome.outcome.delivery.branchName, prTitle: outcome.outcome.delivery.prTitle }
          : null,
      failure: outcome.ok ? null : { stage: outcome.stage, reason: outcome.reason },
      activation: ctx.activation,
    });
    const path = writeExperimentArtifact(ctx.experimentDir, envelope);
    console.log(`[Evolution] Experiment artifact (immutable): ${path}`);
  } catch (err) {
    console.error(
      `[Evolution] WARNING: could not write experiment artifact: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * v2.4: --autonomous as a REAL execution mode. The flag was previously
 * declared in the CLI options and then silently ignored; now it dispatches:
 *
 *   with --repo    → the full closed loop (ingest ALL experience → observe
 *                    failures AND successes → target → mutation →
 *                    verification → benchmark → delivery → activation),
 *                    exactly the --mutate path, optionally --continuous;
 *   without --repo → an observation + planning cycle that still ingests every
 *                    completed episode and reports the target it WOULD chase,
 *                    so the next run with --repo starts from formed evidence.
 */
async function executeAutonomousCommand(root: string, values: Record<string, unknown>): Promise<void> {
  if (typeof values.repo === "string") {
    await executeMutationCommand(root, values);
    return;
  }
  if (values.continuous) {
    console.error("--continuous requires --repo (the mutation loop needs a harness repository to mutate).");
    return;
  }
  const stateDir = workspaceStateDir(root);
  const experienceStore = new ExperienceStore(join(stateDir, "experience.db"));
  const experimentStore = new ExperimentStore(join(stateDir, "experiments.db"));
  const engine = new ClosedLoopEngine({
    experienceStore,
    experimentController: new ExperimentController({ store: experimentStore }),
  });
  const limit = values.limit ? parseInt(values.limit as string, 10) : 20;

  try {
    // v2.4: the experience feed covers EVERY completed episode, not just the
    // diagnosis window — accumulation is independent of mutation success.
    const allEpisodes = loadAllEpisodes(root);
    await ingestParentExperience(engine, allEpisodes, root, "HEAD");
    const episodes = allEpisodes.slice(0, limit);
    const observation = engine.observe(episodes);
    const successDriven = observation.diagnoses.filter(
      (d) => d.failureClass === "efficiency_opportunity" || d.failureClass === "success_pattern",
    );

    console.log("=== Autonomous Cycle (v2.4) ===");
    console.log(
      `[Evolution] Episodes: ${allEpisodes.length} total · ${episodes.length} in diagnosis window · experience records: ${experienceStore.count()}`,
    );
    console.log(formatDiagnosesText(observation.diagnoses, observation.plan, episodes.length));
    if (successDriven.length > 0) {
      console.log(
        `\n[Evolution] Success-driven signals: ${successDriven.length} diagnosis(esis) from SUCCESSFUL episodes (efficiency opportunities + comparative patterns).`,
      );
    }
    console.log("");
    console.log(formatTargetText(observation));
    if (observation.target) {
      console.log(
        "\n[Evolution] Target formed. Re-run with --repo <path> (plus --strategy/--benchmark as needed) to execute the mutation cycle.",
      );
    } else {
      console.log(
        "\n[Evolution] No operationalizable target yet — keep accumulating episodes; the loop refuses to mutate blind.",
      );
    }
    console.log("");
    console.log(formatExperienceText(engine.digestExperience()));
  } finally {
    experienceStore.close();
    experimentStore.close();
  }
}

async function executeMonitorCommand(root: string, values: Record<string, unknown>): Promise<void> {
  void root;
  const telemetryPath = values.telemetry as string | undefined;
  const harnessId = values.harness as string | undefined;
  const experimentId = values.experiment as string | undefined;
  if (!telemetryPath || (!harnessId && !experimentId)) {
    console.error(
      "--monitor requires --telemetry <file.jsonl> and --harness <id> (or --experiment <id> with --watch).",
    );
    return;
  }

  if (values.watch) {
    // v2.4 continuous monitoring: tail the telemetry file and evaluate on
    // every new sample. With --experiment, evaluation runs through the
    // closed-loop engine, which drives ACTIVE → REGRESSED → ROLLBACK
    // automatically; with only --harness it is reporting-only.
    const stateDir = workspaceStateDir(findWorkspaceRoot(process.cwd()));
    const experimentStore = new ExperimentStore(join(stateDir, "experiments.db"));
    const monitor = new ActivationMonitor();
    let engine: ClosedLoopEngine | null = null;
    if (experimentId) {
      const controller = new ExperimentController({ store: experimentStore });
      engine = new ClosedLoopEngine({ experimentController: controller, monitor });
      const hydrated = controller.hydrate(experimentId);
      if (!hydrated) {
        console.error(
          `[Monitor] Unknown experiment "${experimentId}" in ${join(stateDir, "experiments.db")} — run "nexum evolve --experiments" to list ids.`,
        );
        experimentStore.close();
        return;
      }
      console.log(
        `[Monitor] Monitoring experiment ${experimentId} (harness ${hydrated.candidate.harness}, state ${hydrated.lifecycle.state}) with automatic rollback on regression.`,
      );
    }
    let intervalMs = 60_000;
    if (values.interval !== undefined) {
      intervalMs = parseInt(values.interval as string, 10);
      if (Number.isNaN(intervalMs) || intervalMs <= 0) {
        console.error("--interval must be a positive number of milliseconds.");
        experimentStore.close();
        return;
      }
    }
    const service = new ContinuousMonitorService({
      telemetryPath,
      monitor,
      evaluate: (m) => (engine ? engine.evaluateActivationLive(experimentId!) : m.evaluate(harnessId!)),
      intervalMs,
    });
    const onSigint = () => service.stop();
    process.once("SIGINT", onSigint);
    try {
      await service.start();
    } finally {
      process.removeListener("SIGINT", onSigint);
      experimentStore.close();
    }
    return;
  }

  if (!harnessId) {
    console.error("--monitor (one-shot) requires --harness <id>.");
    return;
  }
  const monitor = new ActivationMonitor();
  for (const sample of loadTelemetrySamples(telemetryPath)) {
    monitor.ingest(sample);
  }
  // Without a registered envelope the monitor reports 'insufficient samples'
  // honestly; production callers register envelopes via the engine.
  console.log(formatActivationHealth(monitor.evaluate(harnessId)));
}

async function executeClosedLoopCommand(root: string, values: Record<string, unknown>): Promise<void> {
  const stateDir = workspaceStateDir(root);
  const experienceStore = new ExperienceStore(join(stateDir, "experience.db"));
  const experimentStore = new ExperimentStore(join(stateDir, "experiments.db"));
  const engine = new ClosedLoopEngine({ experienceStore });
  const limit = values.limit ? parseInt(values.limit as string, 10) : 20;

  try {
    if (values.experience) {
      console.log(formatExperienceText(engine.digestExperience()));
      return;
    }
    if (values.experiments) {
      console.log(formatExperimentsText(experimentStore.listAll()));
      return;
    }
    if (values.report) {
      console.log(formatHealthReport(metricsFromExperimentStore(experimentStore).report()));
      return;
    }
    // Default v2 view: observation pipeline with target formation.
    const episodes = loadRecentEpisodes(root, limit);
    const observation = engine.observe(episodes);
    if (values.target) {
      console.log(formatTargetText(observation));
    } else {
      console.log(formatDiagnosesText(observation.diagnoses, observation.plan, episodes.length));
      console.log("");
      console.log(formatTargetText(observation));
    }
  } finally {
    experienceStore.close();
    experimentStore.close();
  }
}

export async function runEvolutionCli(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: CLI_OPTIONS, allowPositionals: true });
  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }

  // Task catalogue commands are dispatched before the rest so they do not
  // require a workspace state directory (except --task-continuous, which
  // resolves the workspace for its sweep wiring below).
  const taskCliOpts = {
    taskCatalog: values["task-catalog"] as boolean | undefined,
    taskValidate: values["task-validate"] as boolean | undefined,
    taskShow: values["task-show"] as string | undefined,
    taskBacklog: values["task-backlog"] as boolean | undefined,
    taskPrioritize: values["task-prioritize"] as boolean | undefined,
    taskRun: values["task-run"] as string | undefined,
    taskContinuous: values["task-continuous"] as boolean | undefined,
    taskCategory: values["task-category"] as string | undefined,
    taskPriority: values["task-priority"] as string | undefined,
  };
  if (isTaskCliInvocation(taskCliOpts)) {
    const code = values["task-continuous"]
      ? await runTaskContinuous({
          intervalMs: values.interval ? parseInt(values.interval as string, 10) : undefined,
          maxTasks: values["max-cycles"] ? parseInt(values["max-cycles"] as string, 10) : undefined,
        })
      : await runTaskCli(taskCliOpts);
    process.exit(code);
  }

  const root = findWorkspaceRoot(process.cwd());

  // v2.4: --autonomous is dispatched for real (previously the flag was
  // accepted and silently ignored). With --repo it runs the full mutation
  // cycle; without it, an observation + planning cycle over ALL accumulated
  // experience.
  if (values.autonomous) {
    await executeAutonomousCommand(root, values);
    return;
  }
  if (values.mutate) {
    await executeMutationCommand(root, values);
    return;
  }
  if (values.monitor) {
    await executeMonitorCommand(root, values);
    return;
  }

  // v2 closed-loop commands use their own stores and engine.
  if (values.target || values.experience || values.experiments || values.report) {
    await executeClosedLoopCommand(root, values);
    return;
  }

  const stateDir = workspaceStateDir(root);
  mkdirSync(stateDir, { recursive: true });
  const registry = new HarnessRegistry(join(stateDir, "evolution.db"));
  const engine = new EvolutionEngine({ registry });
  try {
    await executeCommand(engine, values, root);
  } finally {
    registry.close();
  }
}
