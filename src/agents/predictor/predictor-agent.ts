/**
 * Predictor — MAC v1 role agent (ADR-0001, SPEC §4.2).
 *
 * Evidence-grounded risk assessment and forecasting; abstains when evidence
 * is insufficient. P1 registers the ROLE ONLY: an inert, capability-scoped
 * AgentDescriptor with the SPEC §4.2 posture declarations. Behavior
 * (evidence contract validation, basis classification, abstention) arrives
 * in P4 (ROADMAP "Predictor agent").
 *
 * Pack scoping (SPEC §8.1 capability matrix row "predictor"):
 *   - history → session search/events/trace + artifact reads (evidence in)
 *   - memory  → memory recall (read-class)
 * The pack-scope test asserts the mounted packs contain no write/execute-class
 * tool for this role (SPEC §8.1 row enforcement).
 */

import type { AgentDescriptor } from "../../runtime/agent/agent-runtime.js";

/** SPEC §4.2 registration block — postures verbatim. */
export function predictorDescriptor(): AgentDescriptor {
  return {
    id: "predictor",
    displayName: "Mission Predictor",
    description: "Evidence-grounded risk assessment and forecasting; abstains when evidence is insufficient.",
    defaultCapability: "reasoning",
    defaultStrategy: "react",
    capabilities: ["predict", "risk-assessment", "analysis", "mission-reporting"],
    allowedPackIds: ["history", "memory"],
    allowedPolicies: ["readonly", "restricted"],
    supportedStrategies: ["react"],
  };
}
