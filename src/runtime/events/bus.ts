/**
 * The runtime event bus (review item 12 split applied).
 *
 * `RuntimeEvent` is now the *compatibility umbrella* over four coherent
 * families — ExecutionEvent, DomainEvent, StateEvent, PresentationEvent —
 * defined in their own modules. One bus still fans events out (the state
 * store is the primary subscriber; rendering reads the store), but the
 * type surface is split so:
 *
 *   - the persistence layer (runtime/persistence) subscribes to
 *     ExecutionEvent only (durable, replayable — review item 13);
 *   - headless consumers subscribe to everything except presentation;
 *   - UI vocabulary (theme/notification) never leaks into runtime code.
 *
 * Every event published by the execution runtime flows through here;
 * family classification lives in core/events/families.ts.
 */

import { ExecutionEvent } from "./execution-events.js";
import { DomainEvent } from "./domain-events.js";
import { StateEvent } from "./state-events.js";
import { PresentationEvent } from "./presentation-events.js";

export type RuntimeEvent = ExecutionEvent | DomainEvent | StateEvent | PresentationEvent;

export type { ExecutionEvent } from "./execution-events.js";
export type { DomainEvent } from "./domain-events.js";
export type { StateEvent } from "./state-events.js";
export type { PresentationEvent } from "./presentation-events.js";

export type EventListener = (event: RuntimeEvent) => void;

export interface EventBusOptions {
  /**
   * Called when a subscriber throws. Delivery continues to the other subscribers either way.
   * The default writes one line to stderr, so a broken subscriber is never silent.
   */
  onListenerError?: (error: unknown, event: RuntimeEvent) => void;
}

export class EventBus {
  private listeners = new Set<EventListener>();
  private readonly onListenerError: (error: unknown, event: RuntimeEvent) => void;

  constructor(opts: EventBusOptions = {}) {
    this.onListenerError =
      opts.onListenerError ??
      ((error, event) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[event-bus] a subscriber failed on ${event.type}: ${message}\n`);
      });
  }

  publish(event: RuntimeEvent): void {
    // One subscriber's failure must not stop fan-out to the rest, nor reach the publisher (the execution loop).
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error, event);
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
