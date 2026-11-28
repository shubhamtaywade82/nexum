/**
 * MAC v1 P8 — supervised pilot defaults + ops surface (issue #86, SPEC §9).
 *
 *   - "who enables": `supervised` is the shipped default; an explicit CLI
 *     request NEVER escalates — controlled-autonomous needs
 *     NEXUM_MISSION_AUTONOMY=controlled, research additionally needs
 *     --worktree (isolated workspace)
 *   - the pilot class label (--class) lands on the mission.created record
 *   - the pilot report (nexum mission pilot) reconstructs every mission from
 *     events.jsonl + checkpoint.json on disk alone (SPEC §6 rule 2), applies
 *     the SPEC §9 graduation criteria per class, and returns a go/no-go with
 *     stop-the-line semantics (exit 2 on false success / escalation finding)
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPilotReport,
  PILOT_GRADUATION_COMPLETION_RATE,
  PILOT_GRADUATION_MIN_MISSIONS,
  readMissionPilotRecord,
  writePilotReport,
} from "../../src/orchestration/mission/pilot-report.js";
import { MissionJournal } from "../../src/orchestration/mission/mission-coordinator.js";
import type { MissionEvent } from "../../src/orchestration/mission/events.js";
import { resolveEnabledProfiles } from "../../src/orchestration/mission/mission-policy.js";
import { runMissionCli } from "../../src/cli/mission-cli.js";

const ORIGINAL_AUTONOMY = process.env.NEXUM_MISSION_AUTONOMY;
afterEach(() => {
  if (ORIGINAL_AUTONOMY === undefined) delete process.env.NEXUM_MISSION_AUTONOMY;
  else process.env.NEXUM_MISSION_AUTONOMY = ORIGINAL_AUTONOMY;
});

// ── "who enables" (SPEC §9) ────────────────────────────────────────────────

describe("P8 — autonomy profile gating (SPEC §9 who enables)", () => {
  it("resolveEnabledProfiles: supervised always; controlled needs the env opt-in; research needs env + worktree", () => {
    expect(resolveEnabledProfiles({ env: {} })).toEqual(["supervised"]);
    expect(resolveEnabledProfiles({ env: { NEXUM_MISSION_AUTONOMY: "controlled" } })).toEqual([
      "supervised",
      "controlled-autonomous",
    ]);
    // research without a worktree declaration: still refused
    expect(resolveEnabledProfiles({ env: { NEXUM_MISSION_AUTONOMY: "research" } })).toEqual(["supervised"]);
    expect(resolveEnabledProfiles({ env: { NEXUM_MISSION_AUTONOMY: "research" }, researchWorktree: true })).toEqual([
      "supervised",
      "research",
    ]);
  });

  it("a CLI escalation attempt is refused: --autonomy controlled-autonomous without the env opt-in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nexum-p8-cli-"));
    try {
      delete process.env.NEXUM_MISSION_AUTONOMY;
      const code = await runMissionCli(["start", "1. multi\n2. step\n3. goal", "--autonomy", "controlled-autonomous"], {
        cwd,
      });
      expect(code).toBe(1);
      // nothing was created (the missions dir may not even exist)
      expect(existsSync(join(cwd, ".nexum", "missions"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("controlled-autonomous starts only under NEXUM_MISSION_AUTONOMY=controlled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nexum-p8-cli-"));
    try {
      process.env.NEXUM_MISSION_AUTONOMY = "controlled";
      const code = await runMissionCli(["start", "1. multi\n2. step\n3. goal", "--autonomy", "controlled-autonomous"], {
        cwd,
      });
      expect(code).toBe(0);
      expect(readdirSync(join(cwd, ".nexum", "missions"))).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("research without --worktree is refused even under the env opt-in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nexum-p8-cli-"));
    try {
      process.env.NEXUM_MISSION_AUTONOMY = "research";
      const code = await runMissionCli(["start", "1. multi\n2. step\n3. goal", "--autonomy", "research"], { cwd });
      expect(code).toBe(1);
      expect(existsSync(join(cwd, ".nexum", "missions"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("research starts with the env opt-in AND --worktree", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nexum-p8-cli-"));
    try {
      process.env.NEXUM_MISSION_AUTONOMY = "research";
      const code = await runMissionCli(
        ["start", "1. multi\n2. step\n3. goal", "--autonomy", "research", "--worktree", join(cwd, "wt")],
        { cwd },
      );
      expect(code).toBe(0);
      expect(readdirSync(join(cwd, ".nexum", "missions"))).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the pilot class label lands on the mission.created record", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nexum-p8-cli-"));
    try {
      const code = await runMissionCli(["start", "1. multi\n2. step\n3. goal", "--class", "bug-investigation"], {
        cwd,
      });
      expect(code).toBe(0);
      const missionId = readdirSync(join(cwd, ".nexum", "missions"))[0];
      const journal = new MissionJournal(join(cwd, ".nexum", "missions", missionId));
      const created = journal.load().find((e) => e.type === "mission.created");
      expect((created?.payload as { pilotClass?: string }).pilotClass).toBe("bug-investigation");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── Pilot report fixtures (hand-built journals — the replay path) ───────────

function missionDir(missionsDir: string, missionId: string): string {
  return join(missionsDir, missionId);
}

function append(missionsDir: string, missionId: string, events: Array<Partial<MissionEvent> & { type: string }>): void {
  const journal = new MissionJournal(missionDir(missionsDir, missionId));
  for (const partial of events) {
    journal.append({
      missionId,
      agentId: "coordinator",
      ...partial,
    } as MissionEvent);
  }
}

function verifiedMission(
  missionsDir: string,
  missionId: string,
  pilotClass: string,
  opts: { kitBound?: boolean } = {},
): void {
  append(missionsDir, missionId, [
    {
      type: "mission.created",
      payload: { missionId, objective: "pilot mission", constraints: [], autonomyProfile: "supervised", pilotClass },
    },
    {
      type: "mission.verification",
      payload: {
        gate: opts.kitBound ? "kit-journal-verified" : "tests",
        passed: true,
        summary: "verification passed",
        evidenceRefs: ["run:run_1"],
      },
      evidenceRefs: ["run:run_1"],
    },
    { type: "mission.completed", payload: { outcome: "completed", summary: "gates passed" } },
  ]);
}

describe("P8 — the pilot report (SPEC §9 graduation, stop-the-line)", () => {
  let missionsDir: string;
  beforeEach(() => {
    missionsDir = mkdtempSync(join(tmpdir(), "nexum-p8-report-"));
  });
  afterEach(() => {
    rmSync(missionsDir, { recursive: true, force: true });
  });

  it("reads a verified mission's record from the journal on disk alone (SPEC §6 rule 2)", () => {
    verifiedMission(missionsDir, "ms_verified", "bug-investigation", { kitBound: true });
    const record = readMissionPilotRecord(missionDir(missionsDir, "ms_verified"));
    expect(record).toEqual({
      missionId: "ms_verified",
      pilotClass: "bug-investigation",
      outcome: "completed",
      verifiedCompletion: true,
      falseSuccess: false,
      escalationFinding: false,
      budgetBreach: false,
      kitBound: true,
    });
  });

  it("a completed mission WITHOUT verification evidence is a false success (stop-the-line)", () => {
    append(missionsDir, "ms_false", [
      {
        type: "mission.created",
        payload: {
          missionId: "ms_false",
          objective: "o",
          constraints: [],
          autonomyProfile: "supervised",
          pilotClass: "bug-investigation",
        },
      },
      { type: "mission.completed", payload: { outcome: "completed", summary: "gate bypassed" } },
    ]);
    const record = readMissionPilotRecord(missionDir(missionsDir, "ms_false"));
    expect(record?.falseSuccess).toBe(true);
    expect(record?.verifiedCompletion).toBe(false);
  });

  it("an approval resolved without a matching request is an escalation finding", () => {
    append(missionsDir, "ms_esc", [
      {
        type: "mission.created",
        payload: {
          missionId: "ms_esc",
          objective: "o",
          constraints: [],
          autonomyProfile: "supervised",
          pilotClass: "bounded-refactor",
        },
      },
      {
        type: "mission.approval.resolved",
        payload: { approvalId: "apr_rogue", subject: "push", posture: "GITHUB", resolvedAs: "approved" },
      },
    ]);
    const record = readMissionPilotRecord(missionDir(missionsDir, "ms_esc"));
    expect(record?.escalationFinding).toBe(true);
  });

  it("an approval resolved against its own request is NOT an escalation finding (the honest path)", () => {
    append(missionsDir, "ms_ok", [
      {
        type: "mission.created",
        payload: {
          missionId: "ms_ok",
          objective: "o",
          constraints: [],
          autonomyProfile: "supervised",
          pilotClass: "bounded-refactor",
        },
      },
      {
        type: "mission.approval.requested",
        payload: { approvalId: "apr_ok", subject: "open draft PR", posture: "REMOTE", resolvedAs: "pending" },
      },
      {
        type: "mission.approval.resolved",
        payload: { approvalId: "apr_ok", subject: "open draft PR", posture: "REMOTE", resolvedAs: "approved" },
      },
    ]);
    const record = readMissionPilotRecord(missionDir(missionsDir, "ms_ok"));
    expect(record?.escalationFinding).toBe(false);
  });

  it("graduates a class only at ≥ 20 missions, ≥ 90% verified, zero findings", () => {
    // 19 verified missions: no-go (volume)
    for (let i = 0; i < PILOT_GRADUATION_MIN_MISSIONS - 1; i += 1) {
      verifiedMission(missionsDir, `ms_bulk_${i}`, "test-flake-diagnosis");
    }
    let report = buildPilotReport(missionsDir);
    expect(report.classes[0].goNoGo).toBe("no-go");
    expect(report.classes[0].unmetCriteria.some((c) => c.includes("mission volume"))).toBe(true);

    // the 20th verified mission graduates the class
    verifiedMission(missionsDir, "ms_bulk_final", "test-flake-diagnosis");
    report = buildPilotReport(missionsDir);
    const graduated = report.classes.find((c) => c.pilotClass === "test-flake-diagnosis");
    expect(graduated?.goNoGo).toBe("go");
    expect(graduated?.unmetCriteria).toEqual([]);
    expect(report.recommendation).toContain("GO");
    expect(report.stopTheLine).toBe(false);
  });

  it("stop-the-line: one false success freezes expansion regardless of volume", () => {
    for (let i = 0; i < PILOT_GRADUATION_MIN_MISSIONS; i += 1) {
      verifiedMission(missionsDir, `ms_bulk_${i}`, "bounded-refactor");
    }
    append(missionsDir, "ms_false", [
      {
        type: "mission.created",
        payload: {
          missionId: "ms_false",
          objective: "o",
          constraints: [],
          autonomyProfile: "supervised",
          pilotClass: "bounded-refactor",
        },
      },
      { type: "mission.completed", payload: { outcome: "completed", summary: "gate bypassed" } },
    ]);
    const report = buildPilotReport(missionsDir);
    expect(report.totalFalseSuccesses).toBe(1);
    expect(report.stopTheLine).toBe(true);
    expect(report.recommendation).toContain("STOP-THE-LINE");
    expect(report.classes[0].goNoGo).toBe("no-go");
  });

  it("verified completion below 90% keeps the class no-go with the gap named", () => {
    for (let i = 0; i < PILOT_GRADUATION_MIN_MISSIONS; i += 1) {
      verifiedMission(missionsDir, `ms_v_${i}`, "bug-investigation");
    }
    // two gate-bypassed completions drag the rate to 20/22 ≈ 90.9%… use three for 20/23
    for (let i = 0; i < 3; i += 1) {
      append(missionsDir, `ms_f_${i}`, [
        {
          type: "mission.created",
          payload: {
            missionId: `ms_f_${i}`,
            objective: "o",
            constraints: [],
            autonomyProfile: "supervised",
            pilotClass: "bug-investigation",
          },
        },
        { type: "mission.completed", payload: { outcome: "completed", summary: "no gates" } },
      ]);
    }
    const report = buildPilotReport(missionsDir);
    const klass = report.classes.find((c) => c.pilotClass === "bug-investigation");
    expect(klass?.goNoGo).toBe("no-go");
    expect(klass?.unmetCriteria.some((c) => c.includes("verified completion"))).toBe(true);
    expect(klass?.verifiedCompletionRate).toBeLessThan(PILOT_GRADUATION_COMPLETION_RATE);
  });

  it("renders + persists the markdown report (the weekly review artifact)", () => {
    verifiedMission(missionsDir, "ms_v", "bug-investigation");
    const { report, markdown, path } = writePilotReport(missionsDir);
    expect(existsSync(path)).toBe(true);
    expect(markdown).toContain("# MAC v1 supervised pilot report");
    expect(markdown).toContain("| bug-investigation | 1 | 1 |");
    expect(markdown).toContain("## Recommendation");
    expect(readFileSync(path, "utf8")).toBe(markdown);
    expect(report.totalMissions).toBe(1);
  });

  it("the CLI pilot command: exit 1 while no class graduates, exit codes from the report", async () => {
    verifiedMission(missionsDir, "ms_v", "bug-investigation");
    const cwd = mkdtempSync(join(tmpdir(), "nexum-p8-cli-"));
    try {
      // place the missions dir under a workspace so the CLI finds it
      const { mkdirSync, cpSync } = await import("node:fs");
      mkdirSync(join(cwd, ".nexum"), { recursive: true });
      cpSync(missionsDir, join(cwd, ".nexum", "missions"), { recursive: true });
      const code = await runMissionCli(["pilot"], { cwd });
      expect(code).toBe(1); // volume far below 20 → no-go
      expect(existsSync(join(cwd, ".nexum", "missions", "pilot-report.md"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
