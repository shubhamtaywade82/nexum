/**
 * Runtime activation rollback — the RUNTIME half of the rollback path.
 *
 * Registry rollback (HarnessRegistry.rollbackTo) only moves the version
 * lineage pointer; whether the LIVE process actually stops executing the
 * regressed harness depends on how the runtime loads the harness. This
 * module makes runtime rollback explicit and verifiable:
 *
 *   ACTIVE H(n) ──monitor regression──→ freeze H(n)
 *     → switch runtime → H(n-1)
 *     → verify H(n-1) healthy in the runtime
 *     → persist: REGRESSED → ROLLBACK → ACTIVE + registry.rollbackTo
 *
 * If the switch or the post-switch health verification fails, the runtime
 * is switched back to the (regressed) original and the experiment stays at
 * REGRESSED — an honest, non-silent state that pageable operations can act
 * on. A rollback is never reported as complete unless the prior harness is
 * actually running again.
 */

import { HarnessRegistry } from "../registry.js";
import { ExperimentController } from "../experiments/experiment-controller.js";

/**
 * The runtime side of harness activation. Implement this to plug the
 * evolution loop into the process that actually executes the harness
 * (config/prompt/tool-policy loading, model routing, etc.).
 */
export interface RuntimeActivationController {
  /** Human-readable name of the runtime integration (for audit records). */
  readonly name: string;
  /** Harness id the runtime is currently executing. */
  activeHarness(): string | Promise<string>;
  /**
   * Atomically switches the runtime onto `harnessId`. `pinnedCommitSha`, when
   * given, is the exact commit the runtime must run (activation pins the verified
   * merge commit). Throws when the runtime refuses or fails to load the target.
   */
  switchTo(harnessId: string, pinnedCommitSha?: string): Promise<void> | void;
  /**
   * Optional runtime-level health probe for a harness id (used to verify a
   * switched-to harness is actually fit before a rollback is persisted).
   * When absent, rollbacks are verified by the injected `healthProbe` or are
   * considered healthy after a successful switch.
   */
  harnessHealth?(harnessId: string): boolean | Promise<boolean>;
  /**
   * Optional pre-switch freeze hook: stop the runtime from starting new work
   * on the current harness while the rollback is in flight.
   */
  freeze?(): void | Promise<void>;
}

export interface RuntimeRollbackOrchestratorOptions {
  runtime: RuntimeActivationController;
  registry?: HarnessRegistry;
  experiments?: ExperimentController;
  /** Overrides runtime.harnessHealth for the post-switch verification. */
  healthProbe?: (harnessId: string) => boolean | Promise<boolean>;
  now?: () => number;
}

export interface RuntimeRollbackStep {
  step:
    | "freeze"
    | "regression_reported"
    | "runtime_switch"
    | "health_verification"
    | "rollback_recorded"
    | "registry_rolled_back"
    | "reactivation_recorded";
  at: number;
  detail?: string;
}

export interface RuntimeRollbackReport {
  ok: boolean;
  experimentId: string;
  /** Harness the runtime was executing when the rollback started. */
  fromHarness: string;
  /** Harness the runtime executes after the rollback. */
  toHarness: string;
  runtimeSwitched: boolean;
  verifiedHealthy: boolean;
  registryRolledBack: boolean;
  /** Final experiment lifecycle state (ACTIVE on success, REGRESSED on failure). */
  lifecycleState: string;
  steps: RuntimeRollbackStep[];
  error?: string;
}

/** Thrown when a runtime rollback could not be completed. */
export class RuntimeRollbackError extends Error {
  constructor(
    message: string,
    public readonly report: RuntimeRollbackReport,
  ) {
    super(message);
    this.name = "RuntimeRollbackError";
  }
}

/**
 * Orchestrates freeze → switch → verify → persist for one regressed
 * experiment, driving the experiment state machine and the registry.
 */
export class RuntimeRollbackOrchestrator {
  private readonly runtime: RuntimeActivationController;
  private readonly registry?: HarnessRegistry;
  private readonly experiments?: ExperimentController;
  private readonly healthProbe?: (harnessId: string) => boolean | Promise<boolean>;
  private readonly now: () => number;

  constructor(opts: RuntimeRollbackOrchestratorOptions) {
    this.runtime = opts.runtime;
    this.registry = opts.registry;
    this.experiments = opts.experiments;
    this.healthProbe = opts.healthProbe;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Full runtime rollback for a regressed experiment. `detail` is recorded
   * as the REGRESSED transition note; `targetHarnessId` defaults to the
   * experiment's parent harness.
   */
  async rollback(
    experimentId: string,
    opts: { detail?: string; targetHarnessId?: string } = {},
  ): Promise<RuntimeRollbackReport> {
    if (!this.experiments) {
      throw new Error("RuntimeRollbackOrchestrator requires an ExperimentController.");
    }
    const controller = this.experiments;
    const record = controller.record(experimentId);
    const target = opts.targetHarnessId ?? record.parent.harness;
    const current = controller.machine(experimentId).current();
    if (current !== "ACTIVE" && current !== "REGRESSED") {
      throw new Error(`Runtime rollback requires the experiment to be ACTIVE or REGRESSED (currently ${current}).`);
    }

    const steps: RuntimeRollbackStep[] = [];
    const fromHarness = await this.runtime.activeHarness();
    const report: RuntimeRollbackReport = {
      ok: false,
      experimentId,
      fromHarness,
      toHarness: target,
      runtimeSwitched: false,
      verifiedHealthy: false,
      registryRolledBack: false,
      lifecycleState: current,
      steps,
    };

    // 1. Freeze the regressed harness (best-effort — freezing must never
    //    block the rollback itself).
    if (this.runtime.freeze) {
      try {
        await this.runtime.freeze();
        steps.push({ step: "freeze", at: this.now(), detail: `Runtime froze ${fromHarness}` });
      } catch (err) {
        steps.push({
          step: "freeze",
          at: this.now(),
          detail: `freeze failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 2. Report the regression (ACTIVE → REGRESSED). Already-regressed
    //    experiments skip this so retries stay idempotent.
    if (current === "ACTIVE") {
      controller.reportRegression(experimentId, opts.detail ?? `Runtime rollback triggered from ${fromHarness}`);
      steps.push({ step: "regression_reported", at: this.now() });
      report.lifecycleState = "REGRESSED";
    }

    // 3. Switch the runtime onto the rollback target.
    try {
      await this.runtime.switchTo(target);
      report.runtimeSwitched = true;
      steps.push({ step: "runtime_switch", at: this.now(), detail: `Runtime switched to ${target}` });
    } catch (err) {
      // The runtime is still on the regressed harness; leave the experiment
      // honestly at REGRESSED and surface the failure.
      const detail = `Runtime switch to ${target} failed: ${err instanceof Error ? err.message : String(err)}`;
      steps.push({ step: "runtime_switch", at: this.now(), detail });
      report.error = detail;
      throw new RuntimeRollbackError(detail, report);
    }

    // 4. Verify the rollback target is actually healthy in the runtime.
    const healthy = await this.verifyHealth(target);
    if (!healthy) {
      // Refuse to persist a rollback onto a broken runtime: switch back to
      // the original (best-effort) and stay at REGRESSED.
      try {
        await this.runtime.switchTo(fromHarness);
        report.runtimeSwitched = false;
        report.toHarness = fromHarness;
      } catch {
        // Both harnesses unhealthy — operations must intervene; the state
        // stays REGRESSED and the report records the failed restore.
      }
      const detail = `Post-switch health verification failed for ${target}; runtime restored to ${fromHarness}`;
      steps.push({ step: "health_verification", at: this.now(), detail });
      report.error = detail;
      throw new RuntimeRollbackError(detail, report);
    }
    report.verifiedHealthy = true;
    steps.push({ step: "health_verification", at: this.now(), detail: `${target} healthy after switch` });

    // 5. Persist: experiment lifecycle + registry lineage.
    controller.completeRollback(experimentId, target);
    steps.push({ step: "rollback_recorded", at: this.now(), detail: `Experiment rolled back to ${target}` });
    if (this.registry) {
      this.registry.rollbackTo(target);
      report.registryRolledBack = true;
      steps.push({ step: "registry_rolled_back", at: this.now(), detail: `Registry active version → ${target}` });
    }
    report.lifecycleState = "ROLLBACK";

    // 6. The prior harness is verifiably running again — record reactivation.
    controller.advance(experimentId, "ACTIVE", `Runtime-verified rollback: ${target} reactivated`);
    report.lifecycleState = "ACTIVE";
    report.ok = true;
    steps.push({ step: "reactivation_recorded", at: this.now(), detail: `${target} is the active harness again` });

    return report;
  }

  private async verifyHealth(harnessId: string): Promise<boolean> {
    if (this.healthProbe) return this.healthProbe(harnessId);
    if (this.runtime.harnessHealth) return this.runtime.harnessHealth(harnessId);
    return true;
  }
}
