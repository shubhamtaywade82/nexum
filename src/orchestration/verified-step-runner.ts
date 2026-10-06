/**
 * VerifiedStepRunner — the product StepRunner for planned missions.
 *
 *   PlanStep ──► ContextCompiler (plan goal, this step, done/pending steps,
 *                                 this step's earlier failures, success criteria)
 *            ──► runUserMessage(compiled prompt)            the model does the work
 *            ──► gateTaskCompletion(verify command)         exit code decides
 *            ──► success | retryable(with the failure, fed into the next attempt)
 *
 * Replaces the bare AgentStepRunner, which sent only `step.description` (the
 * model never saw the plan it was part of) and treated "the turn returned"
 * as "the step is done". The compiled prompt is sized from the answering
 * model's budget, so a 2B quick model gets a tight step brief while the
 * orchestrator keeps the full plan state.
 */

import { ContextCompiler } from "../context/compiler.js";
import { SIZE_CLASS_DEFAULTS, CHARS_PER_TOKEN, type ModelBudget } from "../models/profiles/context-budget.js";
import { VerifierService, expectCommandSucceeds, type CommandOutcome } from "../runtime/critic/verifier.js";
import { gateTaskCompletion } from "../runtime/verification-gate.js";
import { evaluateEscalation, type EscalationDecision } from "../policy/escalation.js";
import type { PlanStep, StepOutcome, StepRunner } from "./types.js";

export interface VerifiedStepRunnerOptions {
  /** The overall mission goal the plan was generated from. */
  goal: string;
  runUserMessage(message: string, priority?: PlanStep["priority"], opts?: { escalate?: boolean }): Promise<string>;
  /** Runs a verification command (normally run_shell through the tool gateway). */
  runCommand?(command: string): Promise<CommandOutcome>;
  /** Budget of the model expected to answer step turns; small-class default. */
  budget?(): ModelBudget | undefined;
  /** Share of that budget the step brief may use (the rest is system prompt, tools, history). */
  briefShare?: number;
  /** Max chars of a finished step's output carried into later briefs. */
  maxOutputChars?: number;
}

const DEFAULT_BRIEF_SHARE = 0.25;
const DEFAULT_MAX_OUTPUT_CHARS = 300;

function fallbackBudget(): ModelBudget {
  const d = SIZE_CLASS_DEFAULTS.small;
  return {
    modelId: "default",
    sizeClass: "small",
    contextTokens: d.contextTokens,
    contextChars: d.contextTokens * CHARS_PER_TOKEN,
    toolBudget: d.toolBudget,
    reasoning: d.reasoning,
    reserveOutputTokens: 0,
  };
}

export class VerifiedStepRunner implements StepRunner {
  private readonly compiler = new ContextCompiler();
  private readonly steps = new Map<string, PlanStep>();
  private readonly outputs = new Map<string, string>();
  private readonly failures = new Map<string, string[]>();
  private readonly lastFailure = new Map<string, "verification" | "error">();

  constructor(
    private readonly opts: VerifiedStepRunnerOptions,
    initialSteps: PlanStep[] = [],
  ) {
    for (const s of initialSteps) this.observe(s);
  }

  /** Track step state as the orchestrator transitions/replans (wire to onStepChange). */
  observe(step: PlanStep): void {
    this.steps.set(step.id, { ...step });
  }

  /** The prompt sent to the model for this step. Exposed for observability/tests. */
  brief(step: PlanStep): string {
    const base = this.opts.budget?.() ?? fallbackBudget();
    const share = this.opts.briefShare ?? DEFAULT_BRIEF_SHARE;
    const chars = Math.max(1_024, Math.floor(base.contextChars * share));
    const budget: ModelBudget = { ...base, contextChars: chars, contextTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
    const maxOut = this.opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    const others = [...this.steps.values()].filter((s) => s.id !== step.id);
    const completed = others
      .filter((s) => s.status === "completed")
      .map((s) => {
        const out = this.outputs.get(s.id)?.trim();
        return out ? `${s.id}: ${s.description} → ${out.slice(0, maxOut)}` : `${s.id}: ${s.description}`;
      });
    const pending = others
      .filter((s) => s.status !== "completed" && s.status !== "skipped" && s.status !== "cancelled")
      .map((s) => `${s.id}: ${s.description}`);

    const compiled = this.compiler.compile(
      {
        goal: this.opts.goal,
        step: {
          id: step.id,
          objective: step.description,
          inputs: step.dependencies.length ? [`depends on: ${step.dependencies.join(", ")}`] : undefined,
        },
        constraints: ["Do only this step; later steps are handled separately."],
        successCriteria: step.verify ? [`\`${step.verify}\` exits 0`] : undefined,
        failures: this.failures.get(step.id),
        completedSteps: completed,
        pendingSteps: pending,
      },
      budget,
    );
    return compiled.promptBlock;
  }

  /**
   * Escalation policy for a retry: a step whose previous attempt failed
   * (verification red, or the turn itself errored) is materially
   * unresolved, so the next attempt goes to the primary model instead of
   * repeating the same quick-model attempt.
   */
  escalationFor(stepId: string): EscalationDecision {
    const last = this.lastFailure.get(stepId);
    return evaluateEscalation(
      { localFailed: last !== undefined, testsStillFail: last === "verification" },
      { validationFailed: last === "verification", changeNotApplied: last === "error" },
    );
  }

  async run(step: PlanStep): Promise<StepOutcome> {
    this.observe(step);
    const escalation = this.escalationFor(step.id);
    let text: string;
    try {
      text = await this.opts.runUserMessage(this.brief(step), step.priority, { escalate: escalation.escalate });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.recordFailure(step.id, error, "error");
      return { kind: "retryable", error };
    }

    if (step.verify) {
      if (!this.opts.runCommand) {
        return { kind: "blocking", error: `step ${step.id} declares verify but no command runner is configured` };
      }
      const command = step.verify;
      const run = this.opts.runCommand.bind(this.opts);
      const verifier = new VerifierService().register(
        expectCommandSucceeds("verify", `\`${command}\` exits 0`, () => run(command)),
      );
      const gate = await gateTaskCompletion(
        [{ id: step.id, title: step.description, status: "running", dependencies: step.dependencies }],
        step.id,
        verifier,
        text,
      );
      if (gate.outcome !== "completed") {
        const error = `verification failed: ${gate.reason}`;
        this.recordFailure(step.id, error, "verification");
        return { kind: "retryable", error };
      }
    }

    this.outputs.set(step.id, text);
    this.lastFailure.delete(step.id);
    return { kind: "success", output: { text, verified: Boolean(step.verify) } };
  }

  private recordFailure(stepId: string, error: string, kind: "verification" | "error"): void {
    this.lastFailure.set(stepId, kind);
    const list = this.failures.get(stepId) ?? [];
    list.push(error);
    this.failures.set(stepId, list);
  }
}
