/**
 * SubagentSession — the one owner of a subagent's lifecycle.
 *
 * Every provider used to keep its own mutable `state` and its own result
 * promise, and several of them wrote terminal states unconditionally: a late
 * interrupt could turn a completed child into "cancelled". The session makes
 * the transitions explicit and one-way:
 *
 *   - transitions follow SUBAGENT_TRANSITIONS; a terminal state never changes
 *   - the one-shot promise settles exactly once (first settlement wins)
 *   - `terminated` resolves exactly once, for one-shot and continuable children
 *     alike, so the service can free a slot and a provider can stop a process
 *     on any terminal transition, including a continuable child that dies
 */

import { newDelegationId, newRunId } from "../core/identity.js";
import type { ExecutionResult } from "../core/types.js";
import type {
  SubagentHandle,
  SubagentHandleOps,
  SubagentProviderType,
  SubagentResult,
  SubagentSpawnRequest,
  SubagentState,
} from "./contracts.js";

/** Legal lifecycle moves. Terminal states have no outgoing move. */
export const SUBAGENT_TRANSITIONS: Readonly<Record<SubagentState, readonly SubagentState[]>> = {
  pending: ["running", "cancelled", "failed"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "completed", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isLiveState(state: SubagentState): boolean {
  return state === "pending" || state === "running" || state === "paused";
}

/** Maps a child's reported outcome onto the lifecycle. Anything that is not a success or a cancel is a failure. */
export function stateForStatus(status: ExecutionResult["status"]): SubagentState {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

export interface SubagentSessionInit {
  provider: SubagentProviderType;
  request: SubagentSpawnRequest;
  /** A continuable session has no one-shot promise; it ends by cancel, failure, or the child dying. */
  continuable?: boolean;
  /** Identifiers the provider already holds (e.g. the Delegator's child run). */
  subagentId?: string;
  providerRunId?: string;
}

export class SubagentSession {
  readonly subagentId: string;
  readonly providerRunId: string;
  readonly provider: SubagentProviderType;
  readonly request: SubagentSpawnRequest;
  readonly continuable: boolean;
  /** One-shot result; undefined for continuable sessions. */
  readonly promise: Promise<SubagentResult> | undefined;
  /** Resolves once, with the terminal state. */
  readonly terminated: Promise<SubagentState>;

  private current: SubagentState = "running";
  private readonly resolveResult: (result: SubagentResult) => void;
  private readonly rejectResult: (error: Error) => void;
  private readonly resolveTerminated: (state: SubagentState) => void;

  constructor(init: SubagentSessionInit) {
    this.provider = init.provider;
    this.request = init.request;
    this.continuable = init.continuable ?? false;
    this.subagentId = init.subagentId ?? newDelegationId();
    this.providerRunId = init.providerRunId ?? newRunId();

    let resolveResult!: (result: SubagentResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<SubagentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Nobody is obliged to await a handle; an unobserved rejection must not crash the host.
    result.catch(() => {});
    this.resolveResult = resolveResult;
    this.rejectResult = rejectResult;
    this.promise = this.continuable ? undefined : result;

    let resolveTerminated!: (state: SubagentState) => void;
    this.terminated = new Promise<SubagentState>((resolve) => {
      resolveTerminated = resolve;
    });
    this.resolveTerminated = resolveTerminated;
  }

  get state(): SubagentState {
    return this.current;
  }

  get live(): boolean {
    return isLiveState(this.current);
  }

  /**
   * Requests cancellation without settling the one-shot promise. Used by in-process
   * children, whose runtime reports its own cancelled result.
   */
  markCancelled(): boolean {
    return this.transition("cancelled");
  }

  /** Cancels a live session and rejects its one-shot promise with `reason`. False when already terminal. */
  cancel(reason: string): boolean {
    if (!this.transition("cancelled")) return false;
    this.rejectResult(new Error(reason));
    return true;
  }

  /**
   * Settles the one-shot promise with the child's result. While the session is live the
   * state follows the result; a session already cancelled keeps "cancelled".
   */
  complete(result: SubagentResult): void {
    this.transition(stateForStatus(result.status));
    this.resolveResult(result);
  }

  /** Fails a live session and rejects its one-shot promise. */
  fail(error: Error): void {
    this.transition("failed");
    this.rejectResult(error);
  }

  /** Leaves the paused state when a paused child is resumed. */
  markRunning(): boolean {
    return this.transition("running");
  }

  /** Read-only handle over this session. Methods come from the provider. */
  toHandle(ops: SubagentHandleOps): SubagentHandle {
    const handle: SubagentHandle = {
      subagentId: this.subagentId,
      providerRunId: this.providerRunId,
      provider: this.provider,
      continuable: this.continuable,
      request: this.request,
      promise: this.promise,
      terminated: this.terminated,
      state: this.current,
      ...ops,
    };
    // Live read of the session: the handle can observe the state but never write it.
    Object.defineProperty(handle, "state", { enumerable: true, get: () => this.current });
    return handle;
  }

  private transition(next: SubagentState): boolean {
    if (!SUBAGENT_TRANSITIONS[this.current].includes(next)) return false;
    this.current = next;
    if (!isLiveState(next)) this.resolveTerminated(next);
    return true;
  }
}
