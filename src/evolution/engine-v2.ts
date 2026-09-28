/**
 * ClosedLoopEngine — the v2 top-level orchestrator for Nexum's
 * self-development loop.
 *
 * Extends the v1 EvolutionEngine pipeline (telemetry → diagnosis → planning →
 * candidate → benchmark → comparison → registry/PR) with the layers the
 * Self-Developing Agents research shows are required for a genuine
 * closed-loop RSI system:
 *
 *   TARGET layer      (Aspire-inspired target formation before planning)
 *   EXPERIENCE layer  (S³Gym-inspired evidence-grounded experience learning)
 *   SYSTEM layer      (HarnessDev-inspired persistent, auditable evolution)
 *
 * Three separated kinds of learning:
 *
 *   TASK LEARNING       → skills + lessons          (src/learning, existing)
 *   EXPERIENCE LEARNING → ExperienceStore + evidence (src/evolution/experience)
 *   HARNESS EVOLUTION   → experiments + acceptance   (this engine)
 */

import { Episode } from "../learning/types.js";
import { AcceptanceController } from "./acceptance/acceptance-controller.js";
import {
  TwoStageSelector,
  TwoStageResult,
  ExperimentValidity,
  DEFAULT_THRESHOLDS,
} from "./comparison/two-stage-selector.js";
import { GitDeliveryEngine, DeliveryReport, DeliveryPrOptions } from "./delivery.js";
import { HarnessDiagnoser } from "./diagnoser.js";
import { CandidateEvaluator, TaskExecutionResult } from "./evaluator.js";
import { ExecutorArm } from "./evaluation/fixed-executor.js";
import { GeneralizationGate, GeneralizationVerdict } from "./generalization/generalization-gate.js";
import { EvidenceAggregator } from "./experience/evidence-aggregator.js";
import { ExperienceRecord } from "./experience/types.js";
import { ExperienceStore } from "./experience/experience-store.js";
import { TrajectoryAnalyzer } from "./experience/trajectory-analyzer.js";
import { TransferAnalyzer } from "./experience/transfer-analyzer.js";
import { EvolutionMetricsTracker } from "./metrics.js";
import { MutationScopePolicy, MutationScope } from "./mutation/mutation-scope.js";
import {
  CandidateArtifact,
  CodeChangePlan,
  GitWorktreeMutationExecutor,
  HarnessMutationExecutor,
  InspectTargetContext,
  MutationResult,
  MutationVerification,
  MutationWorkspace,
} from "./mutation/mutation-executor.js";
import { AgentMutationStrategy, EngineeringAgentRuntime } from "./mutation/agent-mutation.js";
import { ActivationEnvelope, ActivationHealth, ActivationMonitor } from "./monitoring/activation-monitor.js";
import {
  RuntimeActivationController,
  RuntimeRollbackOrchestrator,
  RuntimeRollbackReport,
} from "./monitoring/runtime-activation.js";
import { ChecksVerdict, DeliveryHandle, GitHubDeliveryAdapter, ReviewVerdict } from "./delivery/github-adapter.js";
import { formulateHypothesis } from "./hypothesis.js";
import { EvolutionPlanner } from "./planner.js";
import { provenanceYamlCodeBlock } from "./experiments/provenance.js";
import { ExperimentController } from "./experiments/experiment-controller.js";
import { ExperimentRecord } from "./experiments/experiment-schema.js";
import { HarnessRegistry } from "./registry.js";
import { TargetEngine, ImprovementTarget } from "./targets/target-engine.js";
import { ComparisonResult, EvaluationMetrics, HarnessDiagnosis, HarnessHypothesis } from "./types.js";

/**
 * How strictly the fixed-executor generalization gate is enforced before a
 * candidate can become eligible:
 *
 *   optional                 — held-out/transfer evidence recorded when supplied,
 *                              but its absence never blocks eligibility
 *                              (development mode; the v2.0 default).
 *   required                 — a fixed-executor matrix MUST be supplied and the
 *                              generalization gate MUST pass, otherwise the
 *                              candidate is rejected (research mode).
 *   required-for-production  — "required" plus transfer-executor evidence
 *                              MUST be present (production evolution).
 */
export type GeneralizationPolicy = "optional" | "required" | "required-for-production";

export interface ClosedLoopEngineOptions {
  registry?: HarnessRegistry;
  experienceStore?: ExperienceStore;
  diagnoser?: HarnessDiagnoser;
  planner?: EvolutionPlanner;
  targetEngine?: TargetEngine;
  twoStageSelector?: TwoStageSelector;
  generalizationGate?: GeneralizationGate;
  mutationScopePolicy?: MutationScopePolicy;
  experimentController?: ExperimentController;
  evaluator?: CandidateEvaluator;
  delivery?: GitDeliveryEngine;
  metricsTracker?: EvolutionMetricsTracker;
  /** Executor models for the fixed-executor protocol (primary first). */
  executorModels?: string[];
  /** Enforcement level of the generalization gate (default "optional"). */
  generalizationPolicy?: GeneralizationPolicy;
  /** Self-development actuator: performs the actual harness mutation. */
  mutationExecutor?: HarnessMutationExecutor;
  /**
   * PRODUCTION AGENT WIRING: an EngineeringAgentRuntime (e.g.
   * NexumEngineeringAgentRuntime). When set and no explicit mutationExecutor
   * is provided, the engine builds a GitWorktreeMutationExecutor backed by
   * AgentMutationStrategy over this runtime — the full self-development
   * loop with one option. Explicit mutationExecutor always wins.
   */
  agentRuntime?: EngineeringAgentRuntime;
  /** Verify commands for the agentRuntime-built executor (default: node --version). */
  agentVerifyCommands?: string[][];
  /** Post-activation telemetry monitor wired to the REGRESSED/ROLLBACK path. */
  monitor?: ActivationMonitor;
  /**
   * Real Git/GitHub delivery. When set (together with the per-cycle `github`
   * input), runEvolutionCycle follows the CANONICAL production path:
   * mutation → evaluation → eligibility → push + PR → CI → review →
   * acceptance → merge, with every external verdict fed back into the
   * experiment lifecycle.
   */
  githubDelivery?: GitHubDeliveryAdapter;
  /**
   * Runtime activation control. When set, rollback becomes a RUNTIME
   * operation (freeze → switch → verify → persist) instead of a registry
   * pointer move, and accepted candidates can be switched onto the live
   * runtime via activateOnRuntime().
   */
  runtimeActivation?: RuntimeActivationController;
}

export interface ClosedLoopDiagnosis {
  diagnoses: HarnessDiagnosis[];
  /** Aspire-style formed target (null = evidence too weak to operationalize). */
  target: ImprovementTarget | null;
  /** v1 plan for compatibility with existing tooling. */
  plan: ReturnType<EvolutionPlanner["createPlan"]>;
  /** Decided mutation scope (single-component by default; compound on escalation). */
  mutationScope: MutationScope | null;
}

export interface ExperimentOutcome {
  experiment: ExperimentRecord;
  comparison: ComparisonResult;
  twoStage: TwoStageResult;
  generalization: GeneralizationVerdict | null;
  delivery: DeliveryReport | null;
}

/**
 * The v2 closed-loop engine. All stages are explicit and independently
 * injectable for testing.
 */
export class ClosedLoopEngine {
  readonly diagnoser: HarnessDiagnoser;
  readonly planner: EvolutionPlanner;
  readonly targetEngine: TargetEngine;
  readonly twoStage: TwoStageSelector;
  readonly generalizationGate: GeneralizationGate;
  readonly scopePolicy: MutationScopePolicy;
  readonly experiments: ExperimentController;
  readonly evaluator: CandidateEvaluator;
  readonly delivery: GitDeliveryEngine;
  readonly metrics: EvolutionMetricsTracker;
  readonly registry?: HarnessRegistry;
  readonly experienceStore?: ExperienceStore;
  readonly mutationExecutor?: HarnessMutationExecutor;
  readonly agentRuntime?: EngineeringAgentRuntime;
  readonly agentVerifyCommands: string[][];
  readonly monitor?: ActivationMonitor;
  readonly githubDelivery?: GitHubDeliveryAdapter;
  readonly runtimeActivation?: RuntimeActivationController;
  readonly generalizationPolicy: GeneralizationPolicy;
  private readonly executorModels: string[];

  constructor(opts: ClosedLoopEngineOptions = {}) {
    this.diagnoser = opts.diagnoser ?? new HarnessDiagnoser();
    this.planner = opts.planner ?? new EvolutionPlanner();
    this.targetEngine = opts.targetEngine ?? new TargetEngine();
    this.twoStage = opts.twoStageSelector ?? new TwoStageSelector();
    this.generalizationGate = opts.generalizationGate ?? new GeneralizationGate();
    this.scopePolicy = opts.mutationScopePolicy ?? new MutationScopePolicy();
    this.experiments = opts.experimentController ?? new ExperimentController();
    this.evaluator = opts.evaluator ?? new CandidateEvaluator();
    this.delivery = opts.delivery ?? new GitDeliveryEngine();
    this.metrics = opts.metricsTracker ?? new EvolutionMetricsTracker();
    this.registry = opts.registry;
    this.experienceStore = opts.experienceStore;
    this.mutationExecutor = opts.mutationExecutor;
    this.agentRuntime = opts.agentRuntime;
    this.agentVerifyCommands = opts.agentVerifyCommands ?? [["node", "--version"]];
    this.monitor = opts.monitor;
    this.githubDelivery = opts.githubDelivery;
    this.runtimeActivation = opts.runtimeActivation;
    this.generalizationPolicy = opts.generalizationPolicy ?? "optional";
    this.executorModels = opts.executorModels ?? ["primary"];
  }

  /**
   * Builds the canonical production actuator from the agent runtime seam:
   * GitWorktreeMutationExecutor + AgentMutationStrategy(runtime). Used when
   * callers pass agentRuntime without an explicit mutationExecutor.
   */
  private buildAgentExecutor(): HarnessMutationExecutor {
    if (!this.agentRuntime) {
      throw new Error("buildAgentExecutor requires ClosedLoopEngineOptions.agentRuntime.");
    }
    return new GitWorktreeMutationExecutor({
      verifyCommands: this.agentVerifyCommands,
      strategy: new AgentMutationStrategy({ runtime: this.agentRuntime }),
    });
  }

  // ── Experience layer ────────────────────────────────────────────────────

  /** Converts graded episodes into evidence-bound experience records. */
  ingestExperience(episodes: Episode[], harnessVersion: string): ExperienceRecord[] {
    const analyzer = new TrajectoryAnalyzer({
      executorModel: this.executorModels[0],
      harnessVersion,
    });
    const records = analyzer.toExperienceRecords(episodes);
    for (const r of records) this.experienceStore?.save(r);
    return records;
  }

  /** Aggregates experience into per-task-class digests (multi-representation). */
  digestExperience(): ReturnType<EvidenceAggregator["digestAll"]> {
    const aggregator = new EvidenceAggregator();
    const records = this.experienceStore ? this.experienceStore.listAll() : [];
    return aggregator.digestAll(records);
  }

  /** Transfer analysis over stored experience (cross-class / cross-model). */
  analyzeTransfer(): ReturnType<TransferAnalyzer["analyze"]> {
    const analyzer = new TransferAnalyzer();
    const records = this.experienceStore ? this.experienceStore.listAll() : [];
    return analyzer.analyze(records);
  }

  // ── Diagnosis → Target → Scope ──────────────────────────────────────────

  /**
   * Full observation pipeline: episodes → diagnoses → TARGET FORMATION →
   * plan + mutation scope. This is where "what capability is actually
   * failing?" is answered before "which file should I change?".
   */
  observe(episodes: Episode[]): ClosedLoopDiagnosis {
    const diagnoses: HarnessDiagnosis[] = [];
    for (const ep of episodes) {
      const diag = this.diagnoser.diagnoseEpisode(ep);
      if (diag) diagnoses.push(diag);
    }

    const target = this.targetEngine.formTarget(diagnoses);
    const plan = this.planner.createPlan(diagnoses);

    let mutationScope: MutationScope | null = null;
    if (target && plan) {
      mutationScope = this.scopePolicy.decideScope(target, plan.targetComponent);
    }

    return { diagnoses, target, plan, mutationScope };
  }

  // ── Experiment execution ────────────────────────────────────────────────

  /**
   * Runs the full evaluation experiment for a candidate harness:
   * two-stage gates → fixed-executor generalization (policy-enforced) →
   * experiment record → delivery preparation. Promotion is never declared:
   * the returned outcome is ELIGIBLE at most, and becomes ACTIVE only through
   * the acceptance pipeline (CI + review + activation).
   */
  runExperiment(input: {
    experimentId: string;
    parentHarnessId: string;
    parentCommit: string;
    candidateHarnessId: string;
    candidateCommit: string;
    target: ImprovementTarget;
    diagnosis: HarnessDiagnosis;
    scope: MutationScope;
    /** Candidate results on the visible+held-out suite (primary executor). */
    candidateResults: TaskExecutionResult[];
    /** Baseline results on the same suite (primary executor). */
    baselineResults: TaskExecutionResult[];
    /** Fixed-executor matrix cells (candidate + baseline × executors). */
    matrixCells?: Parameters<GeneralizationGate["evaluate"]>[0];
  }): ExperimentOutcome {
    // 1. Metrics & baseline resolution.
    const candidateMetrics = this.evaluator.aggregateResults(input.candidateResults);
    const baselineMetrics = this.evaluator.aggregateResults(input.baselineResults);

    // 2. Two-stage selection (Stage A validity → Stage B improvement).
    const validity = deriveValidity(input.candidateResults, input.baselineResults);
    const twoStage = this.twoStage.evaluate({
      candidateId: input.candidateHarnessId,
      baselineId: input.parentHarnessId,
      candidateMetrics,
      baselineMetrics,
      validity,
    });

    // 3. Generalization gate over the fixed-executor matrix.
    let generalization: GeneralizationVerdict | null = null;
    if (input.matrixCells && input.matrixCells.length > 0) {
      const transferExecutors = this.executorModels.slice(1);
      generalization = this.generalizationGate.evaluate(
        input.matrixCells,
        input.parentHarnessId,
        input.candidateHarnessId,
        transferExecutors,
      );
    }

    // 4. Generalization policy enforcement. A candidate without sufficient
    //    fixed-executor evidence can no longer slide through silently.
    const policyMissingEvidence =
      this.generalizationPolicy !== "optional" &&
      (generalization === null ||
        (this.generalizationPolicy === "required-for-production" &&
          Object.keys(generalization.transferDeltas).length === 0));
    const generalizationFailed = generalization !== null && !generalization.generalized;
    const policyBlocked = policyMissingEvidence || generalizationFailed;
    const eligible = twoStage.decision === "eligible" && !policyBlocked;

    // 5. Start the experiment lifecycle and persist the decision.
    const hypothesis: HarnessHypothesis = formulateHypothesis(input.diagnosis);
    this.experiments.startExperiment({
      id: input.experimentId,
      parentHarness: input.parentHarnessId,
      parentCommit: input.parentCommit,
      candidateHarness: input.candidateHarnessId,
      candidateCommit: input.candidateCommit,
      targetId: input.target.id,
      targetCapability: input.target.capability,
      desiredOutcome: input.target.desiredOutcome,
      hypothesisId: hypothesis.id,
      hypothesisStatement: hypothesis.statement,
      predictedEffect: hypothesis.predictedEffect,
      executorPrimary: this.executorModels[0],
      executorTransfer: this.executorModels.slice(1),
      scopeComponents: [...input.scope.components],
    });
    this.experiments.reportEvaluation(
      input.experimentId,
      {
        visible: pickRates(candidateMetrics, "visible"),
        held_out: pickRates(candidateMetrics, "held_out"),
        transfer: pickRates(candidateMetrics, "transfer"),
      },
      {
        capability: twoStage.stageB?.deltas.capability ?? 0,
        reliability: twoStage.stageB?.deltas.reliability ?? 0,
        efficiency: twoStage.stageB?.deltas.efficiency ?? 0,
        generalization: twoStage.stageB?.deltas.generalization ?? 0,
      },
    );
    const decisionRationale = policyMissingEvidence
      ? `${twoStage.rationale} Generalization policy "${this.generalizationPolicy}" blocked eligibility: no usable fixed-executor evidence was supplied.`
      : generalizationFailed
        ? `${twoStage.rationale} Generalization: ${generalization!.rationale}`
        : generalization
          ? `${twoStage.rationale} Generalization: ${generalization.rationale}`
          : twoStage.rationale;
    this.experiments.reportDecision(input.experimentId, {
      result: eligible ? "eligible" : twoStage.decision === "eligible" ? "inconclusive" : twoStage.decision,
      stageA: twoStage.stageA.decision,
      stageB: twoStage.stageB?.decision ?? "not_run",
      rationale: decisionRationale,
    });

    // 6. Advance the state machine through the acceptance pipeline.
    this.experiments.advance(input.experimentId, "EVALUATING", "Benchmark suite executed");
    const machine = this.experiments.machine(input.experimentId);
    const acceptance = new AcceptanceController(machine);
    const validated = acceptance.validate({ twoStagePassed: twoStage.decision === "eligible" });
    if (!validated.ok) {
      // Stage A/B failure is the documented EVALUATING → REJECTED path.
      this.experiments.advance(
        input.experimentId,
        "REJECTED",
        `Two-stage comparison rejected the candidate: ${twoStage.rationale}`,
      );
    } else if (generalization && generalization.generalized) {
      acceptance.generalize({ generalizationPassed: true });
    } else if (policyBlocked) {
      // Walk VALIDATED → GENERALIZED → REJECTED so the audit trail shows the
      // generalization gate (or its policy-enforced absence) as the reason.
      this.experiments.advance(
        input.experimentId,
        "GENERALIZED",
        policyMissingEvidence
          ? `Generalization policy "${this.generalizationPolicy}" requires fixed-executor evidence; none supplied`
          : `Generalization gate failed: ${generalization!.rationale}`,
      );
      this.experiments.advance(input.experimentId, "REJECTED", "Candidate rejected at the generalization gate");
    } else {
      // Policy "optional" with no matrix supplied: gate recorded as non-blocking.
      acceptance.generalize({ generalizationPassed: true });
    }
    if (machine.current() === "ELIGIBLE") {
      acceptance.deliver();
      // DELIVERED → CI_PENDING: delivery awaits an explicit CI verdict.
      this.experiments.advance(input.experimentId, "CI_PENDING", "Delivery prepared; awaiting CI verdict");
    }

    // 7. Persist the version in the registry with the legacy status mapping.
    let comparison: ComparisonResult = {
      candidateId: input.candidateHarnessId,
      baselineId: input.parentHarnessId,
      decision: eligible ? "promote" : twoStage.decision === "rejected" ? "reject" : "inconclusive",
      scoreDeltas: twoStage.stageB?.deltas ?? { capability: 0, reliability: 0, efficiency: 0, generalization: 0 },
      rationale: decisionRationale,
    };

    if (this.registry) {
      this.registry.saveVersion({
        id: input.candidateHarnessId,
        commitSha: input.candidateCommit,
        parentId: input.parentHarnessId,
        createdAt: Date.now(),
        targetComponent: input.scope.components[0],
        hypothesis: hypothesis.statement,
        metrics: candidateMetrics,
        status: eligible ? "validated" : twoStage.decision === "rejected" ? "rejected" : "candidate",
      });
    }

    // 8. Delivery (branch + commit + PR with provenance) for eligible candidates.
    let deliveryReport: DeliveryReport | null = null;
    if (eligible) {
      const deliveryOpts: DeliveryPrOptions = {
        version: {
          id: input.candidateHarnessId,
          commitSha: input.candidateCommit,
          parentId: input.parentHarnessId,
          createdAt: Date.now(),
          targetComponent: input.scope.components[0],
          hypothesis: hypothesis.statement,
          metrics: candidateMetrics,
          status: "validated",
        },
        hypothesis,
        comparison,
      };
      deliveryReport = this.delivery.prepareDelivery(deliveryOpts);
      const record = this.experiments.record(input.experimentId);
      deliveryReport = {
        ...deliveryReport,
        prBody: [deliveryReport.prBody, provenanceYamlCodeBlock(record)].join("\n\n"),
      };
    }

    // 9. Record the version switch for promotion-precision accounting.
    this.metrics.record({
      versionId: input.candidateHarnessId,
      parentVersionId: input.parentHarnessId,
      visibleGain: twoStage.stageB?.deltas.capability ?? null,
      heldOutGain: candidateMetrics.generalization.heldOutScore - baselineMetrics.generalization.heldOutScore,
      transferGain: candidateMetrics.generalization.transferScore - baselineMetrics.generalization.transferScore,
      promoted: eligible,
      // Without a generalization gate there is no independent held-out verdict — "unknown", not "eligible".
      genuinelyBetterOnHeldOut:
        generalization === null
          ? "unknown"
          : generalization.generalized && (twoStage.stageB?.deltas.generalization ?? 0) > 0,
      accepted: false,
      rolledBack: false,
      retainedBySuccessor: "unknown",
      executorModels: [...this.executorModels],
      executorSensitivity: generalization?.executorSensitivity ?? null,
    });

    const experiment = this.experiments.record(input.experimentId);
    return { experiment, comparison, twoStage, generalization, delivery: deliveryReport };
  }

  // ── Self-development actuator ─────────────────────────────────────────

  /**
   * The FULL self-development cycle — the missing actuator from the v2
   * review, now first-class:
   *
   *   target → mutation workspace → agent code plan → implementation →
   *   verification → candidate commit → benchmark → two-stage +
   *   generalization gates → delivery → [GitHub PR → CI → review →
   *   acceptance → merge] (canonical path when a GitHubDeliveryAdapter and
   *   the `github` input are configured)
   *
   * Workspace lifecycle is owned HERE: the worktree is disposed on every
   * exit path (success, stage failure, benchmark failure) via try/finally —
   * the candidate branch and commit survive in the repository, so artifacts
   * remain available for review/rework while /tmp worktrees never leak.
   * Pass `retainWorkspace: true` to keep the worktree for a manual delivery
   * flow, then call disposeWorkspace() yourself.
   */
  async runEvolutionCycle(input: {
    experimentId: string;
    parentHarnessId: string;
    parentCommit: string;
    candidateHarnessId: string;
    /** Harness repository to mutate (the candidate workspace base). */
    repoRoot: string;
    target: ImprovementTarget;
    diagnosis: HarnessDiagnosis;
    scope: MutationScope;
    baselineResults: TaskExecutionResult[];
    /** Benchmarks the mutated workspace and returns the candidate's runs. */
    evaluateCandidate: (artifact: CandidateArtifact) => Promise<TaskExecutionResult[]> | TaskExecutionResult[];
    matrixCells?: Parameters<GeneralizationGate["evaluate"]>[0];
    commitMessage?: string;
    /** Evidence-grounded experience digest handed to the mutation agent. */
    experienceDigest?: string;
    /** Operational telemetry digest handed to the mutation agent. */
    telemetryDigest?: string;
    /** Keep the worktree alive after the cycle (manual delivery flows). */
    retainWorkspace?: boolean;
    /**
     * Run the CANONICAL production path after eligibility: push the mutation
     * branch, open the PR, poll CI and review, auto-accept on approval, and
     * merge. Requires ClosedLoopEngineOptions.githubDelivery.
     */
    github?: {
      checksTimeoutMs?: number;
      /** Accept (APPROVED → ACCEPTED → ACTIVE) when review approves (default true). */
      autoAccept?: boolean;
      /** Merge the PR once the candidate is ACTIVE (default true). */
      mergeOnAccept?: boolean;
    };
  }): Promise<
    | { ok: true; outcome: ExperimentOutcome; mutation: MutationArtifacts; github?: EvolutionCycleGithubResult }
    | {
        ok: false;
        stage: "prepare" | "implement" | "verify" | "finalize" | "evaluate";
        reason: string;
        mutation: MutationArtifacts;
      }
  > {
    if (!this.mutationExecutor && !this.agentRuntime) {
      throw new Error(
        "runEvolutionCycle requires a HarnessMutationExecutor (ClosedLoopEngineOptions.mutationExecutor) or an agentRuntime (ClosedLoopEngineOptions.agentRuntime).",
      );
    }
    const executor = this.mutationExecutor ?? this.buildAgentExecutor();
    const artifacts: MutationArtifacts = {};
    let workspace: MutationWorkspace | undefined;

    try {
      // 1. Isolated workspace at the parent commit.
      try {
        workspace = await executor.prepareWorkspace({
          repoRoot: input.repoRoot,
          parentCommit: input.parentCommit,
          candidateHarnessId: input.candidateHarnessId,
          branchName: `evolution/${input.candidateHarnessId.toLowerCase()}`,
        });
      } catch (err) {
        return { ok: false, stage: "prepare", reason: msg(err), mutation: artifacts };
      }
      artifacts.workspace = workspace;

      // 2. Inspect the target → code change plan (strategy-pluggable; the
      //    agent-backed strategy receives the repo view + evidence digests).
      const inspectContext: InspectTargetContext = {
        diagnosis: input.diagnosis,
        scope: input.scope,
        experienceDigest: input.experienceDigest,
        telemetryDigest: input.telemetryDigest,
        repoRoot: input.repoRoot,
        parentCommit: input.parentCommit,
      };
      let plan: CodeChangePlan;
      try {
        plan = await executor.inspectTarget(workspace, input.target, inspectContext);
      } catch (err) {
        return { ok: false, stage: "implement", reason: `inspectTarget failed: ${msg(err)}`, mutation: artifacts };
      }
      artifacts.plan = plan;

      // 3. Implement the plan.
      let result: MutationResult;
      try {
        result = await executor.implement(workspace, plan);
      } catch (err) {
        return { ok: false, stage: "implement", reason: `implement failed: ${msg(err)}`, mutation: artifacts };
      }
      artifacts.result = result;
      if (result.appliedEdits.length === 0) {
        return {
          ok: false,
          stage: "implement",
          reason: "All planned edits were rejected by the scope guard",
          mutation: artifacts,
        };
      }

      // 4. Verify (planned ⊆ allowed AND actual-diff ⊆ declared ∪ extras).
      let verification: MutationVerification;
      try {
        verification = await executor.verify(workspace, plan);
      } catch (err) {
        return { ok: false, stage: "verify", reason: `verify failed: ${msg(err)}`, mutation: artifacts };
      }
      artifacts.verification = verification;
      if (!verification.ok) {
        const reasons = [
          ...verification.scopeViolations,
          ...verification.actualDiffViolations.map(
            (p) => `${p}: changed on disk but never declared in the plan (strategy side effect)`,
          ),
          ...verification.commands.filter((c) => c.exitCode !== 0).map((c) => `${c.command} (exit ${c.exitCode})`),
        ];
        return {
          ok: false,
          stage: "verify",
          reason: `Mutation verification failed: ${reasons.join("; ")}`,
          mutation: artifacts,
        };
      }

      // 5. Finalize the candidate commit.
      let artifact: CandidateArtifact;
      try {
        artifact = await executor.finalize(workspace, plan, { commitMessage: input.commitMessage });
      } catch (err) {
        return { ok: false, stage: "finalize", reason: `finalize failed: ${msg(err)}`, mutation: artifacts };
      }
      artifacts.artifact = artifact;

      // 6. Benchmark the candidate and run the full experiment pipeline.
      let candidateResults: TaskExecutionResult[];
      try {
        candidateResults = await input.evaluateCandidate(artifact);
      } catch (err) {
        return { ok: false, stage: "evaluate", reason: `benchmark failed: ${msg(err)}`, mutation: artifacts };
      }
      const outcome = this.runExperiment({
        experimentId: input.experimentId,
        parentHarnessId: input.parentHarnessId,
        parentCommit: input.parentCommit,
        candidateHarnessId: input.candidateHarnessId,
        candidateCommit: artifact.commitSha,
        target: input.target,
        diagnosis: input.diagnosis,
        scope: input.scope,
        candidateResults,
        baselineResults: input.baselineResults,
        matrixCells: input.matrixCells,
      });

      // 7. Canonical production path: real GitHub delivery + CI/review/
      //    acceptance feedback, all inside the workspace lifetime.
      let github: EvolutionCycleGithubResult | undefined;
      if (input.github && this.githubDelivery && outcome.delivery) {
        github = await this.deliverAndFollowUp(input.experimentId, artifact, outcome, input.github);
      }

      return { ok: true, outcome, mutation: artifacts, ...(github ? { github } : {}) };
    } finally {
      // The experiment controller owns cleanup semantics: whatever happened,
      // the worktree dies here. The candidate branch/commit live on in the
      // repository for review, rework, and provenance.
      if (workspace && !input.retainWorkspace) {
        try {
          await executor.dispose(workspace);
        } catch {
          // Disposal failure must never mask the cycle result; the next
          // prepareWorkspace() prunes orphaned worktrees.
        }
      }
    }
  }

  /** Disposes a retained workspace (manual delivery flows). */
  async disposeWorkspace(workspace: MutationWorkspace): Promise<void> {
    if (!this.mutationExecutor) {
      throw new Error("disposeWorkspace requires a HarnessMutationExecutor.");
    }
    await this.mutationExecutor.dispose(workspace);
  }

  /**
   * Canonical production delivery for one eligible candidate: push the
   * mutation branch → open the PR → poll CI → report → poll review →
   * report → accept on approval → merge. The DeliveryReport's generated
   * branch name is overridden with the ACTUAL mutation branch so the PR
   * contains the real candidate commit.
   */
  private async deliverAndFollowUp(
    experimentId: string,
    artifact: CandidateArtifact,
    outcome: ExperimentOutcome,
    opts: { checksTimeoutMs?: number; autoAccept?: boolean; mergeOnAccept?: boolean },
  ): Promise<EvolutionCycleGithubResult> {
    const adapter = this.githubDelivery!;
    const report = { ...outcome.delivery!, branchName: artifact.branchName };
    const handle = await adapter.deliverExperiment({
      worktreePath: artifact.workspace.worktreePath,
      report,
      alreadyCommitted: true,
    });
    const ci = await adapter.syncCiFeedback(this.experiments, experimentId, handle.headSha, opts.checksTimeoutMs);
    let review: ReviewVerdict | null = null;
    let accepted = false;
    let merged = false;
    if (ci.passed) {
      review = await adapter.syncReviewFeedback(this.experiments, experimentId, handle.prNumber);
      if (review.state === "approved" && (opts.autoAccept ?? true)) {
        accepted = this.finalizeAcceptance(experimentId);
        if (accepted && (opts.mergeOnAccept ?? true)) {
          merged = await adapter.mergePullRequest(handle.prNumber);
        }
      }
    }
    return { handle, ci, review, accepted, merged };
  }

  // ── Post-activation monitoring ────────────────────────────────────────

  /** CI feedback hook (CI_PENDING → CI_FAILED or CI_PASSED → REVIEW_PENDING). */
  reportCi(experimentId: string, passed: boolean, runUrl?: string): void {
    this.experiments.reportCiResult(experimentId, passed ? "passed" : "failed", runUrl);
  }

  /** Review feedback hook (REVIEW_PENDING → APPROVED or CHANGES_REQUESTED). */
  reportReview(experimentId: string, approved: boolean, reviewer?: string): void {
    this.experiments.reportReviewOutcome(experimentId, approved ? "approved" : "changes_requested", reviewer);
  }

  /** Completes acceptance: APPROVED → ACCEPTED → ACTIVE and updates the registry. */
  finalizeAcceptance(experimentId: string): boolean {
    const machine = this.experiments.machine(experimentId);
    if (machine.current() !== "APPROVED") return false;
    const record = this.experiments.record(experimentId);
    machine.transition("ACCEPTED", "Review approved");
    machine.transition("ACTIVE", "Candidate is the active harness");
    record.lifecycle = { state: "ACTIVE", enteredAt: Date.now() };
    if (this.registry) {
      this.registry.promoteVersion(record.candidate.harness);
    }
    const switchRecord = this.metrics.records().find((s) => s.versionId === record.candidate.harness);
    if (switchRecord) switchRecord.accepted = true;
    // Post-activation monitoring starts the moment the candidate is live.
    this.registerActivationEnvelope(experimentId);
    return true;
  }

  /**
   * Registers the performance envelope for the newly active harness from the
   * PARENT version's evaluation metrics: the candidate must at least hold
   * the band it inherited. No-op when the monitor or parent metrics are
   * unavailable.
   */
  registerActivationEnvelope(experimentId: string): ActivationEnvelope | null {
    if (!this.monitor) return null;
    const record = this.experiments.record(experimentId);
    const parentVersion = this.registry?.getVersion(record.parent.harness);
    if (!parentVersion) return null;
    const envelope = this.monitor.envelopeFromBaseline({
      harnessId: record.candidate.harness,
      experimentId,
      baseline: {
        taskSuccessRate: parentVersion.metrics.capability.taskSuccessRate,
        falseSuccessRate: parentVersion.metrics.reliability.falseSuccessRate,
        toolErrorRate: parentVersion.metrics.reliability.toolErrorRate,
        loopAbortRate: parentVersion.metrics.reliability.loopAbortRate,
        verificationFailureRate: 1 - parentVersion.metrics.capability.verificationPassRate,
        avgTokens: parentVersion.metrics.efficiency.avgTokens,
        avgLatencyMs: parentVersion.metrics.efficiency.avgLatencyMs,
      },
    });
    this.monitor.setEnvelope(envelope);
    return envelope;
  }

  /**
   * Evaluates live telemetry for the active harness. A "regressed" verdict
   * drives the full ACTIVE → REGRESSED → ROLLBACK path automatically.
   */
  evaluateActivation(experimentId: string, autoRollback = true): ActivationHealth | null {
    if (!this.monitor) return null;
    const record = this.experiments.record(experimentId);
    const health = this.monitor.evaluate(record.candidate.harness);
    if (
      autoRollback &&
      health.status === "regressed" &&
      this.experiments.machine(experimentId).current() === "ACTIVE"
    ) {
      this.handleRegression(experimentId, health.rationale);
    }
    return health;
  }

  /**
   * Re-enters the evolution loop after external rework: CI_FAILED or
   * CHANGES_REQUESTED → CANDIDATE. The reworked mutation itself runs as a
   * fresh runEvolutionCycle (new experiment) branching from the same parent,
   * while the audit trail shows this experiment's loop re-entry.
   */
  beginRework(experimentId: string, note?: string): boolean {
    const machine = this.experiments.machine(experimentId);
    const current = machine.current();
    if (current !== "CI_FAILED" && current !== "CHANGES_REQUESTED") return false;
    this.experiments.advance(experimentId, "CANDIDATE", note ?? `Rework loop re-entry from ${current}`);
    return true;
  }

  /**
   * LOGICAL rollback (registry pointer only): ACTIVE → REGRESSED → ROLLBACK
   * plus registry rollbackTo. Used when no RuntimeActivationController is
   * wired. Runtime-verified rollback lives in rollbackActive().
   */
  handleRegression(experimentId: string, detail: string): void {
    this.experiments.reportRegression(experimentId, detail);
    this.experiments.completeRollback(experimentId, this.experiments.record(experimentId).parent.harness);
    const record = this.experiments.record(experimentId);
    if (this.registry) {
      this.registry.rollbackTo(record.parent.harness);
    }
    const switchRecord = this.metrics.records().find((s) => s.versionId === record.candidate.harness);
    if (switchRecord) {
      switchRecord.rolledBack = true;
      switchRecord.retainedBySuccessor = false;
    }
  }

  /**
   * RUNTIME rollback: freeze the regressed harness → switch the live runtime
   * to the parent → VERIFY the parent is actually healthy in the runtime →
   * persist (REGRESSED → ROLLBACK → ACTIVE + registry rollbackTo). Requires
   * ClosedLoopEngineOptions.runtimeActivation. Throws RuntimeRollbackError
   * when the runtime cannot be restored; the experiment stays at REGRESSED.
   */
  async rollbackActive(experimentId: string, detail?: string): Promise<RuntimeRollbackReport | null> {
    if (!this.runtimeActivation) return null;
    const orchestrator = new RuntimeRollbackOrchestrator({
      runtime: this.runtimeActivation,
      registry: this.registry,
      experiments: this.experiments,
    });
    const report = await orchestrator.rollback(experimentId, { detail });
    const record = this.experiments.record(experimentId);
    const switchRecord = this.metrics.records().find((s) => s.versionId === record.candidate.harness);
    if (switchRecord) {
      switchRecord.rolledBack = true;
      switchRecord.retainedBySuccessor = false;
    }
    return report;
  }

  /**
   * Live evaluation loop tick: evaluates telemetry AND, on regression,
   * performs the RUNTIME rollback (awaited). Use this in production
   * monitors; the synchronous evaluateActivation() remains for the legacy
   * registry-only path.
   */
  async evaluateActivationLive(experimentId: string): Promise<ActivationHealth | null> {
    if (!this.monitor) return null;
    const record = this.experiments.record(experimentId);
    const health = this.monitor.evaluate(record.candidate.harness);
    if (health.status === "regressed" && this.experiments.machine(experimentId).current() === "ACTIVE") {
      if (this.runtimeActivation) {
        await this.rollbackActive(experimentId, health.rationale);
      } else {
        this.handleRegression(experimentId, health.rationale);
      }
    }
    return health;
  }

  /**
   * Runtime-side ACTIVATION: switches the live runtime onto an accepted
   * (ACTIVE) candidate and verifies it loaded healthily. Complements
   * finalizeAcceptance() — the registry/state half — with the runtime half.
   * Returns null when no runtime controller is wired; returns false when the
   * experiment is not ACTIVE; throws when the runtime refuses the switch
   * (callers should then roll back).
   */
  async activateOnRuntime(experimentId: string): Promise<boolean | null> {
    if (!this.runtimeActivation) return null;
    const record = this.experiments.record(experimentId);
    if (this.experiments.machine(experimentId).current() !== "ACTIVE") return false;
    await this.runtimeActivation.switchTo(record.candidate.harness);
    return true;
  }
}

/** Artifacts produced (or partially produced) by a self-development cycle. */
export interface MutationArtifacts {
  workspace?: MutationWorkspace;
  plan?: CodeChangePlan;
  result?: MutationResult;
  verification?: MutationVerification;
  artifact?: CandidateArtifact;
}

/** External-reality results of the canonical GitHub delivery path (v2.2). */
export interface EvolutionCycleGithubResult {
  handle: DeliveryHandle;
  /** CI verdict; `passed: null` means the poll timed out (still CI_PENDING). */
  ci: ChecksVerdict;
  /** Review verdict; null when CI did not pass (review never started). */
  review: ReviewVerdict | null;
  /** True when the candidate walked APPROVED → ACCEPTED → ACTIVE. */
  accepted: boolean;
  /** True when the PR was merged after activation. */
  merged: boolean;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Derives Stage-A experiment validity facts from raw runs. */
export function deriveValidity(
  candidateResults: TaskExecutionResult[],
  baselineResults: TaskExecutionResult[],
): ExperimentValidity {
  const completed = candidateResults.length;
  const verifierCovered = candidateResults.filter((r) => r.verificationPassed !== undefined).length;
  const ranVerification = candidateResults.filter((r) => r.verificationPassed).length;
  const coverage = completed > 0 ? ranVerification / completed : 0;
  const baselineSuccess =
    baselineResults.length > 0 ? baselineResults.filter((r) => r.success).length / baselineResults.length : 0;
  const candidateSuccess = completed > 0 ? candidateResults.filter((r) => r.success).length / completed : 0;
  const catastrophic = baselineSuccess - candidateSuccess > DEFAULT_THRESHOLDS.catastrophicRegressionThreshold;
  return {
    completedRuns: completed,
    verifierCoveredRuns: verifierCovered,
    verifierCoverage: coverage,
    catastrophicRegression: catastrophic,
  };
}

function pickRates(metrics: EvaluationMetrics, split: "visible" | "held_out" | "transfer"): Record<string, number> {
  if (split === "held_out") return { heldOutScore: metrics.generalization.heldOutScore };
  if (split === "transfer") return { transferScore: metrics.generalization.transferScore };
  return {
    taskSuccessRate: metrics.capability.taskSuccessRate,
    verificationPassRate: metrics.capability.verificationPassRate,
  };
}

export type { ExecutorArm };
