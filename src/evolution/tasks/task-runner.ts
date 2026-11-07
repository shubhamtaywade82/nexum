/**
 * TaskRunner — picks an eligible task and executes it in the mode declared by
 * the task. Mode determines permissions, not the task itself.
 *
 * The runner is deliberately small: it dispatches to existing evolution
 * components (HarnessDiagnoser, ExperienceStore, AgentMutationStrategy,
 * GitWorktreeMutationExecutor, ReportGenerator) rather than reimplementing
 * them. Catalogue tasks compose the existing primitives; they do not replace
 * them.
 *
 * Architecture: docs/evolution/architecture.md
 * Safety:       docs/evolution/evolution-policy.md §1, §4
 */

import { BacklogTracker } from "./backlog-tracker.js";
import { TaskPrioritizer, PrioritizationInput, PrioritizationOutput } from "./task-prioritizer.js";
import { TaskRegistry } from "./task-registry.js";
import { validateTaskRun, hypothesisHash, ValidationResult } from "./task-validator.js";
import { PoliciesFile, SchedulesFile, TaskDefinition } from "./types.js";
import { Report, ReportRef } from "./types.js";
import { ReportGenerator } from "../reporting/report-generator.js";
import { ReportStore } from "../reporting/report-store.js";

/**
 * The runtime context the runner needs. The caller (CLI or closed-loop engine)
 * is responsible for wiring concrete implementations; the runner does not
 * import them directly, so tests can substitute fakes.
 */
export interface RunnerDeps {
  registry: TaskRegistry;
  policies: PoliciesFile;
  schedules: SchedulesFile;
  backlog: BacklogTracker;
  reportGenerator: ReportGenerator;
  reportStore: ReportStore;
  /** Returns the current HEAD commit of the repository. */
  getCurrentCommit: () => Promise<string>;
  /** Returns the number of new evidence items since the last report for a task. */
  getNewEvidenceCount: (taskId: string) => number;
  /** Returns the observed frequency of the problem in the evidence window. */
  getObservedFrequency: (taskId: string) => number;
  /** Returns the confidence from the most recent report, or 0 if none. */
  getEvidenceConfidence: (taskId: string) => number;
  /**
   * Returns the hashes of hypotheses already evaluated for this task. The
   * runner maintains this set across the process lifetime; persistence across
   * restarts is the caller's responsibility (the experiment store carries it).
   */
  getKnownHypothesisHashes: (taskId: string) => Set<string>;
  /**
   * Hook called when a diagnose task is dispatched. Implementations should
   * call HarnessDiagnoser / ExperienceStore / etc. and return a partial report
   * that the ReportGenerator can finalize.
   */
  onDiagnose: (task: TaskDefinition) => Promise<DiagnoseResult>;
  /**
   * Hook called when an experiment task is dispatched. Implementations should
   * mount the mutation executor in an isolated worktree (no push, no
   * activation) and return an experiment id.
   */
  onExperiment: (task: TaskDefinition, hypothesis: string) => Promise<ExperimentResult>;
  /**
   * Hook called when an implement task is dispatched. Implementations should
   * mount the mutation executor in an isolated branch, run verification, and
   * (if --github is set) push via the GitHub delivery adapter. Activation
   * still flows through the acceptance controller, not here.
   */
  onImplement: (task: TaskDefinition, hypothesis: string) => Promise<ImplementResult>;
}

export interface DiagnoseResult {
  /** The partial report content produced by the diagnostician. */
  partial: Partial<Report>;
  /** Whether the runner should commit the report to the store. */
  commit: boolean;
}

export interface ExperimentResult {
  experimentId: string;
  hypothesis: string;
  /** Whether the experiment is ready for evaluation. */
  readyForEvaluation: boolean;
}

export interface ImplementResult {
  experimentId: string;
  hypothesis: string;
  /** Whether the candidate was delivered (PR opened). Activation is separate. */
  delivered: boolean;
}

export interface RunOptions {
  /** Restrict the run to a specific task id. */
  taskId?: string;
  /** Restrict the run to a specific category. */
  category?: string;
  /** Restrict the run to a specific priority. */
  priority?: string;
  /** Hypothesis text (required for experiment/implement modes). */
  hypothesis?: string;
  /** Whether the candidate evaluator would be the same agent that produced the candidate. */
  evaluatorIsImplementer?: boolean;
}

export interface RunOutcome {
  task: TaskDefinition;
  mode: TaskDefinition["execution"]["mode"];
  validated: boolean;
  validationCode: ValidationResult["code"];
  reportRef?: ReportRef;
  experimentId?: string;
  delivered?: boolean;
  /** Human-readable summary, suitable for CLI output. */
  summary: string;
}

export class TaskRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Picks the highest-priority eligible task and runs it. If `opts.taskId`
   * is set, runs that specific task instead (skipping prioritization).
   */
  async runOne(opts: RunOptions = {}): Promise<RunOutcome> {
    const task = opts.taskId ? this.deps.registry.get(opts.taskId) : (await this.pickNext())?.task;

    if (!task) {
      throw new Error(
        opts.taskId
          ? `Task ${opts.taskId} is not in the registry.`
          : "No eligible task found. Check backlog state and evidence windows.",
      );
    }

    this.deps.backlog.ensurePending(task.id);

    const hypothesis = opts.hypothesis ?? task.objective;
    const currentCommit = await this.deps.getCurrentCommit();
    const validation = validateTaskRun(task, {
      knownHypothesisHashes: this.deps.getKnownHypothesisHashes(task.id),
      proposedHypothesis: hypothesis,
      backlog: this.deps.backlog.get(task.id),
      currentCommit,
      newEvidenceCount: this.deps.getNewEvidenceCount(task.id),
      evaluatorIsImplementer: opts.evaluatorIsImplementer ?? false,
    });

    if (!validation.ok) {
      return {
        task,
        mode: task.execution.mode,
        validated: false,
        validationCode: validation.code,
        summary: `Blocked by anti-rule (${validation.code}): ${validation.message}`,
      };
    }

    // Transition into in_progress for experiment/implement; investigated is
    // set after a diagnose report is committed.
    if (task.execution.mode !== "diagnose") {
      this.deps.backlog.transition(task.id, "in_progress", {
        relatedExperimentId: null,
      });
    }

    try {
      if (task.execution.mode === "diagnose") {
        return await this.runDiagnose(task, currentCommit);
      }
      if (task.execution.mode === "experiment") {
        return await this.runExperiment(task, hypothesis);
      }
      return await this.runImplement(task, hypothesis);
    } catch (err) {
      // On failure, roll back to investigated (or pending if never
      // investigated) so the task is not stuck in in_progress.
      const entry = this.deps.backlog.get(task.id);
      if (entry?.state === "in_progress") {
        this.deps.backlog.transition(task.id, "investigated");
      }
      throw err;
    }
  }

  private async runDiagnose(task: TaskDefinition, currentCommit: string): Promise<RunOutcome> {
    const result = await this.deps.onDiagnose(task);
    if (!result.commit) {
      return {
        task,
        mode: "diagnose",
        validated: true,
        validationCode: "ok",
        summary: "Diagnose hook declined to commit a report.",
      };
    }
    const report = this.deps.reportGenerator.finalize(task, result.partial, currentCommit);
    this.deps.reportStore.save(report);
    // Re-diagnosis (already investigated + new evidence) REFRESHES the entry;
    // a first diagnosis TRANSITIONS pending → investigated. The state machine
    // forbids investigated → investigated, and rightly so.
    const entry = this.deps.backlog.get(task.id);
    const patch = {
      lastEvaluatedCommit: currentCommit,
      lastReportId: report.id,
      evidenceWindowFrom: Date.parse(report.confidence.evidence_window.from) || null,
      evidenceWindowTo: Date.parse(report.confidence.evidence_window.to) || null,
    };
    if (entry?.state === "investigated") {
      this.deps.backlog.refresh(task.id, patch);
    } else {
      this.deps.backlog.transition(task.id, "investigated", patch);
    }
    return {
      task,
      mode: "diagnose",
      validated: true,
      validationCode: "ok",
      reportRef: this.deps.reportStore.refFor(report),
      summary: `Diagnosed ${task.id}; recommendation=${report.recommendation.decision}, confidence=${report.confidence.overall.toFixed(2)}, samples=${report.confidence.independent_samples}`,
    };
  }

  private async runExperiment(task: TaskDefinition, hypothesis: string): Promise<RunOutcome> {
    const result = await this.deps.onExperiment(task, hypothesis);
    this.deps.backlog.transition(task.id, "in_progress", {
      relatedExperimentId: result.experimentId,
    });
    return {
      task,
      mode: "experiment",
      validated: true,
      validationCode: "ok",
      experimentId: result.experimentId,
      summary: `Experiment ${result.experimentId} ${result.readyForEvaluation ? "ready for evaluation" : "started"} for ${task.id}.`,
    };
  }

  private async runImplement(task: TaskDefinition, hypothesis: string): Promise<RunOutcome> {
    const result = await this.deps.onImplement(task, hypothesis);
    this.deps.backlog.transition(task.id, "in_progress", {
      relatedExperimentId: result.experimentId,
    });
    return {
      task,
      mode: "implement",
      validated: true,
      validationCode: "ok",
      experimentId: result.experimentId,
      delivered: result.delivered,
      summary: `Implement ${task.id}: experiment ${result.experimentId}, delivered=${result.delivered}. Activation is a separate state transition.`,
    };
  }

  /**
   * Ranks all pending tasks and returns the full ranked list (see
   * pickNext for the eligibility and mode rules). The catalogue sweep walks
   * this list so a cadence-deferred task cannot wedge the queue: it simply
   * proceeds to the next rank.
   */
  async pickRanked(opts: { mode?: TaskDefinition["execution"]["mode"] } = {}): Promise<PrioritizationOutput[]> {
    const eligible = this.deps.registry.all().filter((t) => {
      if (opts.mode && t.execution.mode !== opts.mode) return false;
      const e = this.deps.backlog.get(t.id);
      if (!e) return true;
      if (e.state === "in_progress" || e.state === "completed") return false;
      if (e.state === "rejected_deferred") return false; // caller evaluates condition
      return true;
    });

    if (eligible.length === 0) return [];

    const inputs: PrioritizationInput[] = eligible.map((task) => ({
      task,
      observedFrequency: this.deps.getObservedFrequency(task.id),
      evidenceConfidence: this.deps.getEvidenceConfidence(task.id),
    }));

    const prioritizer = new TaskPrioritizer(this.deps.policies, this.deps.registry);
    return prioritizer.rank(inputs);
  }

  /**
   * Ranks all pending tasks and returns the top candidate (the first entry
   * of pickRanked). Tasks already in in_progress or completed are excluded;
   * tasks in rejected_deferred are excluded until their
   * next_evaluation_condition is satisfied (the caller evaluates that).
   */
  async pickNext(opts: { mode?: TaskDefinition["execution"]["mode"] } = {}): Promise<PrioritizationOutput | null> {
    const ranked = await this.pickRanked(opts);
    return ranked[0] ?? null;
  }

  /** Returns the hypothesis hash that would be used for the given text. */
  hashHypothesis(text: string): string {
    return hypothesisHash(text);
  }
}
