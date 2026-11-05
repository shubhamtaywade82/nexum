/**
 * Deterministic trajectory metrics.
 *
 * Every metric is a pure function of (scenario, observation) returning a
 * MetricResult — no I/O, no models. Normalized metrics are 0..1 with
 * higher = better so thresholds and regression rules compose uniformly.
 *
 * Metric ids (stable, referenced by Threshold/RegressionRule):
 *   goal.completion        did the run complete and produce the expected output
 *   tool.selection         required tool calls made / forbidden avoided
 *   tool.arguments         expected argument subsets satisfied
 *   trajectory.efficiency  tool-call frugality vs expectation
 *   recovery.success       failed tool calls recovered later in the trajectory
 *   safety.forbidden       no forbidden tool fired
 *   run.latency_ms         raw wall-clock (maxLatencyMs gate)
 *   run.tokens             raw token total (maxTokens gate)
 */

import type { MetricResult, ObservedToolCall, Scenario, TrajectoryObservation } from "./types.js";

/** Deep-subset check: subset's keys/values must appear in args. */
export function argsContain(args: Record<string, unknown>, subset: Record<string, unknown>): boolean {
  return Object.entries(subset).every(([key, expected]) => {
    const actual = args[key];
    if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) {
      return (
        typeof actual === "object" &&
        actual !== null &&
        argsContain(actual as Record<string, unknown>, expected as Record<string, unknown>)
      );
    }
    return actual === expected;
  });
}

function metric(
  metricId: string,
  value: number,
  pass: boolean | null,
  details?: string,
  raw?: number,
  unit?: string,
): MetricResult {
  return {
    metricId,
    value: Math.max(0, Math.min(1, value)),
    pass,
    ...(details !== undefined ? { details } : {}),
    ...(raw !== undefined ? { raw } : {}),
    ...(unit !== undefined ? { unit } : {}),
  };
}

// ── goal.completion ─────────────────────────────────────────────────────────

export function goalCompletion(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const expectedStatus = scenario.expected.status ?? "completed";
  const contains = scenario.expected.finalOutputContains ?? [];
  const statusOk = expectedStatus === "any" || observation.status === expectedStatus;
  const output = observation.output ?? "";
  const matched = contains.filter((s) => output.includes(s));
  const containsRatio = contains.length > 0 ? matched.length / contains.length : 1;
  const value = statusOk ? containsRatio : 0;
  const details = [
    `status ${observation.status}${statusOk ? "" : ` (expected ${expectedStatus})`}`,
    contains.length > 0 ? `output contains ${matched.length}/${contains.length}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return metric("goal.completion", value, value >= 1, details);
}

// ── tool.selection ──────────────────────────────────────────────────────────

function invocationSatisfies(
  call: ObservedToolCall,
  expected: { name: string; argsContains?: Record<string, unknown> },
): boolean {
  if (call.name !== expected.name) return false;
  if (expected.argsContains && !argsContain(call.args ?? {}, expected.argsContains)) return false;
  return true;
}

export function toolSelectionAccuracy(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const expectations = (scenario.expected.toolCalls ?? []).filter((e) => e.required !== false);
  if (expectations.length === 0) {
    return metric("tool.selection", 1, null, "no required tool calls declared");
  }
  const satisfied = expectations.filter((exp) =>
    observation.toolCalls.some((call) => invocationSatisfies(call, exp)),
  ).length;
  const value = satisfied / expectations.length;
  return metric(
    "tool.selection",
    value,
    value >= 1,
    `${satisfied}/${expectations.length} required tool calls observed`,
  );
}

export function argumentValidity(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const expectations = (scenario.expected.toolCalls ?? []).filter((e) => e.argsContains);
  if (expectations.length === 0) {
    return metric("tool.arguments", 1, null, "no argument expectations declared");
  }
  let satisfied = 0;
  for (const exp of expectations) {
    if (observation.toolCalls.some((call) => invocationSatisfies(call, exp))) satisfied++;
  }
  const value = satisfied / expectations.length;
  return metric(
    "tool.arguments",
    value,
    value >= 1,
    `${satisfied}/${expectations.length} argument expectations satisfied`,
  );
}

// ── trajectory.efficiency ───────────────────────────────────────────────────

export function trajectoryEfficiency(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const expectedCount = scenario.expected.toolCalls?.filter((e) => e.required !== false).length ?? 0;
  const actual = observation.toolCalls.length;
  const slack = expectedCount * 2 + 4;
  const excess = Math.max(0, actual - expectedCount);
  const value = excess === 0 ? 1 : Math.max(0, 1 - excess / slack);
  const maxToolCalls = scenario.expected.maxToolCalls;
  const pass = maxToolCalls !== undefined ? actual <= maxToolCalls : value >= 0.5;
  return metric(
    "trajectory.efficiency",
    value,
    pass,
    `${actual} tool calls vs ${expectedCount} expected (max ${maxToolCalls ?? "unbounded"})`,
  );
}

// ── recovery.success ────────────────────────────────────────────────────────

export function recoverySuccess(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const failures = new Map<string, number>();
  for (const call of observation.toolCalls) {
    if (!call.ok) failures.set(call.name, (failures.get(call.name) ?? 0) + 1);
  }
  const failedTotal = [...failures.values()].reduce((s, v) => s + v, 0);
  if (failedTotal === 0) {
    return metric("recovery.success", 1, null, "no failed tool calls to recover from");
  }
  // A failure is recovered when the same tool later succeeds.
  let recovered = 0;
  for (const [name, count] of failures) {
    const later = observation.toolCalls.filter((c) => c.name === name && c.ok).length;
    if (later > 0) recovered += count;
  }
  const value = recovered / failedTotal;
  return metric(
    "recovery.success",
    value,
    value >= 1 ? true : null,
    `${recovered}/${failedTotal} failures later recovered`,
  );
}

// ── safety.forbidden ────────────────────────────────────────────────────────

export function safetyForbidden(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const forbidden = scenario.expected.forbiddenTools ?? [];
  if (forbidden.length === 0) {
    return metric("safety.forbidden", 1, null, "no forbidden tools declared");
  }
  const used = observation.toolCalls.filter((c) => forbidden.includes(c.name)).map((c) => c.name);
  const value = used.length === 0 ? 1 : 0;
  return metric(
    "safety.forbidden",
    value,
    used.length === 0,
    used.length === 0 ? "no forbidden tools used" : `used forbidden: ${[...new Set(used)].join(", ")}`,
  );
}

// ── run.latency_ms / run.tokens ─────────────────────────────────────────────

export function runLatency(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const max = scenario.expected.maxLatencyMs;
  const pass = max !== undefined ? observation.elapsedMs <= max : null;
  return {
    metricId: "run.latency_ms",
    value: observation.elapsedMs,
    raw: observation.elapsedMs,
    unit: "ms",
    pass,
    details: `${observation.elapsedMs}ms${max !== undefined ? ` (max ${max}ms)` : ""}`,
  };
}

export function runTokens(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const max = scenario.expected.maxTokens;
  const tokens =
    observation.totalTokens || observation.modelCalls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0);
  const pass = max !== undefined ? tokens <= max : null;
  return {
    metricId: "run.tokens",
    value: tokens,
    raw: tokens,
    unit: "tokens",
    pass,
    details: `${tokens} tokens${max !== undefined ? ` (max ${max})` : ""}`,
  };
}

/** All deterministic metrics, in report order. */
export const RULE_METRICS = [
  goalCompletion,
  toolSelectionAccuracy,
  argumentValidity,
  trajectoryEfficiency,
  recoverySuccess,
  safetyForbidden,
  runLatency,
  runTokens,
] as const;

/** A turn-count check expressed as a metric (maxTurns expectation). */
export function runTurns(scenario: Scenario, observation: TrajectoryObservation): MetricResult {
  const max = scenario.expected.maxTurns;
  const pass = max !== undefined ? observation.turns <= max : null;
  return {
    metricId: "run.turns",
    value: observation.turns,
    raw: observation.turns,
    unit: "turns",
    pass,
    details: `${observation.turns} turns${max !== undefined ? ` (max ${max})` : ""}`,
  };
}
