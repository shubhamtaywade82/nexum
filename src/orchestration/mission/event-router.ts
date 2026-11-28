/**
 * MissionEventRouter (SPEC §5.1) — typed fan-out for validated mission events.
 *
 * The router sits between producers (roles, coordinator — P3+) and the
 * standard sinks. It is deliberately dumb: it VALIDATES then FANS OUT. It
 * owns no state, persists nothing itself, and never retries.
 *
 * Fail-closed contract (P2 acceptance): a malformed event is NEVER forwarded
 * to any sink; the drop and its reason are recorded on the router and (when
 * supplied) reported to a drop listener, so silent data loss is impossible.
 *
 * Layering: src/orchestration/mission/** must not import ui, agents or
 * domains (tests/architecture/mission-layering.test.ts).
 */

import type { EventSink } from "../../core/types.js";
import { validateMissionEvent, type MissionEvent, type MissionEventValidation } from "./events.js";

export interface MissionEventDrop {
  reason: string;
  /** The raw value that failed validation (for the drop log; never forwarded). */
  raw: unknown;
  droppedAt: number;
}

export interface MissionEventRouterOptions {
  /** Live sinks: TUI store, approval listeners, … all receive every valid event. */
  sinks?: EventSink[];
  /** Called on every drop (audit hook). */
  onDrop?: (drop: MissionEventDrop) => void;
  /** Monotonic clock injection (tests). Default: Date.now. */
  now?: () => number;
}

export class MissionEventRouter {
  private readonly sinks: EventSink[];
  private readonly onDrop?: (drop: MissionEventDrop) => void;
  private readonly now: () => number;
  private readonly drops: MissionEventDrop[] = [];

  constructor(opts: MissionEventRouterOptions = {}) {
    this.sinks = opts.sinks ?? [];
    this.onDrop = opts.onDrop;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Validate (fail-closed) then fan out to every sink. Returns the verdict. */
  publish(event: MissionEvent | unknown): MissionEventValidation {
    const verdict = validateMissionEvent(event);
    if (!verdict.valid) {
      const drop: MissionEventDrop = {
        reason: verdict.reason ?? "invalid",
        raw: event,
        droppedAt: this.now(),
      };
      this.drops.push(drop);
      this.onDrop?.(drop);
      return verdict; // never forwarded, never silent
    }
    for (const sink of this.sinks) sink.publish(event as MissionEvent);
    return verdict;
  }

  /** Convenience for tests/audit: the recorded drops, in order. */
  recordedDrops(): readonly MissionEventDrop[] {
    return this.drops;
  }

  /** Attach another live sink (approval listeners register late). */
  addSink(sink: EventSink): this {
    this.sinks.push(sink);
    return this;
  }
}
