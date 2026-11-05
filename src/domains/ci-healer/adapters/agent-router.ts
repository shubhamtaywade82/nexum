import type { AgentOutcome, AgentPort, Logger } from "../application/ports.js";
import { isRecoverable } from "../errors.js";
import type { LedgerStore } from "../persistence/ledger-store.js";

export interface RuntimeCandidate {
  /** Stable name used for cooldown state and logs, for example "nexum" or "opencode:ollama/qwen2.5-coder:7b". */
  name: string;
  agent: AgentPort;
}

export interface BreakerPolicy {
  rateLimitCooldownMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

export interface AgentRouterOptions {
  repository: string;
  candidates: RuntimeCandidate[];
  store: LedgerStore;
  log: Logger;
  policy: BreakerPolicy;
  now: () => Date;
  /** Discards a failed runtime's partial edits before the next candidate runs. */
  reset: (workspace: string) => Promise<void>;
}

const RATE_LIMIT = /\b429\b|rate[ -]?limit|quota|too many requests/i;

/**
 * Ordered runtime chain with circuit breakers. Each candidate is tried in turn. A
 * candidate in cooldown is skipped. A failure counts toward its breaker. A rate-limit
 * error opens the breaker for a longer cooldown. A success resets it. The chain
 * returns the first completed outcome, or a failure that lists every candidate's
 * error.
 */
export class AgentRouter implements AgentPort {
  constructor(private readonly options: AgentRouterOptions) {}

  async execute(input: { workspace: string; goal: string }): Promise<AgentOutcome> {
    const { repository, candidates, store, log, policy, now, reset } = this.options;
    const errors: string[] = [];

    for (const [index, candidate] of candidates.entries()) {
      if (store.runtimeCoolingDown(repository, candidate.name, now().getTime())) {
        log.info("skipping runtime in cooldown", { runtime: candidate.name });
        errors.push(`${candidate.name}: cooling down`);
        continue;
      }

      let outcome: AgentOutcome;
      try {
        outcome = await candidate.agent.execute(input);
      } catch (error) {
        if (!isRecoverable(error)) throw error;
        outcome = { status: "failed", output: "", error: (error as Error).message };
      }

      if (outcome.status === "completed") {
        store.recordRuntimeSuccess(repository, candidate.name);
        return { ...outcome, runtime: candidate.name };
      }

      const detail = outcome.error ?? outcome.status;
      const rateLimited = RATE_LIMIT.test(detail);
      const state = store.recordRuntimeFailure(repository, candidate.name, {
        rateLimited,
        nowMs: now().getTime(),
        rateLimitCooldownMs: policy.rateLimitCooldownMs,
        breakerThreshold: policy.breakerThreshold,
        breakerCooldownMs: policy.breakerCooldownMs,
        error: detail.slice(0, 500),
      });
      log.warn("runtime failed", {
        runtime: candidate.name,
        rate_limited: rateLimited,
        consecutive_failures: state.consecutiveFailures,
        error: detail.slice(0, 300),
      });
      errors.push(`${candidate.name}: ${detail.slice(0, 300)}`);

      if (index < candidates.length - 1) await reset(input.workspace);
    }

    return { status: "failed", output: "", error: errors.join(" | ") || "no runtime configured" };
  }
}
