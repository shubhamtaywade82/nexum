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
 *   pilot                     The supervised-pilot report (P8): every mission
 *                             reconstructed from disk (SPEC §6 rule 2), the
 *                             SPEC §9 graduation verdict per class, and a
 *                             go/no-go recommendation. Exit 2 = stop-the-line
 *                             (false success / escalation finding).
 *
 * Autonomy gating (SPEC §9 "who enables", P8): `supervised` is the shipped
 * default and needs no flag; `controlled-autonomous` requires the explicit
 * NEXUM_MISSION_AUTONOMY=controlled opt-in; `research` additionally requires
 * --worktree (isolated workspace). An explicit CLI request alone never
 * escalates a profile.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, workspaceStateDir } from "../platform/paths.js";
import {
  resolveEnabledProfiles,
  resolveMissionPolicy,
  type MissionPolicy,
} from "../orchestration/mission/mission-policy.js";
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
import { SdlcKitAdapter, type SdlcKitCommand } from "../domains/agentic-sdlc-kit/adapter.js";
import type { KitPort } from "../orchestration/mission/verification.js";

const AUTONOMY_PROFILES = ["supervised", "controlled-autonomous", "research"] as const;
type AutonomyName = (typeof AUTONOMY_PROFILES)[number];

/**
 * Bridge the typed adapter onto the mission plane's `KitPort` (composition
 * root — this file may import both planes). The adapter re-validates every
 * id and op at runtime (deny-by-default allowlist, regex before spawn), so
 * the cross-plane handoff stays fail-closed; a mirror-sync test proves the
 * surfaces agree behaviorally.
 */
function kitPortFor(adapter: SdlcKitAdapter): { port: KitPort } {
  return {
    port: {
      available: () => adapter.available(),
      execute: (command) => adapter.execute(command as SdlcKitCommand),
    },
  };
}

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
      console.error(
        'usage: nexum mission start "<goal>" [--autonomy profile] [--criteria a,b] [--constraint c] [--kit feature:FEATURE-001] [--class pilot-class] [--worktree path]',
      );
      return 1;
    }
    const flag = (name: string): string | undefined => {
      const i = rest.indexOf(`--${name}`);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    // Kit binding (SPEC §10.5): `--kit feature:<FEATURE-ID>` or `--kit fix:<BUG-ID>`
    // — the adapter is mounted only when a run id is bound.
    const kitFlag = flag("kit");
    let kitBinding: NonNullable<MissionIntent["kitBinding"]> | undefined;
    if (kitFlag !== undefined) {
      const parsed = /^(feature|fix):([A-Z0-9][A-Z0-9-]*)$/.exec(kitFlag);
      if (parsed === null) {
        console.error("refused: --kit must be feature:<FEATURE-ID> or fix:<BUG-ID> (e.g. --kit feature:FEATURE-001)");
        return 1;
      }
      kitBinding = { kind: parsed[1] as "feature" | "fix", id: parsed[2] };
    }
    const requested = (flag("autonomy") ?? "supervised") as AutonomyName;
    if (!(AUTONOMY_PROFILES as readonly string[]).includes(requested)) {
      console.error(`refused: unknown autonomy profile "${requested}" (known: ${AUTONOMY_PROFILES.join(", ")})`);
      return 1;
    }
    // SPEC §9 "who enables" — an explicit CLI request is NOT enough to
    // escalate: controlled-autonomous needs NEXUM_MISSION_AUTONOMY=controlled,
    // and research needs NEXUM_MISSION_AUTONOMY=research AND an isolated
    // worktree declaration (--worktree). The pilot (P8) runs supervised.
    const worktree = flag("worktree");
    const enabledProfiles = resolveEnabledProfiles({
      env: process.env,
      ...(worktree !== undefined ? { researchWorktree: true } : {}),
    });
    if (requested === "research" && worktree === undefined) {
      console.error(
        "refused: the research profile requires an isolated worktree — re-run with --worktree <path> (SPEC §9)",
      );
      return 1;
    }
    // A Kit binding makes the Kit workflow REQUIRED (SPEC §10.5: bound runs
    // never proceed ungated).
    const resolved = resolveMissionPolicy({
      profile: requested,
      enabledProfiles,
      ...(kitBinding ? { overrides: { requireKitWorkflow: true } } : {}),
    });
    if (!resolved.ok || !resolved.policy) {
      console.error(
        `refused: ${resolved.reason} (enable via NEXUM_MISSION_AUTONOMY=controlled${
          requested === "research" ? " + --worktree" : ""
        })`,
      );
      return 1;
    }
    // The pilot class label (P8): bug-investigation | test-flake-diagnosis |
    // bounded-refactor — recorded on the intent, aggregated by the pilot report.
    const pilotClass = flag("class");
    const intent: MissionIntent = {
      goal,
      successCriteria: (flag("criteria") ?? "").split(",").filter(Boolean),
      constraints: (flag("constraint") ?? "").split(",").filter(Boolean),
      submittedBy: "user",
      ...(kitBinding ? { kitBinding } : {}),
      ...(pilotClass !== undefined ? { pilotClass } : {}),
    };
    // Mount the adapter ONLY for a bound run (SPEC §10.5). An unavailable
    // Kit is surfaced here, never silently ignored — the mission will abort
    // ungated when it is driven (requireKitWorkflow).
    const kitAdapter = kitBinding !== undefined ? new SdlcKitAdapter({ cwd }) : null;
    if (kitBinding !== undefined && (kitAdapter === null || !kitAdapter.available())) {
      console.error(
        `warning: Kit CLI unavailable (external-unavailable) — the bound run ${kitBinding.kind}:${kitBinding.id} ` +
          `will abort rather than proceed ungated when driven (SPEC §10.5)`,
      );
    }
    const coordinator = new MissionCoordinator({
      policy: resolved.policy,
      ...unwiredPorts(),
      missionsDir,
      ...(kitAdapter !== null && kitAdapter.available() ? kitPortFor(kitAdapter) : {}),
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

  if (sub === "pilot") {
    // The P8 supervised-pilot report (issue #86): deterministic reconstruction
    // from every mission's journal + checkpoint on disk (SPEC §6 rule 2), the
    // SPEC §9 graduation verdict per class, and a go/no-go recommendation.
    // Exit code: 2 on stop-the-line (false success / escalation finding),
    // 1 when no class graduates yet, 0 when any class is GO.
    const { writePilotReport } = await import("../orchestration/mission/pilot-report.js");
    const out = writePilotReport(missionsDir);
    console.log(out.markdown);
    console.log(`report saved: ${out.path}`);
    return out.report.stopTheLine ? 2 : out.report.classes.some((c) => c.goNoGo === "go") ? 0 : 1;
  }

  console.error(`unknown subcommand "${String(sub)}" — usage: nexum mission <start|status|resume|cancel|audit|pilot>`);
  return 1;
}
