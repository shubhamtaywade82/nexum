/**
 * MAC v1 mission lifecycle (SPEC §7) — P5.
 *
 * The deterministic state machine behind the MissionCoordinator: the §7.1
 * transition table, the `degraded` health overlay, terminal-state
 * immutability (I7), checkpoints (§7.3), resume with delegation orphaning,
 * and cancellation mapped onto `DefaultAgentRuntime.cancel` semantics
 * (§7.4 — the coordinator owns the cancellation scope; children cancel with
 * the parent by DelegationPolicy default).
 *
 * Naming note (F-2): the TUI's `MissionState` (src/runtime/types.ts — the
 * Plan/Execute/Validate phase stream) stays THE MissionState. The lifecycle
 * union here is `MissionLifecycleState` so the two vocabulararies never
 * collide; the coordinator maps lifecycle states onto TUI phases (§11.5).
 *
 * `degraded` is a health overlay, NOT a state (SPEC §7.1): a mission in any
 * active state may be marked degraded (TrackerHealth), which forces
 * re-observation before the next productive decision. It never unblocks
 * itself — only a fresh tracker observation clears it.
 *
 * Every transition emits a `mission.phase` event and persists a checkpoint
 * (§7.2); terminal states are immutable — a late cancel on a completed
 * mission is a no-op recorded as a warning, never a rewrite (I7).
 */

import { mkdirSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { newCheckpointId } from "../../core/identity.js";
import { findWorkspaceRoot, workspaceStateDir } from "../../platform/paths.js";
import type { MissionPolicy } from "./mission-policy.js";
import type { BudgetDimensionExceeded, BudgetSnapshot, MissionBudgetLedger } from "./mission-budget.js";
import type { MissionEvent } from "./events.js";

// ── Lifecycle states (SPEC §7.1) ─────────────────────────────────────────────

export const MISSION_LIFECYCLE_STATES = [
  "created",
  "triaging",
  "single_agent",
  "observing",
  "assessing",
  "planning",
  "executing",
  "verifying",
  "awaiting_approval",
  "completed",
  "failed",
  "aborted",
  "cancelled",
] as const;

export type MissionLifecycleState = (typeof MISSION_LIFECYCLE_STATES)[number];

export type TerminalMissionState = "completed" | "failed" | "aborted" | "cancelled";

export const TERMINAL_MISSION_STATES: readonly TerminalMissionState[] = ["completed", "failed", "aborted", "cancelled"];

export const missionLifecycleStateSchema = z.enum(MISSION_LIFECYCLE_STATES);

export function isTerminalMissionState(state: MissionLifecycleState): state is TerminalMissionState {
  return (TERMINAL_MISSION_STATES as readonly string[]).includes(state);
}

/**
 * The §7.1 transition table, verbatim. Budget exhaustion is not in the
 * table — it is the deterministic escape hatch `fail()` (§11.2: "on budget
 * exhausted -> failed"), reachable from any active state; the same holds
 * for user cancellation `cancel()` (§7.4).
 */
const MISSION_TRANSITIONS: Record<
  Exclude<MissionLifecycleState, TerminalMissionState>,
  readonly MissionLifecycleState[]
> = {
  created: ["triaging"],
  triaging: ["single_agent", "observing"],
  single_agent: ["completed"],
  observing: ["assessing"],
  assessing: ["planning", "observing"],
  planning: ["executing", "awaiting_approval", "aborted"],
  executing: ["verifying", "awaiting_approval"],
  verifying: ["completed", "planning", "failed"],
  awaiting_approval: ["executing", "aborted"],
};

export function canTransitionMission(from: MissionLifecycleState, to: MissionLifecycleState): boolean {
  if (isTerminalMissionState(from)) return false; // I7: terminal states are immutable
  const allowed = MISSION_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** States that may carry the degraded overlay (the §7.1 diagram's degraded edges). */
const DEGRADABLE_STATES: readonly MissionLifecycleState[] = [
  "observing",
  "assessing",
  "planning",
  "executing",
  "verifying",
  "awaiting_approval",
];

// ── Task graph snapshot (checkpoint §7.3) ───────────────────────────────────

export type TaskNodeStatus = "pending" | "in_flight" | "done" | "failed" | "orphaned";

export interface TaskGraphSnapshotNode {
  nodeId: string;
  status: TaskNodeStatus;
  replanCount: number;
}

export interface TaskGraphSnapshot {
  nodes: TaskGraphSnapshotNode[];
}

export const taskGraphSnapshotSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            status: z.enum(["pending", "in_flight", "done", "failed", "orphaned"]),
            replanCount: z.number().int().min(0),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

// ── Mission checkpoint (SPEC §7.3, verbatim shape) ──────────────────────────

export interface MissionCheckpoint {
  missionId: string;
  /** Matches the last mission event seq. */
  seq: number;
  state: MissionLifecycleState;
  taskGraph?: TaskGraphSnapshot;
  /** DelegationIds in flight at checkpoint time. */
  pendingDelegations: string[];
  budgetConsumed: BudgetSnapshot;
  /** Artifact ids recorded so far. */
  artifacts: string[];
  /** Health overlay carried across resume (§7.1: degraded is an overlay, not a phase). */
  degraded: boolean;
  createdAt: string;
}

export const missionCheckpointSchema = z
  .object({
    missionId: z.string().min(1),
    seq: z.number().int().min(0),
    state: missionLifecycleStateSchema,
    taskGraph: taskGraphSnapshotSchema.optional(),
    pendingDelegations: z.array(z.string()).default([]),
    budgetConsumed: z.object({
      wallClockMsUsed: z.number().min(0),
      modelCalls: z.number().int().min(0),
      toolCalls: z.number().int().min(0),
      totalTokens: z.number().min(0),
      children: z.number().int().min(0),
      replans: z.number().int().min(0),
      decisionRejections: z.number().int().min(0),
    }),
    artifacts: z.array(z.string()).default([]),
    degraded: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strict();

/**
 * Mission checkpoint store: one record per mission at
 * `.nexum/missions/<missionId>/checkpoint.json`, extending the existing
 * checkpoint behavior (atomic tmp+rename write, same as
 * src/runtime/checkpoint.ts).
 */
export class MissionCheckpointStore {
  constructor(private readonly missionDir: string) {}

  get path(): string {
    return join(this.missionDir, "checkpoint.json");
  }

  save(checkpoint: MissionCheckpoint): void {
    mkdirSync(this.missionDir, { recursive: true });
    const validated = missionCheckpointSchema.safeParse(checkpoint);
    if (!validated.success) {
      throw new Error(`invalid mission checkpoint: ${validated.error.issues[0]?.message ?? "schema violation"}`);
    }
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(validated.data, null, 2));
    renameSync(tmpPath, this.path); // atomic: a crash mid-write leaves the old checkpoint
  }

  load(): MissionCheckpoint | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = missionCheckpointSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? (parsed.data as MissionCheckpoint) : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}

// ── Lifecycle record + results ──────────────────────────────────────────────

export interface LifecycleWarning {
  kind: "late-cancel" | "terminal-transition" | "degraded-forced" | "resume-orphaned";
  message: string;
  at: number;
}

export interface MissionLifecycleRecord {
  state: MissionLifecycleState;
  degraded: boolean;
  replanCount: number;
  pendingDelegations: string[];
  taskGraph?: TaskGraphSnapshot;
  artifacts: string[];
  warnings: LifecycleWarning[];
  /** Every applied transition, for audit reconstruction (§14). */
  history: Array<{ from: MissionLifecycleState; to: MissionLifecycleState; reason: string; at: number }>;
}

export interface LifecycleTransitionResult {
  ok: boolean;
  /** Refusal reason when ok is false (never silent). */
  reason?: string;
  /** Itemized exceeded dimensions when the refusal was budget-exhausted (INV-1). */
  exceeded?: BudgetDimensionExceeded[];
  record?: MissionLifecycleRecord;
  /** The mission.phase event emitted on success. */
  phaseEvent?: MissionEvent;
  /** The mission.checkpoint event emitted on success. */
  checkpointEvent?: MissionEvent;
  /** The terminal event (mission.completed/failed/aborted) when the transition is terminal. */
  terminalEvent?: MissionEvent;
  checkpoint?: MissionCheckpoint;
}

export interface MissionCancelResult {
  /** False only when the mission was already terminal (I7 no-op). */
  changed: boolean;
  record: MissionLifecycleRecord;
  /** Set when the cancel was a late no-op (recorded as a warning, never a rewrite). */
  warning?: LifecycleWarning;
  /** The mission.cancelled event (with the cancelled-scope count) when changed. */
  event?: MissionEvent;
  cancelledScopeCount?: number;
}

export interface MissionLifecycleOptions {
  missionId: string;
  policy: MissionPolicy;
  ledger: MissionBudgetLedger;
  /** Directory holding `<missionId>/checkpoint.json`; default `.nexum/missions`. */
  missionsDir?: string;
  /** Optional mission event sink (the P2 router / coordinator sink). */
  emit?: (event: MissionEvent) => void;
  now?: () => number;
  /** Starting seq for the internal event counter (resume continues from it). */
  startSeq?: number;
}

// ── The lifecycle machine ───────────────────────────────────────────────────

export class MissionLifecycle {
  readonly missionId: string;
  readonly checkpointStore: MissionCheckpointStore;
  private readonly policy: MissionPolicy;
  private readonly ledger: MissionBudgetLedger;
  private readonly emitEvent?: (event: MissionEvent) => void;
  private readonly now: () => number;
  private rec: MissionLifecycleRecord;
  private lastSeq: number;

  private constructor(opts: MissionLifecycleOptions, initial: MissionLifecycleRecord) {
    this.missionId = opts.missionId;
    this.policy = opts.policy;
    this.ledger = opts.ledger;
    this.emitEvent = opts.emit;
    this.now = opts.now ?? (() => Date.now());
    const dir = opts.missionsDir ?? join(workspaceStateDir(findWorkspaceRoot(process.cwd())), "missions");
    this.checkpointStore = new MissionCheckpointStore(join(dir, opts.missionId));
    this.lastSeq = opts.startSeq ?? 0;
    this.rec = initial;
  }

  /** A mission begins in `created` (§7.1). */
  static begin(opts: MissionLifecycleOptions): MissionLifecycle {
    return new MissionLifecycle(opts, {
      state: "created",
      degraded: false,
      replanCount: 0,
      pendingDelegations: [],
      artifacts: [],
      warnings: [],
      history: [],
    });
  }

  /**
   * Restore a lifecycle positioned at a checkpoint — the deterministic
   * management surface (status/cancel). The coordination loop resumes via
   * `resume` instead (fresh observation forced); `fromCheckpoint` restores
   * the recorded state verbatim, in-flight delegations included.
   */
  static fromCheckpoint(checkpoint: MissionCheckpoint, opts: MissionLifecycleOptions): MissionLifecycle {
    return new MissionLifecycle(
      { ...opts, startSeq: checkpoint.seq },
      {
        state: checkpoint.state,
        degraded: checkpoint.degraded,
        replanCount: 0,
        pendingDelegations: [...checkpoint.pendingDelegations],
        ...(checkpoint.taskGraph ? { taskGraph: checkpoint.taskGraph } : {}),
        artifacts: [...checkpoint.artifacts],
        warnings: [],
        history: [],
      },
    );
  }

  /**
   * Resume from a checkpoint (§7.3 resume semantics, acceptance-tested):
   * re-observes first (Tracker), marks the previous incarnation's in-flight
   * delegations as ORPHANED (never silently re-run — the tool pipeline's
   * idempotency keys protect double execution), and re-enters the loop at
   * `observing`. Completed verified nodes are never re-executed. A terminal
   * checkpoint is immutable and cannot be resumed (I7).
   */
  static resume(
    checkpoint: MissionCheckpoint,
    opts: MissionLifecycleOptions,
  ):
    | { ok: true; lifecycle: MissionLifecycle; orphaned: string[]; warnings: LifecycleWarning[] }
    | { ok: false; reason: string } {
    if (isTerminalMissionState(checkpoint.state)) {
      return {
        ok: false,
        reason: `mission ${checkpoint.missionId} is terminal (${checkpoint.state}): terminal states are immutable (I7)`,
      };
    }
    const orphaned = [...checkpoint.pendingDelegations];
    const warnings: LifecycleWarning[] = [];
    const at = (opts.now ?? (() => Date.now()))();
    // In-flight task nodes are not trusted after a crash — they may or may
    // not have finished; they are marked orphaned, never silently re-run.
    let taskGraph = checkpoint.taskGraph;
    if (taskGraph) {
      const nodes = taskGraph.nodes.map((node) =>
        node.status === "in_flight" ? { ...node, status: "orphaned" as const } : node,
      );
      const orphanedNodes = nodes.filter((n) => n.status === "orphaned").length;
      taskGraph = { nodes };
      if (orphanedNodes > 0) {
        warnings.push({
          kind: "resume-orphaned",
          message: `${orphanedNodes} in-flight task node(s) marked orphaned; completed nodes are kept and never re-executed`,
          at,
        });
      }
    }
    for (const id of orphaned) {
      warnings.push({
        kind: "resume-orphaned",
        message: `delegation ${id} orphaned by resume; never silently re-run (idempotency keys protect double execution)`,
        at,
      });
    }
    const lifecycle = new MissionLifecycle(
      { ...opts, startSeq: checkpoint.seq },
      {
        // Re-enter the loop at observing: re-observation comes first.
        state: "observing",
        // The overlay forces the fresh observation before the next decision:
        // it clears only via clearDegradedAfterObservation (a fresh report).
        degraded: true,
        replanCount: 0,
        pendingDelegations: [],
        taskGraph,
        artifacts: [...checkpoint.artifacts],
        warnings: [],
        history: [{ from: checkpoint.state, to: "observing", reason: "resume", at }],
      },
    );
    return { ok: true, lifecycle, orphaned, warnings };
  }

  get state(): MissionLifecycleState {
    return this.rec.state;
  }

  get record(): MissionLifecycleRecord {
    return this.rec;
  }

  get degraded(): boolean {
    return this.rec.degraded;
  }

  get lastEventSeq(): number {
    return this.lastSeq;
  }

  /**
   * Apply a §7.1 table transition. Refuses (fail-closed, with reason):
   *   - transitions out of a terminal state (I7: immutable, warning recorded)
   *   - edges not in the table
   *   - non-terminal targets while degraded (forced re-observation, §7.1)
   *   - non-terminal targets when the budget envelope is exhausted (INV-2:
   *     budgets are checked before dispatch; the caller must `fail`)
   * On success: state updates, a `mission.phase` event + a
   * `mission.checkpoint` event are emitted, and the checkpoint is persisted.
   */
  transition(to: MissionLifecycleState, reason = ""): LifecycleTransitionResult {
    if (isTerminalMissionState(this.rec.state)) {
      const warning: LifecycleWarning = {
        kind: "terminal-transition",
        message: `transition to "${to}" refused: mission is terminal (${this.rec.state}) and immutable (I7)`,
        at: this.now(),
      };
      this.rec.warnings.push(warning);
      return { ok: false, reason: warning.message, record: this.rec };
    }
    // While degraded, the only additional edge is the recovery path:
    // any active state -> observing (§7.1 diagram, "degraded --> observing").
    const isDegradedRecovery = this.rec.degraded && to === "observing";
    if (!isDegradedRecovery && !canTransitionMission(this.rec.state, to)) {
      return {
        ok: false,
        reason: `invalid transition ${this.rec.state} -> ${to} (SPEC §7.1 transition table)`,
        record: this.rec,
      };
    }
    if (this.rec.degraded && to !== "observing" && !isTerminalMissionState(to)) {
      return {
        ok: false,
        reason: `mission is degraded: re-observation (-> observing) is forced before the next productive transition (SPEC §7.1)`,
        record: this.rec,
      };
    }
    if (!isTerminalMissionState(to)) {
      const preflight = this.ledger.preflight();
      if (!preflight.ok) {
        return {
          ok: false,
          reason: `budget_exhausted: ${preflight.exceeded.map((e) => `${e.dimension} ${e.consumed}/${e.limit}`).join(", ")}`,
          exceeded: preflight.exceeded,
          record: this.rec,
        };
      }
    }
    const from = this.rec.state;
    this.rec = {
      ...this.rec,
      state: to,
      history: [...this.rec.history, { from, to, reason, at: this.now() }],
    };
    // NOTE: a degraded overlay persists through the forced transition into
    // `observing` — it clears ONLY via clearDegradedAfterObservation, when
    // the fresh tracker report lands (SPEC §7.1: "never unblocks by itself").
    const phaseEvent = this.emit({
      type: "mission.phase",
      missionId: this.missionId,
      agentId: "coordinator",
      payload: { from, to, reason },
    });
    // A table-driven transition into a terminal state emits the terminal
    // event (mission.completed/failed/aborted) with the transition reason.
    let terminalEvent: MissionEvent | undefined;
    if (isTerminalMissionState(to) && to !== "cancelled") {
      terminalEvent = this.emit({
        type: `mission.${to}`,
        missionId: this.missionId,
        agentId: "coordinator",
        payload: { outcome: to, summary: reason, evidenceRefs: [] },
      });
    }
    const checkpointEvent = this.emit({
      type: "mission.checkpoint",
      missionId: this.missionId,
      agentId: "coordinator",
      payload: { checkpointId: newCheckpointId(), label: `state:${to}`, artifactIds: this.rec.artifacts },
    });
    // Persisted last so checkpoint.seq matches the last emitted mission event.
    const checkpoint = this.checkpoint();
    return {
      ok: true,
      record: this.rec,
      phaseEvent,
      checkpointEvent,
      ...(terminalEvent ? { terminalEvent } : {}),
      checkpoint,
    };
  }

  /**
   * Deterministic escape hatch (§11.2 "on budget exhausted -> failed"):
   * reachable from ANY active state, bypassing the table — only the
   * coordinator's deterministic arms use it (budget exhaustion, replan
   * exhaustion, decision loop). Emits `mission.failed` with the itemized
   * consumption when exceeded dimensions are provided.
   */
  fail(reason: string, exceeded?: BudgetDimensionExceeded[]): LifecycleTransitionResult {
    if (isTerminalMissionState(this.rec.state)) {
      const warning: LifecycleWarning = {
        kind: "terminal-transition",
        message: `fail refused: mission is already terminal (${this.rec.state}) and immutable (I7)`,
        at: this.now(),
      };
      this.rec.warnings.push(warning);
      return { ok: false, reason: warning.message, record: this.rec };
    }
    const from = this.rec.state;
    const summary =
      exceeded && exceeded.length > 0
        ? `${reason} (${exceeded.map((e) => `${e.dimension} ${e.consumed}/${e.limit}`).join(", ")})`
        : reason;
    this.rec = {
      ...this.rec,
      state: "failed",
      history: [...this.rec.history, { from, to: "failed", reason, at: this.now() }],
    };
    const event = this.emit({
      type: "mission.failed",
      missionId: this.missionId,
      agentId: "coordinator",
      payload: { outcome: "failed", summary, evidenceRefs: [] },
    });
    const checkpoint = this.checkpoint();
    return { ok: true, record: this.rec, phaseEvent: event, checkpoint };
  }

  /**
   * Cancellation (§7.4): reachable from any active state, mapped onto
   * `DefaultAgentRuntime.cancel(runId)` semantics by the coordinator (the
   * mission's cancellation scope reaches in-flight model calls, tool calls,
   * shell containers and delegated children — `cancelWithParent` is the
   * DelegationPolicy default). A late cancel on a terminal mission is a
   * NO-OP recorded as a warning — the terminal state is never rewritten (I7).
   */
  cancel(reason: string): MissionCancelResult {
    if (isTerminalMissionState(this.rec.state)) {
      const warning: LifecycleWarning = {
        kind: "late-cancel",
        message: `late cancel refused (mission is ${this.rec.state}, terminal — immutable, I7): ${reason}`,
        at: this.now(),
      };
      this.rec.warnings.push(warning);
      return { changed: false, record: this.rec, warning };
    }
    const from = this.rec.state;
    // cancelled-scope count: the mission's own scope + every in-flight child.
    const cancelledScopeCount = 1 + this.rec.pendingDelegations.length;
    const pending = [...this.rec.pendingDelegations];
    this.rec = {
      ...this.rec,
      state: "cancelled",
      pendingDelegations: [],
      history: [...this.rec.history, { from, to: "cancelled", reason, at: this.now() }],
    };
    const event = this.emit({
      type: "mission.cancelled",
      missionId: this.missionId,
      agentId: "coordinator",
      payload: {
        outcome: "cancelled",
        summary: `${reason} (cancelled ${cancelledScopeCount} scope${cancelledScopeCount === 1 ? "" : "s"}${pending.length > 0 ? `: ${pending.join(", ")}` : ""})`,
        evidenceRefs: [],
      },
    });
    this.checkpoint();
    return { changed: true, record: this.rec, event, cancelledScopeCount };
  }

  /**
   * Mark the mission degraded (health overlay, §7.1) — allowed from any
   * active state; forces re-observation before the next productive decision.
   * Never unblocks by itself: only `clearDegradedAfterObservation` (a fresh
   * tracker report) clears it.
   */
  markDegraded(): { ok: boolean; reason?: string } {
    if (isTerminalMissionState(this.rec.state)) {
      return { ok: false, reason: `mission is terminal (${this.rec.state}): degraded overlay does not apply` };
    }
    if (!DEGRADABLE_STATES.includes(this.rec.state)) {
      return { ok: false, reason: `state ${this.rec.state} cannot carry the degraded overlay (SPEC §7.1)` };
    }
    this.rec = { ...this.rec, degraded: true };
    this.rec.warnings.push({
      kind: "degraded-forced",
      message: "tracker health degraded: re-observation forced before the next decision (SPEC §7.1)",
      at: this.now(),
    });
    return { ok: true };
  }

  /** A fresh tracker observation landed: the overlay may clear. */
  clearDegradedAfterObservation(): { ok: boolean; reason?: string } {
    if (this.rec.state !== "observing") {
      return { ok: false, reason: `degraded overlay clears only on a fresh observation (state is ${this.rec.state})` };
    }
    this.rec = { ...this.rec, degraded: false };
    return { ok: true };
  }

  /** Track a delegation as in flight (checkpoint pendingDelegations). */
  trackDelegation(delegationId: string): void {
    if (!this.rec.pendingDelegations.includes(delegationId)) {
      this.rec = { ...this.rec, pendingDelegations: [...this.rec.pendingDelegations, delegationId] };
    }
  }

  /** A delegation settled (completed or failed) — no longer in flight. */
  settleDelegation(delegationId: string): void {
    this.rec = {
      ...this.rec,
      pendingDelegations: this.rec.pendingDelegations.filter((id) => id !== delegationId),
    };
  }

  /** Replace the task graph snapshot (the coordinator updates node statuses). */
  setTaskGraph(snapshot: TaskGraphSnapshot): void {
    this.rec = { ...this.rec, taskGraph: snapshot };
  }

  /** Record an artifact id (checkpoint artifacts). */
  recordArtifact(artifactId: string): void {
    if (!this.rec.artifacts.includes(artifactId)) {
      this.rec = { ...this.rec, artifacts: [...this.rec.artifacts, artifactId] };
    }
  }

  /**
   * Persist and return the checkpoint (§7.3). `seq` matches the last mission
   * event seq; the budget consumption comes from the ledger.
   */
  checkpoint(): MissionCheckpoint {
    const cp: MissionCheckpoint = {
      missionId: this.missionId,
      seq: this.lastSeq,
      state: this.rec.state,
      ...(this.rec.taskGraph ? { taskGraph: this.rec.taskGraph } : {}),
      pendingDelegations: [...this.rec.pendingDelegations],
      budgetConsumed: this.ledger.snapshot(),
      artifacts: [...this.rec.artifacts],
      degraded: this.rec.degraded,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.checkpointStore.save(cp);
    return cp;
  }

  /**
   * Hand a mission event to the sink and advance the mission-plane event
   * counter (checkpoint `seq` matches the last mission event). The seq lives
   * on the surrounding EventEnvelope in the recorder path (P2 contract —
   * strict validation rejects extra payload fields), so the counter is kept
   * here, mission-scoped, instead of stamping the event.
   */
  private emit(event: MissionEvent): MissionEvent {
    this.lastSeq += 1;
    this.emitEvent?.(event);
    return event;
  }
}
