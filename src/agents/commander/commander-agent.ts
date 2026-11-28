/**
 * Commander — MAC v1 role agent (ADR-0001, SPEC §4.3).
 *
 * Proposes mission actions from evidence; the deterministic coordinator
 * validates and executes. P1 registers the ROLE ONLY: an inert,
 * capability-scoped AgentDescriptor with the SPEC §4.3 posture declarations.
 * The proposal→validation pipeline and MissionCoordinator arrive in P5
 * (ROADMAP "Commander agent + MissionCoordinator").
 *
 * Pack scoping (SPEC §8.1 capability matrix row "commander"):
 *   - history → session search/events/trace + artifact reads (evidence in)
 *   - memory  → memory recall (read-class)
 *   - mission-planning → P5 pack; declared now, mounted later
 * Commander has NO direct code-write packs, no shell, no docker, no git
 * mutation tools (SPEC §4.3). Implementation work happens only through
 * delegated workers, whose own postures apply.
 *
 * `allowedPolicies` deliberately excludes any permissive posture.
 */

import type { AgentDescriptor } from "../../runtime/agent/agent-runtime.js";

/** SPEC §4.3 registration block — postures verbatim. */
export function commanderDescriptor(): AgentDescriptor {
  return {
    id: "commander",
    displayName: "Mission Commander",
    description: "Proposes mission actions from evidence; the deterministic coordinator validates and executes.",
    defaultCapability: "reasoning",
    defaultStrategy: "plan_execute",
    capabilities: ["coordinate", "mission-planning", "mission-reporting"],
    allowedPackIds: ["history", "memory", "mission-planning"],
    allowedPolicies: ["standard", "restricted"], // never a permissive posture
    supportedStrategies: ["plan_execute", "react"],
  };
}
