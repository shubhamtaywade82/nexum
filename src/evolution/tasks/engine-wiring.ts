/**
 * Engine wiring for the Evolution Task Catalogue.
 *
 * Connects TaskRunner's seams to the real closed-loop machinery: the
 * ClosedLoopEngine's observation pipeline (failure diagnoser + v2.4 success
 * analyzer + target formation + planning), the workspace experience store,
 * and the report/backlog SQLite stores. Until this module existed, the
 * catalogue CLI could list, validate, and rank tasks but --task-run was a
 * stub: the runner's onDiagnose hook had no concrete implementation outside
 * tests.
 *
 * What runs today:
 *   - diagnose tasks: end-to-end. One observation over the workspace's
 *     episodes → a 12-section report validated against evaluation.yml →
 *     committed to report-store.db → backlog transitioned to investigated.
 *   - experiment / implement tasks: still engine-gated (they require the
 *     mutation executor worktree machinery, which stays on the explicit
 *     --mutate path where its safety controls live).
 *
 * The evidence functions are computed from a single observation snapshot so
 * every consumer in one CLI process sees the same evidence window.
 *
 * Architecture: docs/evolution/architecture.md §Dispatch
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceStateDir } from "../../platform/paths.js";
import { loadCatalog } from "./task-loader.js";
import { TaskRegistry } from "./task-registry.js";
import { BacklogTracker } from "./backlog-tracker.js";
import { TaskRunner, RunnerDeps, DiagnoseResult } from "./task-runner.js";
import { hypothesisHash } from "./task-validator.js";
import { PoliciesFile, SchedulesFile, TaskDefinition, Report, IdentifiedGap } from "./types.js";
import { ReportGenerator } from "../reporting/report-generator.js";
import { ReportStore } from "../reporting/report-store.js";
import { ClosedLoopEngine, ClosedLoopDiagnosis } from "../engine-v2.js";
import { ExperienceStore } from "../experience/experience-store.js";
// Cycle note: evolution/cli.ts (which dispatches into this module via
// tasks/cli.ts) also exports loadAllEpisodes. The import below is safe in
// ESM because loadAllEpisodes is a hoisted function declaration and is only
// CALLED at runtime inside buildEngineWiring, never during module init.
import { loadAllEpisodes } from "../cli.js";
import { Episode } from "../../learning/types.js";
import { HarnessComponent, HarnessDiagnosis } from "../types.js";

export interface EngineWiringOptions {
  /** Workspace root: where episodes, experience, and state DBs live. */
  workspaceRoot: string;
  /**
   * Repository root for commit resolution (the "evaluated commit" of a
   * report). Defaults to workspaceRoot. In the CLI these are the same.
   */
  repoRoot?: string;
  /**
   * Number of most recent episodes in the diagnosis window (the same
   * default the --diagnose/--autonomous paths use). Default 20.
   */
  diagnosisLimit?: number;
  /** Resolved current commit; overrides git when provided (tests). */
  currentCommit?: string;
  /** Episodes to observe; overrides the workspace lesson store (tests). */
  episodes?: Episode[];
}

export interface EngineWiring {
  deps: RunnerDeps;
  registry: TaskRegistry;
  policies: PoliciesFile;
  schedules: SchedulesFile;
  backlog: BacklogTracker;
  reportStore: ReportStore;
  /** A ready-to-run runner over the wired deps. */
  runner: TaskRunner;
  close(): void;
}

/**
 * Builds RunnerDeps backed by the real evolution machinery and opens the
 * SQLite stores. Always call close() on the returned wiring.
 */
export function buildEngineWiring(opts: EngineWiringOptions): EngineWiring {
  const root = opts.workspaceRoot;
  const repoRoot = opts.repoRoot ?? root;
  const limit = opts.diagnosisLimit ?? 20;
  const stateDir = workspaceStateDir(root);
  mkdirSync(stateDir, { recursive: true });

  const { catalog, policies, schedules } = loadCatalog();
  const registry = new TaskRegistry(catalog.tasks);
  const backlog = new BacklogTracker(join(stateDir, "task-catalogue.db"));
  const reportStore = new ReportStore(join(stateDir, "report-store.db"));
  const reportGenerator = new ReportGenerator();
  const experienceStore = new ExperienceStore(join(stateDir, "experience.db"));

  const engine = new ClosedLoopEngine({ experienceStore });
  const episodes = opts.episodes ?? loadWorkspaceEpisodes(root);
  // Best-effort experience ingestion, mirroring the --autonomous path:
  // the feed must never break a catalogue run.
  try {
    if (episodes.length > 0) {
      engine.ingestExperience(episodes, opts.currentCommit ?? "unknown");
    }
  } catch {
    /* evidence accumulation is best-effort by contract */
  }
  const observation = engine.observe(episodes.slice(0, limit));

  // Hypothesis-hash registry per task, accumulated within this process.
  // Cross-restart protection is the no_new_evidence anti-rule (the backlog
  // carries lastEvaluatedCommit + evidenceWindowTo), NOT a seeded duplicate
  // set: seeding the default hypothesis from prior reports would block every
  // legitimate re-diagnosis after new evidence arrives, because
  // duplicate_hypothesis fires unconditionally.
  const knownHashes = new Map<string, Set<string>>();

  const getCurrentCommit = async (): Promise<string> => {
    if (opts.currentCommit) return opts.currentCommit;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: repoRoot,
      });
      const sha = stdout.trim();
      return sha.length >= 40 ? sha : "unknown";
    } catch {
      return "unknown";
    }
  };

  const deps: RunnerDeps = {
    registry,
    policies,
    schedules,
    backlog,
    reportGenerator,
    reportStore,
    getCurrentCommit,
    getNewEvidenceCount: (taskId) => {
      const entry = backlog.get(taskId);
      const since = entry?.evidenceWindowTo ?? 0;
      return episodes.filter((ep) => (ep.startedAt ?? 0) > since).length;
    },
    getObservedFrequency: () => {
      if (episodes.length === 0) return 0;
      const diagnosed = collectDiagnosedEpisodeIds(observation.diagnoses);
      return diagnosed.size / episodes.length;
    },
    getEvidenceConfidence: (taskId) => reportStore.latestForTask(taskId)?.confidence.overall ?? 0,
    getKnownHypothesisHashes: (taskId) => {
      let set = knownHashes.get(taskId);
      if (!set) {
        set = new Set<string>();
        knownHashes.set(taskId, set);
      }
      return set;
    },
    onDiagnose: async (task): Promise<DiagnoseResult> => {
      if (episodes.length === 0) {
        return {
          partial: {},
          commit: false,
        };
      }
      const experienceCount = experienceStore.count();
      const result: DiagnoseResult = {
        partial: buildPartialReport(task, observation, episodes.slice(0, limit), experienceCount),
        commit: observation.diagnoses.length > 0,
      };
      if (result.commit) {
        // Within this process the task's default hypothesis is now spent —
        // a second runOne must reformulate (or bring new evidence, which
        // resets the window via the backlog instead).
        const set = knownHashes.get(task.id) ?? new Set<string>();
        set.add(hypothesisHash(task.objective));
        knownHashes.set(task.id, set);
      }
      return result;
    },
    onExperiment: async () => {
      throw new Error(
        "experiment tasks are not runnable from the catalogue CLI yet: they mount the mutation executor in an isolated worktree. Use `nexum evolve --mutate --repo <path>` (the closed-loop engine path) until task-level experiment dispatch lands.",
      );
    },
    onImplement: async () => {
      throw new Error(
        "implement tasks are not runnable from the catalogue CLI yet: they deliver through the GitHub adapter under acceptance control. Use `nexum evolve --mutate --repo <path> --github` until task-level implement dispatch lands.",
      );
    },
  };

  return {
    deps,
    registry,
    policies,
    schedules,
    backlog,
    reportStore,
    runner: new TaskRunner(deps),
    close() {
      backlog.close();
      reportStore.close();
      experienceStore.close();
    },
  };
}

/** Loads every persisted episode from the workspace lesson database. */
function loadWorkspaceEpisodes(root: string): Episode[] {
  return loadAllEpisodes(root);
}

/** Episode ids mentioned anywhere in a diagnosis's evidence details. */
function collectDiagnosedEpisodeIds(diagnoses: HarnessDiagnosis[]): Set<string> {
  const ids = new Set<string>();
  for (const d of diagnoses) {
    for (const e of d.evidence) {
      const detail = e.detail as Record<string, unknown> | undefined;
      const id = detail?.episodeId;
      if (typeof id === "string") ids.add(id);
      const efficient = detail?.efficientEpisodes;
      const wasteful = detail?.wastefulEpisodes;
      if (Array.isArray(efficient)) for (const x of efficient) if (typeof x === "string") ids.add(x);
      if (Array.isArray(wasteful)) for (const x of wasteful) if (typeof x === "string") ids.add(x);
    }
  }
  return ids;
}

/** Static map: harness component → the files that implement it. */
const COMPONENT_FILES: Record<HarnessComponent, string[]> = {
  execution: ["src/cli/agent.ts", "src/runtime/"],
  tools: ["src/tools/", "src/cli/agent-tools.ts"],
  context: ["src/runtime/context/"],
  state: ["src/runtime/state/"],
  lifecycle: ["src/runtime/lifecycle/"],
  verification: ["src/runtime/critic/"],
  routing: ["src/models/router/"],
  memory: ["src/memory/", "src/cli/agent-learning.ts"],
};

/**
 * Maps one closed-loop observation onto the report contract's partial
 * sections. Every value is derived from the observation or the task
 * definition — nothing is invented. Sections the task declares required
 * are non-empty by construction whenever at least one diagnosis exists
 * (commit is false otherwise).
 */
export function buildPartialReport(
  task: TaskDefinition,
  observation: ClosedLoopDiagnosis,
  windowEpisodes: Episode[],
  experienceCount: number,
): Partial<Report> {
  const { diagnoses, target, plan, mutationScope, successPatterns } = observation;

  const implicated = [...new Set(diagnoses.map((d) => d.component))];
  const files = [...new Set(implicated.flatMap((c) => COMPONENT_FILES[c] ?? []))];
  const failureClasses = [...new Set(diagnoses.map((d) => d.failureClass))];

  const gaps: IdentifiedGap[] = diagnoses.map((d) => ({
    description: `[${d.failureClass}] ${d.rootCause}`,
    evidence: [...episodeIdsOf(d), ...d.evidence.map((e) => e.summary)],
    severity: severityFor(d.confidence),
  }));

  const rootCauses = diagnoses.map((d) => ({
    gapRef: `[${d.failureClass}] ${d.rootCause}`,
    cause: d.rootCause,
    confidence: d.confidence,
  }));

  const proposals = dedupeBy(diagnoses, (d) => d.proposedFix).map((d) => ({
    title: `Address ${d.failureClass} in the ${d.component} component`,
    description: d.proposedFix,
    // Reference every gap that shares this fix, so the report's
    // proposal → root-cause → gap chain stays complete.
    rootCauseRefs: diagnoses
      .filter((x) => x.proposedFix === d.proposedFix)
      .map((x) => `[${x.failureClass}] ${x.rootCause}`),
    estimatedComplexity: (mutationScope?.kind === "compound" ? "large" : "medium") as "large" | "medium",
  }));

  const impactMean = (pick: (d: HarnessDiagnosis) => number): number =>
    diagnoses.length === 0 ? 0 : diagnoses.reduce((acc, d) => acc + pick(d), 0) / diagnoses.length;

  const successPatternCount = successPatterns?.patterns.length ?? 0;
  const overall = diagnoses.length === 0 ? 0 : Math.max(...diagnoses.map((d) => d.confidence));

  const decision: Report["recommendation"]["decision"] =
    target && plan ? "implement" : diagnoses.length > 0 ? "investigate_further" : "no_change";

  return {
    current_implementation: {
      files,
      classes: [],
      methods: [],
      entry_points: ["bin/cli.js"],
    },
    current_behavior: {
      summary:
        `${windowEpisodes.length} episode(s) analyzed → ${diagnoses.length} diagnosis(esis) across ` +
        `${implicated.length || 1} component(s) (${implicated.join(", ") || "none"}); ` +
        `${successPatternCount} success pattern(s) from ${experienceCount} experience record(s). ` +
        `Failure classes observed: ${failureClasses.join(", ") || "none"}.`,
      observed_paths: failureClasses,
    },
    identified_gaps: { gaps },
    root_cause_analysis: { root_causes: rootCauses },
    improvement_proposals: { proposals },
    expected_impact: {
      capability_delta: impactMean((d) => d.expectedImpact.capability),
      reliability_delta: impactMean((d) => d.expectedImpact.reliability),
      cost_delta: impactMean((d) => d.expectedImpact.cost),
      measurement_basis: `mean expected-impact across ${diagnoses.length} engine diagnosis(esis)`,
    },
    risk_assessment: {
      regression_risks:
        implicated.length > 0
          ? implicated.map(
              (c) => `${c} changes can regress existing behavior — protected evaluation + rollback path required`,
            )
          : ["None identified — no harness change is proposed."],
      security_risks: [],
      mitigation_notes: [
        "Any follow-up experiment runs in an isolated worktree with verification gates (evolution-policy §4).",
      ],
    },
    implementation_plan: {
      files_likely_to_change: plan ? (COMPONENT_FILES[plan.targetComponent] ?? []) : files,
      components_likely_to_change: plan ? [plan.targetComponent] : implicated,
      estimated_loc: proposals.length * 80,
    },
    verification_plan: {
      tests_required: plan
        ? plan.recommendedBenchmarkCategories.map((c) => `benchmark category: ${c}`)
        : ["unit: existing evolution suite"],
      benchmarks_required: plan?.recommendedBenchmarkCategories ?? [],
      held_out_evaluation: "optional",
    },
    recommendation: {
      decision,
      rationale:
        decision === "implement"
          ? `An operationalizable improvement target formed from the evidence (capability: ${target!.capability}; ${target!.measurableMetrics.join(", ")}) with a plan targeting the ${plan!.targetComponent} component.`
          : decision === "investigate_further"
            ? "Gaps are evidenced but the evidence is not yet strong enough to operationalize an improvement target (Aspire: vague targets waste the improvement budget)."
            : "No gaps found in the diagnosis window.",
    },
    confidence: {
      overall,
      // The ReportGenerator recomputes both of these from the gap evidence
      // (de-duplicated episode ids) and the finalize options; the values
      // here mirror that computation so the partial is contract-complete.
      independent_samples: new Set(gaps.flatMap((g) => g.evidence.filter(looksLikeEpisodeId))).size,
      evidence_window: {
        from: new Date(Math.min(...windowEpisodes.map((e) => e.startedAt ?? 0))).toISOString(),
        to: new Date(Math.max(...windowEpisodes.map((e) => e.endedAt ?? e.startedAt ?? 0))).toISOString(),
      },
      limitations: [
        `diagnosis window covers the ${windowEpisodes.length} most recent episode(s)`,
        "confidence ceiling is capped by the number of independent episode samples",
      ],
    },
  };
}

function episodeIdsOf(d: HarnessDiagnosis): string[] {
  const ids: string[] = [];
  for (const e of d.evidence) {
    const detail = e.detail as Record<string, unknown> | undefined;
    const id = detail?.episodeId;
    if (typeof id === "string") ids.push(id);
    const efficient = detail?.efficientEpisodes;
    const wasteful = detail?.wastefulEpisodes;
    if (Array.isArray(efficient)) for (const x of efficient) if (typeof x === "string") ids.push(x);
    if (Array.isArray(wasteful)) for (const x of wasteful) if (typeof x === "string") ids.push(x);
  }
  return [...new Set(ids)];
}

function severityFor(confidence: number): IdentifiedGap["severity"] {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function looksLikeEpisodeId(s: string): boolean {
  if (!s) return false;
  if (s.startsWith("/") || s.startsWith("./")) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return false;
  if (s.includes(":") && s.includes(".")) return false;
  return true;
}
