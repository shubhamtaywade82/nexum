/**
 * Event families — the split of the former RuntimeEvent mega-union
 * (review item 12) into four coherent families:
 *
 *   ExecutionEvent      what the machine is doing (persisted + replayable)
 *   DomainEvent         what the world looks like (git, mcp, lsp, skills)
 *   StateEvent          how runtime state is projected (context, usage, transcript)
 *   PresentationEvent   what the UI should show (theme, notification, logs)
 *
 * The concrete unions live in runtime/events/*; this module owns the
 * contract: family tags, classification, guards, and family-filtered
 * sinks. It is deliberately structural (works over any `{ type }`) so the
 * core plane never imports runtime concrete types.
 */

export type EventFamily = "execution" | "domain" | "state" | "presentation";

/** Prefix → family routing. Longest-prefix wins; "domain" is the fallback. */
const FAMILY_BY_PREFIX: Array<readonly [string, EventFamily]> = [
  // Execution: the act of running tasks and tools.
  ["tool.", "execution"],
  ["task.", "execution"],
  ["execution.", "execution"],
  ["mission.", "execution"],
  ["node.", "execution"],
  ["model.answered", "execution"],
  ["approval.", "execution"],
  ["clarification.", "execution"],
  ["mcp.elicitation.", "execution"],
  ["conversation.tool_call", "execution"],
  ["conversation.test_result", "execution"],
  // Presentation: UI-visible chrome that is not execution itself.
  ["theme.", "presentation"],
  ["notification", "presentation"],
  ["error", "presentation"],
  ["logs.", "presentation"],
  // State: runtime state projections.
  ["conversation.", "state"],
  ["context.", "state"],
  ["usage.", "state"],
  ["status.", "state"],
  ["mode.", "state"],
  ["model.streaming", "state"],
  // Domain: world state.
  ["model.", "domain"],
  ["sandbox.", "domain"],
];

const EXACT_FAMILY: Record<string, EventFamily> = {
  notification: "presentation",
  error: "presentation",
  "model.answered": "execution",
  "model.streaming": "state",
  "model.changed": "domain",
};

export function familyOf(event: { type: string }): EventFamily {
  const exact = EXACT_FAMILY[event.type];
  if (exact) return exact;
  for (const [prefix, family] of FAMILY_BY_PREFIX) {
    if (event.type.startsWith(prefix)) return family;
  }
  // git.*, memory.*, mcp.*, lsp.*, rails.*, skills.*, project.* describe
  // the world/state rather than the act of execution.
  return "domain";
}

export function isExecutionEvent(event: { type: string }): boolean {
  return familyOf(event) === "execution";
}

export function isDomainEvent(event: { type: string }): boolean {
  return familyOf(event) === "domain";
}

export function isStateEvent(event: { type: string }): boolean {
  return familyOf(event) === "state";
}

export function isPresentationEvent(event: { type: string }): boolean {
  return familyOf(event) === "presentation";
}

/** Sink contract (structural supertype of the runtime EventBus). */
export interface KernelEventSink {
  publish(event: { type: string }): void;
}

/**
 * A family-filtering event sink. Wraps any sink (or EventBus) and only
 * forwards events of the requested families — the seam that lets a single
 * bus behave like four families without rewriting publishers.
 *
 * `persistableSink(sink)` = filteringSink(sink, ["execution"]) — what the
 * ExecutionEventStore subscribes with (review item 13).
 */
export function filteringSink<T extends { type: string }>(
  sink: { publish(event: T): void },
  families: readonly EventFamily[],
): { publish(event: T): void } {
  return {
    publish(event: T) {
      if (families.includes(familyOf(event))) sink.publish(event);
    },
  };
}

export function persistableSink<T extends { type: string }>(sink: { publish(event: T): void }) {
  return filteringSink(sink, ["execution"]);
}
