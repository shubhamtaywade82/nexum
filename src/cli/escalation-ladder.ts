/**
 * The turn's escalation ladder. A turn starts on the quick (local) model and
 * moves to the primary model at most once.
 *
 * Only the first reason is recorded. A later escalation in the same turn is a
 * no-op: it neither re-announces nor re-runs the transition. The ladder lives
 * for one runUserMessage call, so a plan step or a retry starts on the quick
 * model again and nothing carries over.
 *
 * Before this, the escalated flag was a closure variable written from ten sites,
 * each repeating the flag write, the delegation-addendum injection and the status line.
 */

import type { Capability } from "../models/catalog.js";

export class EscalationLadder {
  private recorded: string | null = null;

  constructor(
    /** Capability the primary model answers with, from the prompt's hint. Null: the default primary. */
    private readonly hint: Capability | null,
    /** Runs once, on the transition, with the status line to show. */
    private readonly onEscalate: (status: string) => void,
  ) {}

  get escalated(): boolean {
    return this.recorded !== null;
  }

  /** Why the turn escalated, when it has. */
  get reason(): string | null {
    return this.recorded;
  }

  /** Capability answering the next model call: the quick tier until escalated, then the hint. */
  get capability(): Capability | null {
    return this.escalated ? this.hint : "quick";
  }

  /**
   * Moves the turn onto the primary model. Returns true only for the transition itself,
   * so a caller can act once. `target` names the model in the status line.
   */
  escalate(reason: string, target = "primary model"): boolean {
    if (this.recorded !== null) return false;
    this.recorded = reason;
    this.onEscalate(`escalating to ${target}: ${reason}`);
    return true;
  }
}
