/**
 * RuntimeStepRunner — the kernel-native delegator for the Control Plane.
 *
 * The control plane (Orchestrator) is step-runner agnostic: it only knows
 * the `StepRunner` port (src/orchestrator/types.ts). Two implementations
 * exist, one per embedding style:
 *
 *   AgentStepRunner   — product turns. Delegates to `runUserMessage`, which
 *                       wraps the kernel run in the CLI's product policies
 *                       (escalation preamble, delegation addendum, skill
 *                       activation, learning episodes). Used by the CLI/TUI.
 *   RuntimeStepRunner — kernel runs. Maps the PlanStep directly onto the
 *                       kernel's ExecutionRequest port and spawns it through
 *                       `AgentRuntime.execute`. Used by kernel-embedded
 *                       products: headless runners, Nexum SDK library
 *                       consumers, and future agent products that want plan
 *                       execution without the interactive CLI machinery.
 *
 * Outcome mapping (ExecutionResult.status → StepOutcome):
 *
 *   completed        → success    (output text + usage recorded for history)
 *   failed / timeout → retryable  (transient by contract; the retry cap and
 *                                 the replanner decide what happens next)
 *   cancelled        → blocking   (the operator asked to stop — retrying a
 *                                 cancelled run would override them)
 *   budget_exhausted → blocking   (an immediate retry against the same budget
 *                                 would re-exhaust it; the replan path owns
 *                                 restructuring the step)
 *
 * The embedding application owns the ExecutionContext (gateways, context
 * port, event sink) through `createContext` — the runner never builds
 * gateways itself, mirroring how `AgentRuntime.execute` receives its context.
 * That factory is also the seam where the orchestrator's abort signal is
 * threaded into the kernel run (the orchestrator documents this contract).
 */

import type {
  AgentRuntime,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  StrategyExecuteOptions,
} from "../core/types.js";
import type { PlanStep, StepOutcome, StepRunner } from "./types.js";

/** Builds the ExecutionContext for one step run. */
export type StepContextFactory = (step: PlanStep, request: ExecutionRequest) => ExecutionContext;

export interface RuntimeStepRunnerOptions {
  /** The kernel runtime the step runs against. */
  runtime: AgentRuntime;
  /** Registered agent id the step executes as (e.g. "devagent"). */
  agentId: string;
  /** Context factory supplied by the embedding application. */
  createContext: StepContextFactory;
  /** Product-side loop policies, identical in shape to direct execute() use. */
  hooks?: StrategyExecuteOptions["hooks"];
  /** Max tool turns override for each step run. */
  maxToolTurns?: number;
}

export class RuntimeStepRunner implements StepRunner {
  constructor(private readonly opts: RuntimeStepRunnerOptions) {}

  async run(step: PlanStep): Promise<StepOutcome> {
    // The PlanStep is projected onto the kernel's TaskSpec: the goal is the
    // step description; orchestration bookkeeping (step id, priority, retry
    // attempt) rides in task.metadata so strategies and hooks can correlate
    // a kernel run back to its plan step without the kernel knowing about
    // PlanStep.
    const request: ExecutionRequest = {
      agentId: this.opts.agentId,
      task: {
        goal: step.description,
        metadata: {
          stepId: step.id,
          priority: step.priority ?? "medium",
          attempt: step.retryCount,
        },
      },
    };

    try {
      const context = this.opts.createContext(step, request);
      const result = await this.opts.runtime.execute(request, context, {
        hooks: this.opts.hooks,
        maxToolTurns: this.opts.maxToolTurns,
      });
      return mapOutcome(result);
    } catch (e) {
      // Defensive: the runtime contract reports failures as ExecutionResults,
      // but a context factory or a misbehaving hook may still throw. Classify
      // as retryable — the orchestrator's retry cap + replanner contain it.
      return { kind: "retryable", error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function mapOutcome(result: ExecutionResult): StepOutcome {
  switch (result.status) {
    case "completed":
      return {
        kind: "success",
        output: { text: result.output, runId: result.runId, usage: result.usage },
      };
    case "failed":
    case "timeout":
      return { kind: "retryable", error: result.error ?? `execution ${result.status}` };
    case "cancelled":
      return { kind: "blocking", error: result.error ?? "execution cancelled" };
    case "budget_exhausted":
      return { kind: "blocking", error: result.error ?? "execution budget exhausted" };
  }
}
