/**
 * ExecutionManager service (review item 1) — run lifecycle + planned-task
 * execution the Agent god class used to own inline.
 *
 * Owns: run scopes (run id + abort signal wired into gateway-supervised
 * tool calls), cancellation, the plan checkpoint store, and the planned
 * mission flows (run/resume Orchestrator runs, /plan entry).
 */

import { Orchestrator } from "../../orchestration/orchestrator.js";
import { VerifiedStepRunner } from "../../orchestration/verified-step-runner.js";
import type { CommandOutcome } from "../../runtime/critic/verifier.js";
import type { ModelBudget } from "../../models/profiles/context-budget.js";
import type { Planner } from "../../orchestration/types.js";
import { PlanStep } from "../../orchestration/types.js";
import { CheckpointStore, sanitizeResumedSteps } from "../../runtime/checkpoint.js";
import type { DefaultAgentRuntime } from "../../runtime/agent/agent-runtime.js";
import type { GateRegistry } from "../../core/concurrency/gate-registry.js";

export interface ExecutionManagerOptions {
  runtime: DefaultAgentRuntime;
  checkpoint: CheckpointStore;
  /** One step of work (delegated back to the composing Agent). */
  runStep: (message: string, opts?: { escalate?: boolean }) => Promise<string>;
  onStepChange?: (step: PlanStep) => void;
  /** Runs a step's `verify` command (policy-checked, sandboxed). */
  runCommand?: (command: string) => Promise<CommandOutcome>;
  /** Budget of the model expected to answer step turns (sizes the step brief). */
  stepBudget?: () => ModelBudget | undefined;
}

export class ExecutionManager {
  private currentRunController: AbortController | null = null;
  private executionSignal: AbortSignal | null = null;

  constructor(private readonly opts: ExecutionManagerOptions) {}

  get signal(): AbortSignal | undefined {
    return this.executionSignal ?? undefined;
  }

  get gates(): GateRegistry {
    return this.opts.runtime.gates;
  }

  /** Open a run scope: run id + abort signal wired into every supervised tool call. */
  startExecutionRun(): string {
    this.endExecutionRun();
    const controller = new AbortController();
    this.currentRunController = controller;
    this.executionSignal = controller.signal;
    return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Cancel the in-flight run scope: supervised tool calls unwind as cancelled. */
  cancelExecutionRun(): boolean {
    if (!this.currentRunController) return false;
    this.currentRunController.abort();
    return true;
  }

  endExecutionRun(): void {
    this.currentRunController = null;
    this.executionSignal = null;
  }

  hasResumablePlan(): boolean {
    return this.opts.checkpoint.load() !== null;
  }

  /** Step runner: compiled step briefs + verification-gated completion. */
  private stepRunner(goal: string, steps: PlanStep[]): VerifiedStepRunner {
    return new VerifiedStepRunner(
      {
        goal,
        runUserMessage: (message, _priority, opts) => this.opts.runStep(message, opts),
        runCommand: this.opts.runCommand,
        budget: this.opts.stepBudget,
      },
      steps,
    );
  }

  /** Run a planned task through the Orchestrator (topological + concurrent + retry + replan). */
  async runPlannedTask(steps: PlanStep[], planner: Planner, goal = ""): Promise<PlanStep[]> {
    const runner = this.stepRunner(goal || summarizeGoal(steps), steps);
    const orchestrator = new Orchestrator({
      steps,
      goal: goal || undefined,
      runner,
      planner,
      gates: this.opts.runtime.gates,
      signal: this.executionSignal ?? undefined,
      runRollback: async (command: string) => {
        await this.opts.runStep(`Roll back by running exactly this: ${command}`);
      },
      checkpoint: this.opts.checkpoint,
      onStepChange: (step) => {
        runner.observe(step);
        this.opts.onStepChange?.(step);
      },
    });
    return orchestrator.run();
  }

  /** Resume a plan interrupted by a crash or kill (non-terminal → pending). */
  async resumePlannedTask(planner: Planner): Promise<PlanStep[] | null> {
    const saved = this.opts.checkpoint.load();
    if (!saved) return null;
    const steps = sanitizeResumedSteps(saved.steps);
    const runner = this.stepRunner(saved.goal || summarizeGoal(steps), steps);
    const orchestrator = new Orchestrator({
      steps,
      goal: saved.goal,
      runner,
      planner,
      gates: this.opts.runtime.gates,
      signal: this.executionSignal ?? undefined,
      runRollback: async (command: string) => {
        await this.opts.runStep(`Roll back by running exactly this: ${command}`);
      },
      checkpoint: this.opts.checkpoint,
      onStepChange: (step) => {
        runner.observe(step);
        this.opts.onStepChange?.(step);
      },
      history: saved.history,
      replanCount: saved.replanCount,
    });
    return orchestrator.run();
  }
}

/** Fallback mission goal when none was recorded (legacy checkpoints, direct callers). */
function summarizeGoal(steps: PlanStep[]): string {
  return (
    steps
      .map((s) => s.description)
      .join("; ")
      .slice(0, 500) || "complete the plan"
  );
}
