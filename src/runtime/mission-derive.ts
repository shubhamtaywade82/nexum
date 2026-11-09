/**
 * Pure mission-state helpers. Plan/Execute/Complete/Understand/Inspect are
 * event-driven (agent.ts emits them directly at real orchestrator
 * boundaries). Validate/Repair/Review are NOT — they're derived here from
 * the live PlanStep[] StepStatus stream the Orchestrator already produces
 * (see orchestrator.ts's analyzing/planning/implementing/testing/reviewing
 * transitions), so no new orchestrator logic is needed for them.
 */

import { PlanStep } from "../core/plan/plan-contracts.js";
import { MISSION_PHASE_LABELS, MISSION_PHASE_ORDER, MissionPhase, MissionState } from "./types.js";

const STEP_IN_FLIGHT: readonly PlanStep["status"][] = [
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "running",
];

/** "Execute > Generate migration" breadcrumb for the Activity Feed — undefined outside an active mission (nothing to attribute the entry to). */
export function missionCrumb(mission: MissionState): string | undefined {
  const running = mission.phases.find((p) => p.status === "running");
  if (!running) return undefined;
  const label = MISSION_PHASE_LABELS[running.id];
  if (running.id !== "execute") return label;
  const activeStep = mission.steps.find((s) => STEP_IN_FLIGHT.includes(s.status));
  return activeStep ? `${label} > ${activeStep.description}` : label;
}

export function createMissionState(goal: string): MissionState {
  return {
    goal,
    phases: MISSION_PHASE_ORDER.map((id) => ({ id, status: "pending" as const })),
    steps: [],
  };
}

function findPhase(phases: MissionPhase[], id: MissionPhase["id"]): MissionPhase | undefined {
  return phases.find((p) => p.id === id);
}

function patchPhase(phases: MissionPhase[], id: MissionPhase["id"], status: MissionPhase["status"]): MissionPhase[] {
  const current = findPhase(phases, id);
  if (!current || current.status === status) return phases;
  return phases.map((p) => (p.id === id ? { ...p, status } : p));
}

/** Recomputes Validate/Repair/Review from the current step stream. Leaves every other phase untouched — those are set directly by mission.phase events. */
export function deriveMissionPhases(phases: MissionPhase[], steps: PlanStep[]): MissionPhase[] {
  const execute = findPhase(phases, "execute");
  const executeDone = execute?.status === "completed" || execute?.status === "failed";

  const anyTesting = steps.some((s) => s.status === "testing");
  const anyReviewing = steps.some((s) => s.status === "reviewing");
  const anyRetrying = steps.some(
    (s) => s.retryCount > 0 && (s.status === "pending" || s.status === "analyzing" || s.status === "implementing"),
  );
  const everRetried = steps.some((s) => s.retryCount > 0);

  let next = phases;
  next = patchPhase(next, "validate", anyTesting ? "running" : executeDone ? "completed" : "pending");
  next = patchPhase(
    next,
    "repair",
    anyRetrying ? "running" : everRetried && executeDone ? "completed" : everRetried ? "running" : "pending",
  );
  next = patchPhase(next, "review", anyReviewing ? "running" : executeDone ? "completed" : "pending");
  return next;
}
