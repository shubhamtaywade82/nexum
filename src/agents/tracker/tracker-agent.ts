/**
 * Tracker — MAC v1 role agent (ADR-0001, SPEC §4.1).
 *
 * Observes repository, tests, CI, agent traces and budgets; publishes
 * evidence-grounded observations. P1 registers the ROLE ONLY: an inert,
 * capability-scoped AgentDescriptor with the SPEC §4.1 posture declarations.
 * No behavior is wired to it yet — execution, strategies and tool mounting
 * arrive in P3 (ROADMAP "Tracker agent").
 *
 * Pack scoping (SPEC §8.1 capability matrix row "tracker"):
 *   - filesystem  → read/list/search only; the pack-scope test asserts the
 *                   mounted pack contains no write/execute-class tool for
 *                   this role (write tools are filtered at mount time in P3)
 *   - git         → git_read verb (READ_ONLY_SUBCOMMANDS enforced in-tool)
 *   - github      → read-only GET requests (enforced in-tool)
 *   - history     → session search/events/trace + artifact reads
 *   - memory      → memory recall (read-class)
 *   - agent-core  → core agent tools, no write surface
 */

import type { AgentDescriptor } from "../../runtime/agent/agent-runtime.js";

/** SPEC §4.1 registration block — postures verbatim. */
export function trackerDescriptor(): AgentDescriptor {
  return {
    id: "tracker",
    displayName: "Mission Tracker",
    description: "Observes repository, tests, CI, agent traces and budgets; publishes evidence-grounded observations.",
    defaultCapability: "tools",
    defaultStrategy: "react",
    capabilities: ["observe", "evidence-collection", "mission-reporting"],
    allowedPackIds: ["filesystem", "search", "git", "github", "history", "memory", "agent-core"],
    allowedPolicies: ["readonly", "restricted"],
    requiredTools: [], // no writes, no shell
    supportedStrategies: ["react", "plan_execute"],
  };
}
