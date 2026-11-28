/**
 * MAC v1 mission budget ledger + loop prevention (SPEC §12) — P5.
 *
 * Enforcement composes the existing mechanisms rather than inventing new
 * ones (SPEC §12.1):
 *
 *   - `BudgetManager` (run-level ceilings, `deriveChild` propagation) — the
 *     ledger owns the mission's root budget manager; every child run derives
 *     from it, so a burst of delegated children can never outrun the
 *     mission's envelope;
 *   - `DelegationPolicy` caps — child count and depth checked here at the
 *     coordinator boundary (the `Delegator` re-checks at its own review);
 *   - `LoopDetector` — repeated identical decisions and same-DAG-hash replan
 *     cycles are flagged deterministically (no model judgment, §12.2).
 *
 * INV-1: exceeding `wallClockMs` / `maxModelCalls` / `maxToolCalls` /
 * `maxTokens` / `maxChildren` terminates `failed(budget_exhausted)` with an
 * itemized consumption record.
 *
 * INV-2: budgets are checked BEFORE each dispatch (`preflight`), not after —
 * plus the replan bounds (mission-wide and per-task).
 *
 * INV-3: child-count and replan limits cannot be raised by a model-generated
 * decision (the policy layer refuses such amendments — see
 * `amendMissionPolicy`) and repeated identical decisions cannot re-enter the
 * loop (the loop guard below).
 */

import { BudgetManager } from "../../runtime/budget/budget-manager.js";
import { LoopDetector } from "../../core/loop/loop-detector.js";
import type { MissionPolicy } from "./mission-policy.js";

// ── Consumption snapshot (SPEC §7.3 budgetConsumed) ─────────────────────────

export interface BudgetSnapshot {
  wallClockMsUsed: number;
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
  children: number;
  replans: number;
  decisionRejections: number;
}

/** One exhausted dimension with its itemized consumption (INV-1). */
export interface BudgetDimensionExceeded {
  dimension: string;
  consumed: number;
  limit: number;
}

// ── Loop guard (SPEC §12.2) ────────────────────────────────────────────────

export interface DecisionSignature {
  action: string;
  taskIds: readonly string[];
  rationale: string;
}

export interface LoopGuardVerdict {
  /** False when the decision/replan must not re-enter the coordination loop. */
  admitted: boolean;
  /** True when the LoopDetector flagged a repeat. */
  flagged: boolean;
  /** Replan only: this DAG hash was returned before (SPEC §12.2 "same DAG hash twice"). */
  seenBefore?: boolean;
  /** Never silent: why the decision/replan was refused. */
  reason?: string;
}

/** "Near-identical rationale" (§12.2): compare on a normalized digest. */
function normalizeRationale(rationale: string): string {
  return rationale.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
}

/**
 * Deterministic loop prevention over the existing `LoopDetector`: identical
 * decision shapes (same action + same taskIds + near-identical rationale)
 * and replan cycles that return the same DAG hash are flagged and refused
 * re-entry — flagged decisions bypass the Commander and go to Predictor
 * reassessment or `failed(reason: decision_loop)` (§12.2), and the
 * coordinator wires that routing.
 */
export class MissionLoopGuard {
  private readonly decisions = new LoopDetector();
  private readonly replanCycles = new LoopDetector();
  private readonly dagHashes = new Set<string>();

  /** Offer a commander decision for admission; identical repeats are flagged. */
  admitDecision(decision: DecisionSignature): LoopGuardVerdict {
    const taskIds = [...decision.taskIds].sort();
    const flagged = this.decisions.record(
      "mission.decision",
      { action: decision.action, taskIds },
      normalizeRationale(decision.rationale),
    );
    if (flagged) {
      return {
        admitted: false,
        flagged: true,
        reason: `decision loop: identical decision (${decision.action} [${taskIds.join(", ")}]) repeated — bypass the Commander to Predictor reassessment or fail(decision_loop) (SPEC §12.2)`,
      };
    }
    return { admitted: true, flagged: false };
  }

  /**
   * Offer a replan for admission. A DAG hash that returns a second time is
   * the replan-cycle condition (§12.2): refused re-entry, routed to Predictor
   * reassessment. A third identical hash trips the LoopDetector and the
   * mission fails(decision_loop).
   */
  admitReplan(dagHash: string): LoopGuardVerdict {
    const seenBefore = this.dagHashes.has(dagHash);
    this.dagHashes.add(dagHash);
    const flagged = this.replanCycles.record("mission.replan", { dagHash }, "dag-hash-cycle");
    if (flagged) {
      return {
        admitted: false,
        flagged: true,
        reason: `replan loop: DAG hash ${dagHash} repeated — fail(decision_loop) (SPEC §12.2)`,
      };
    }
    if (seenBefore) {
      return {
        admitted: false,
        flagged: true,
        seenBefore: true,
        reason: `replan cycle: DAG hash ${dagHash} returned twice — route to Predictor reassessment, never re-enter planning with the same DAG (SPEC §12.2)`,
      };
    }
    return { admitted: true, flagged: false, seenBefore: false };
  }
}

// ── Budget ledger ───────────────────────────────────────────────────────────

export interface MissionBudgetLedgerOptions {
  /** Injectable clock (tests); default Date.now. */
  now?: () => number;
  /** The mission's root BudgetManager when the coordinator already built one. */
  budgetManager?: BudgetManager;
}

export interface PreflightResult {
  ok: boolean;
  /** Itemized exceeded dimensions (INV-1); empty when ok. */
  exceeded: BudgetDimensionExceeded[];
  snapshot: BudgetSnapshot;
}

/**
 * The mission-level budget envelope ledger. The coordinator calls `preflight`
 * before EVERY dispatch (INV-2: budgets are checked before dispatch, not
 * after); consumption flows through the wrapped `BudgetManager` (which
 * throws at the hard ceilings as the run-level backstop, same as the
 * ToolGateway path).
 */
export class MissionBudgetLedger {
  readonly budgetManager: BudgetManager;
  private readonly policy: MissionPolicy;
  private children = 0;
  private replans = 0;
  private readonly taskReplans = new Map<string, number>();
  private consecutiveRejections = 0;

  constructor(policy: MissionPolicy, opts: MissionBudgetLedgerOptions = {}) {
    this.policy = policy;
    this.budgetManager =
      opts.budgetManager ??
      new BudgetManager({
        budget: {
          maxModelCalls: policy.budget.maxModelCalls,
          maxToolCalls: policy.budget.maxToolCalls,
          maxTotalTokens: policy.budget.maxTokens,
          deadlineMs: policy.budget.wallClockMs,
        },
        now: opts.now,
      });
  }

  /** Current consumption across every envelope dimension. */
  snapshot(): BudgetSnapshot {
    const usage = this.budgetManager.snapshot();
    return {
      wallClockMsUsed: usage.elapsedMs,
      modelCalls: usage.modelCalls,
      toolCalls: usage.toolCalls,
      totalTokens: usage.totalTokens,
      children: this.children,
      replans: this.replans,
      decisionRejections: this.consecutiveRejections,
    };
  }

  /** Itemized exhausted dimensions (INV-1); empty when within envelope. */
  exceededDimensions(): BudgetDimensionExceeded[] {
    const e = this.policy.budget;
    const s = this.snapshot();
    const exceeded: BudgetDimensionExceeded[] = [];
    if (s.wallClockMsUsed >= e.wallClockMs) {
      exceeded.push({ dimension: "wallClockMs", consumed: s.wallClockMsUsed, limit: e.wallClockMs });
    }
    if (s.modelCalls >= e.maxModelCalls) {
      exceeded.push({ dimension: "maxModelCalls", consumed: s.modelCalls, limit: e.maxModelCalls });
    }
    if (s.toolCalls >= e.maxToolCalls) {
      exceeded.push({ dimension: "maxToolCalls", consumed: s.toolCalls, limit: e.maxToolCalls });
    }
    if (s.totalTokens >= e.maxTokens) {
      exceeded.push({ dimension: "maxTokens", consumed: s.totalTokens, limit: e.maxTokens });
    }
    if (this.children >= e.maxChildren) {
      exceeded.push({ dimension: "maxChildren", consumed: this.children, limit: e.maxChildren });
    }
    if (this.replans >= e.maxReplans) {
      exceeded.push({ dimension: "maxReplans", consumed: this.replans, limit: e.maxReplans });
    }
    if (this.consecutiveRejections >= e.maxDecisionRejections) {
      exceeded.push({
        dimension: "maxDecisionRejections",
        consumed: this.consecutiveRejections,
        limit: e.maxDecisionRejections,
      });
    }
    return exceeded;
  }

  /**
   * INV-2: check before each dispatch. Returns ok:false with the itemized
   * exceeded dimensions — the caller must fail the mission
   * (`failed(budget_exhausted)`), never dispatch.
   */
  preflight(): PreflightResult {
    const exceeded = this.exceededDimensions();
    return { ok: exceeded.length === 0, exceeded, snapshot: this.snapshot() };
  }

  /**
   * Record a model call. Delegates to the BudgetManager, which throws past
   * the hard ceiling (run-level backstop); the coordinator catches that as a
   * `budget_exhausted` termination, it never retries.
   */
  recordModelCall(usage: { promptTokens?: number; completionTokens?: number } = {}): void {
    this.budgetManager.consumeModelCall(usage);
  }

  /** Record a tool call (same throw-past-ceiling backstop). */
  recordToolCall(): void {
    this.budgetManager.consumeToolCall();
  }

  /** Derive a child budget manager for a delegated run (consumption propagates up). */
  childBudgetManager(share: number): BudgetManager {
    return this.budgetManager.deriveChild({ share });
  }

  /**
   * Record one more delegated child, checked against `maxChildren` and
   * `maxDepth` before the child starts. Refusal is fail-closed with a reason.
   */
  recordChild(depth = 1): { ok: boolean; reason?: string } {
    if (depth > this.policy.budget.maxDepth) {
      return {
        ok: false,
        reason: `delegation depth ${depth} exceeds mission maxDepth ${this.policy.budget.maxDepth}: roles and workers are leaves (SPEC §12.1)`,
      };
    }
    if (this.children + 1 > this.policy.budget.maxChildren) {
      return {
        ok: false,
        reason: `mission child budget exhausted (${this.children}/${this.policy.budget.maxChildren} children)`,
      };
    }
    this.children += 1;
    return { ok: true };
  }

  /**
   * Consume one replan, checked against the mission-wide bound AND the
   * per-task bound (INV-2). Refusal means the mission must fail, never
   * replan again.
   */
  requestReplan(taskId?: string): { ok: boolean; reason?: string; replans?: number } {
    if (this.replans + 1 > this.policy.budget.maxReplans) {
      return {
        ok: false,
        reason: `mission replan budget exhausted (${this.replans}/${this.policy.budget.maxReplans})`,
        replans: this.replans,
      };
    }
    if (taskId !== undefined) {
      const used = this.taskReplans.get(taskId) ?? 0;
      if (used + 1 > this.policy.maxReplansPerTask) {
        return {
          ok: false,
          reason: `task "${taskId}" replan budget exhausted (${used}/${this.policy.maxReplansPerTask})`,
          replans: this.replans,
        };
      }
      this.taskReplans.set(taskId, used + 1);
    }
    this.replans += 1;
    return { ok: true, replans: this.replans };
  }

  /** Consume one consecutive decision rejection (§11.4 decision-failure budget). */
  recordDecisionRejection(): { ok: boolean; reason?: string } {
    this.consecutiveRejections += 1;
    if (this.consecutiveRejections >= this.policy.budget.maxDecisionRejections) {
      return {
        ok: false,
        reason: `decision-failure budget exhausted (${this.consecutiveRejections}/${this.policy.budget.maxDecisionRejections} consecutive rejections): fail(decision_loop)`,
      };
    }
    return { ok: true };
  }

  /** An accepted decision resets the consecutive-rejection budget. */
  acceptDecision(): void {
    this.consecutiveRejections = 0;
  }

  /** Itemized consumption record for the mission report (INV-1). */
  itemized(): { envelope: MissionPolicy["budget"]; snapshot: BudgetSnapshot; exceeded: BudgetDimensionExceeded[] } {
    return {
      envelope: this.policy.budget,
      snapshot: this.snapshot(),
      exceeded: this.exceededDimensions(),
    };
  }
}
