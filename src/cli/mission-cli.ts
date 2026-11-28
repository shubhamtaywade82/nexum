/**
 * `nexum mission` — the deterministic mission management surface (MAC v1 P5,
 * SPEC §14; issue #83 PR 5.3).
 *
 *   start <goal> [--autonomy profile] [--criteria a,b] [--constraint c]
 *         Create + complexity-gate + activate a mission. Deterministic only:
 *         the model-driven trio loop attaches with the interactive pilot (P8);
 *         nothing here calls a model.
 *   status <missionId>        Checkpoint state, journal size, budget so far.
 *   resume <missionId>        Re-enter at observing; orphan in-flight
 *                             delegations (never re-run, §7.3).
 *   cancel <missionId>        Terminal cancelled + cancelled-scope count; a
 *                             late cancel on a terminal mission is a no-op
 *                             recorded as a warning (I7).
 *   audit <missionId>        Reconstruct transitions, decisions +
 *                             re-validation verdicts, and budget consumption
 *                             from events + artifacts only — no LLM (§14).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, workspaceStateDir } from "../platform/paths.js";
import { resolveMissionPolicy, type MissionPolicy } from "../orchestration/mission/mission-policy.js";
import { MissionBudgetLedger } from "../orchestration/mission/mission-budget.js";
import {
  MissionCoordinator,
  MissionJournal,
  reconstructMissionAudit,
  type MissionCoordinatorOptions,
  type MissionIntent,
} from "../orchestration/mission/mission-coordinator.js";
import {
  MissionCheckpointStore,
  MissionLifecycle,
  type MissionCheckpoint,
} from "../orchestration/mission/mission-lifecycle.js";

const AUTONOMY_PROFILES = ["supervised", "controlled-autonomous", "research"] as const;
type AutonomyName = (typeof AUTONOMY_PROFILES)[number];

export interface MissionCliOptions {
  cwd?: string;
}

function missionsDirFor(cwd: string): string {
  return join(workspaceStateDir(findWorkspaceRoot(cwd)), "missions");
}

function loadCheckpoint(missionsDir: string, missionId: string): MissionCheckpoint | null {
  return new MissionCheckpointStore(join(missionsDir, missionId)).load();
}

function supervisedPolicy(): MissionPolicy {
  const resolved = resolveMissionPolicy({});
  if (!resolved.ok || !resolved.policy) throw new Error(`supervised policy refused: ${resolved.reason}`);
  return resolved.policy;
}

/** Ports are required by the coordinator type but unused by the deterministic surface. */
function unwiredPorts(): Pick<MissionCoordinatorOptions, "roles" | "workers" | "verification" | "approvals"> {
  const unwired = () => {
    throw new Error("coordinator ports not wired: the model-driven loop attaches with the interactive pilot (P8)");
  };
  return {
    roles: { observe: unwired, assess: unwired, decide: unwired },
    workers: { review: unwired, delegate: unwired },
    verification: { verify: unwired },
    approvals: { resolve: unwired },
  };
}

export async function runMissionCli(argv: string[], cliOpts: MissionCliOptions = {}): Promise<number> {
  const cwd = cliOpts.cwd ?? process.cwd();
  const missionsDir = missionsDirFor(cwd);
  const [sub, ...rest] = argv;

  if (sub === "start") {
    const goal = rest[0] && !rest[0].startsWith("--") ? rest[0] : "";
    if (!goal) {
      console.error('usage: nexum mission start "<goal>" [--autonomy profile] [--criteria a,b] [--constraint c]');
      return 1;
    }
    const flag = (name: string): string | undefined => {
      const i = rest.indexOf(`--${name}`);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const requested = (flag("autonomy") ?? "supervised") as AutonomyName;
    if (!(AUTONOMY_PROFILES as readonly string[]).includes(requested)) {
      console.error(`refused: unknown autonomy profile "${requested}" (enabled: ${AUTONOMY_PROFILES.join(", ")})`);
      return 1;
    }
    // An explicit CLI request IS explicit human config (SPEC §9 "Who enables").
    const resolved = resolveMissionPolicy({
      profile: requested,
      enabledProfiles: ["supervised", requested],
    });
    if (!resolved.ok || !resolved.policy) {
      console.error(`refused: ${resolved.reason}`);
      return 1;
    }
    const intent: MissionIntent = {
      goal,
      successCriteria: (flag("criteria") ?? "").split(",").filter(Boolean),
      constraints: (flag("constraint") ?? "").split(",").filter(Boolean),
      submittedBy: "user",
    };
    const coordinator = new MissionCoordinator({
      policy: resolved.policy,
      ...unwiredPorts(),
      missionsDir,
    });
    const outcome = await coordinator.begin(intent);
    console.log(`mission:   ${outcome.missionId}`);
    console.log(`profile:   ${resolved.policy.profile}`);
    console.log(`state:     ${outcome.state}`);
    console.log(`summary:   ${outcome.summary}`);
    console.log(`directory: ${missionsDir}`);
    return 0;
  }

  if (sub === "status") {
    const missionId = rest[0];
    if (!missionId) {
      console.error("usage: nexum mission status <missionId>");
      return 1;
    }
    const checkpoint = loadCheckpoint(missionsDir, missionId);
    if (!checkpoint) {
      console.error(`mission ${missionId}: no checkpoint under ${missionsDir}`);
      return 1;
    }
    console.log(`mission:   ${checkpoint.missionId}`);
    console.log(`state:     ${checkpoint.state}${checkpoint.degraded ? " (degraded — re-observation forced)" : ""}`);
    console.log(`seq:       ${checkpoint.seq}`);
    console.log(
      `budget:    ${checkpoint.budgetConsumed.modelCalls} model calls, ${checkpoint.budgetConsumed.toolCalls} tool calls, ${checkpoint.budgetConsumed.children} children`,
    );
    console.log(`pending:   ${checkpoint.pendingDelegations.length} delegation(s) in flight`);
    return 0;
  }

  if (sub === "resume") {
    const missionId = rest[0];
    if (!missionId) {
      console.error("usage: nexum mission resume <missionId>");
      return 1;
    }
    const checkpoint = loadCheckpoint(missionsDir, missionId);
    if (!checkpoint) {
      console.error(`mission ${missionId}: no checkpoint under ${missionsDir}`);
      return 1;
    }
    const resumed = MissionLifecycle.resume(checkpoint, {
      missionId,
      policy: supervisedPolicy(),
      ledger: new MissionBudgetLedger(supervisedPolicy()),
      missionsDir,
    });
    if (!resumed.ok) {
      console.error(`refused: ${resumed.reason}`);
      return 1;
    }
    resumed.lifecycle.checkpoint();
    for (const warning of resumed.warnings) console.log(`warning:   ${warning.message}`);
    console.log(`mission:   ${missionId}`);
    console.log("state:     observing (re-observation forced)");
    console.log(`orphaned:  ${resumed.orphaned.length > 0 ? resumed.orphaned.join(", ") : "(none)"}`);
    return 0;
  }

  if (sub === "cancel") {
    const missionId = rest[0];
    if (!missionId) {
      console.error("usage: nexum mission cancel <missionId> [reason]");
      return 1;
    }
    const reason = rest[1] && !rest[1].startsWith("--") ? rest[1] : "cancelled by user";
    const checkpoint = loadCheckpoint(missionsDir, missionId);
    if (!checkpoint) {
      console.error(`mission ${missionId}: no checkpoint under ${missionsDir}`);
      return 1;
    }
    const journal = new MissionJournal(join(missionsDir, missionId));
    const lifecycle = MissionLifecycle.fromCheckpoint(checkpoint, {
      missionId,
      policy: supervisedPolicy(),
      ledger: new MissionBudgetLedger(supervisedPolicy()),
      missionsDir,
      emit: (event) => journal.append(event),
    });
    const result = lifecycle.cancel(reason);
    if (!result.changed) {
      // I7: a late cancel on a terminal mission is a no-op recorded as a warning
      console.log(`no-op:     ${result.warning?.message ?? "mission already terminal"}`);
      return 0;
    }
    console.log(`mission:   ${missionId}`);
    console.log("state:     cancelled");
    console.log(`scopes:    ${result.cancelledScopeCount}`);
    return 0;
  }

  if (sub === "audit") {
    const missionId = rest[0];
    if (!missionId) {
      console.error("usage: nexum mission audit <missionId>");
      return 1;
    }
    const missionDir = join(missionsDir, missionId);
    if (!existsSync(join(missionDir, "events.jsonl"))) {
      console.error(`mission ${missionId}: not found under ${missionsDir}`);
      return 1;
    }
    const journal = new MissionJournal(missionDir);
    const audit = reconstructMissionAudit(journal, loadCheckpoint(missionsDir, missionId));
    console.log(`=== Mission ${audit.missionId} ===`);
    console.log(`objective: ${audit.objective || "(none)"}`);
    console.log(`outcome:   ${audit.outcome ?? "(active)"}`);
    console.log(`degraded:  ${audit.degraded}`);
    console.log("transitions:");
    for (const t of audit.transitions) {
      console.log(`  ${t.from} -> ${t.to}${t.reason ? ` (${t.reason})` : ""}`);
    }
    console.log("decisions:");
    for (const d of audit.decisions) {
      if (d.kind === "accepted") console.log(`  [accepted]   ${d.decisionId} ${d.action}`);
      else console.log(`  [rejected]   ${d.decisionId} gate=${d.gate} ${d.reason}`);
    }
    if (audit.budgetConsumed) {
      const b = audit.budgetConsumed;
      console.log(
        `budget: ${b.modelCalls} model calls, ${b.toolCalls} tool calls, ${Math.round(b.wallClockMsUsed)}ms wall clock, ${b.children} children, ${b.replans} replans`,
      );
    }
    console.log(`events: ${journal.load().length} journaled`);
    return 0;
  }

  console.error(`unknown subcommand "${String(sub)}" — usage: nexum mission <start|status|resume|cancel|audit>`);
  return 1;
}
