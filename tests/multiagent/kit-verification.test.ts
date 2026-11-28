/**
 * MAC v1 P6 PR 6.2 — Kit evidence → verification gates + coordinator wiring
 * (SPEC §10.3–§10.5; issue #84 part 2).
 *
 * All tests run against a STUB Kit (scripted port — exactly the injected-runner
 * pattern the issue requires) plus one mirror-sync case through the REAL
 * adapter. No network, no model, fully deterministic.
 *
 * Coverage (issue #84 acceptance criteria):
 *   - an LLM (scripted) attempting to declare GREEN/VERIFIED cannot advance the
 *     Kit phase — only adapter-observed exit codes can (I6, INV-6 extension)
 *   - KitEvidence gates: RED requires observed failing, GREEN/REFACTOR observed
 *     passing, journal requires the hash chain (SPEC §10.4)
 *   - coordinator alignment with `kit next --json`: requiredAction wins; the
 *     mismatch is logged as a coordination failure the Commander must resolve
 *   - journal tamper fixture → mission aborted + escalation event (T8)
 *   - requireKitWorkflow: missing Kit or missing binding aborts ungated
 *   - delegate → the Kit's required phase advances through the adapter only
 */

import { describe, it, expect } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alignWithKitNext,
  evidenceSatisfiesPhase,
  kitEvidenceSchema,
  KitMissionVerification,
  KIT_EVIDENCE_CHAIN_GATE,
  KIT_JOURNAL_GATE,
  KIT_NEXT_ALIGNMENT_GATE,
  type KitCommand,
  type KitEvidence,
  type KitNextAction,
  type KitOutcome,
  type KitPort,
} from "../../src/orchestration/mission/verification.js";
import { ReportArtifactStore } from "../../src/orchestration/mission/report-artifacts.js";
import {
  MissionCoordinator,
  type DecisionCandidate,
  type MissionCoordinatorOptions,
  type MissionIntent,
  type MissionRoleAgents,
} from "../../src/orchestration/mission/mission-coordinator.js";
import { resolveMissionPolicy, type MissionPolicy } from "../../src/orchestration/mission/mission-policy.js";
import type { TrackerReportRef, PredictionReportRef } from "../../src/orchestration/mission/events.js";
import {
  SDLCKIT_OPS,
  SdlcKitAdapter,
  type KitCommandRunner,
  type SdlcKitCommand,
} from "../../src/domains/agentic-sdlc-kit/adapter.js";

// ── stub Kit (the injected port — scripted responses per op) ────────────────

/** FeatureRunState payload, exactly the Kit's schema v2 shape (task records). */
function featureRunState(taskId: string, phase: "red" | "green" | "refactor", status: "passed" | "failed"): unknown {
  return {
    schemaVersion: 2,
    featureId: "FEATURE-001",
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt: "2026-11-28T00:00:01.000Z",
    tasks: {
      [taskId]: {
        taskId,
        phase,
        records: [
          {
            phase,
            status,
            timestamp: "2026-11-28T00:00:01.000Z",
            verification: {
              taskId,
              command: ["npm", "test"],
              classification:
                status === "failed" ? { kind: "assertion", detail: "expected true, received false" } : null,
              reason: status === "failed" ? "targeted test failed at an assertion" : "targeted test passed",
            },
          },
        ],
      },
    },
  };
}

interface StubKitConfig {
  /** Queue of `next` answers (shifted per call); "unavailable" = kit-unavailable result. */
  nextQueue?: Array<Partial<KitNextAction> | "unavailable">;
  /** Phase outcomes keyed `${phase}:${taskId}` (exitCode + observed status). */
  phases?: Record<string, { exitCode: number; observed?: "passed" | "failed"; stderr?: string }>;
  /** The feature-level `verify` (evidence chain audit). */
  chainVerify?: { exitCode: number; stderr?: string };
  /** The `journal-verify` answer. */
  journal?: { exitCode: number; valid?: boolean; lastHash?: string; eventCount?: number; stderr?: string };
  /** `available()` (default true). */
  available?: boolean;
}

interface StubKit {
  port: KitPort;
  calls: Array<KitCommand>;
}

function outcomeFrom(partial: Partial<KitOutcome>, exitCode = 0): KitOutcome {
  return {
    ok: exitCode === 0 && partial.failure !== "parse",
    exitCode,
    parsed: partial.parsed ?? null,
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    timedOut: false,
    failure: partial.failure ?? null,
    blocker: partial.blocker ?? null,
    evidence: partial.evidence ?? [],
  };
}

function nextAction(overrides: Partial<KitNextAction> = {}): KitNextAction {
  return {
    featureId: "FEATURE-001",
    status: "in_progress",
    requiredAction: "run.completed",
    nextInvocation: "kit feature FEATURE-001 verify",
    verificationCommand: ["npm", "test"],
    blockingQuestions: [],
    advisoryLessons: [],
    ...overrides,
  };
}

/** The stub Kit: an injected KitPort answering from a script, recording calls. */
function stubKit(config: StubKitConfig = {}): StubKit {
  const calls: KitCommand[] = [];
  const nextQueue = [...(config.nextQueue ?? [nextAction()])];
  const port: KitPort = {
    available: () => config.available ?? true,
    execute: async (command) => {
      calls.push(command);
      switch (command.op) {
        case "next": {
          const answer = nextQueue.shift() ?? nextAction();
          if (answer === "unavailable") {
            return outcomeFrom(
              {
                parsed: null,
                stderr: "kit next: no active feature runs",
                failure: "command-failed",
                blocker: "external-unavailable",
              },
              3,
            );
          }
          return outcomeFrom({ parsed: nextAction(answer), stdout: JSON.stringify(answer) });
        }
        case "feature-phase":
        case "fix-phase": {
          const taskId = command.phase === "start" || command.phase === "verify" ? "" : command.taskId;
          if (command.phase === "verify") {
            const chain = config.chainVerify ?? { exitCode: 0 };
            return outcomeFrom(
              {
                parsed: chain.exitCode === 0 ? { featureId: "FEATURE-001", status: "passed" } : null,
                stdout: chain.exitCode === 0 ? JSON.stringify({ status: "passed" }) : "",
                stderr: chain.stderr ?? "",
              },
              chain.exitCode,
            );
          }
          if (taskId === "") {
            return outcomeFrom({ parsed: { schemaVersion: 2, featureId: "FEATURE-001", tasks: {} }, stdout: "{}" });
          }
          const scripted = config.phases?.[`${command.phase}:${taskId}`];
          if (scripted === undefined) {
            return outcomeFrom(
              {
                parsed: null,
                stderr: `kit feature: unknown phase ${command.phase} for ${taskId}`,
                failure: "command-failed",
              },
              1,
            );
          }
          const observed = scripted.observed ?? "passed";
          const parsed = featureRunState(taskId, command.phase, observed);
          return outcomeFrom(
            {
              parsed,
              stdout: JSON.stringify(parsed),
              stderr: scripted.stderr ?? "",
              ...(scripted.exitCode !== 0 ? { failure: "command-failed" } : {}),
            },
            scripted.exitCode,
          );
        }
        case "journal-verify": {
          const journal = config.journal ?? { exitCode: 0, valid: true, lastHash: "a".repeat(64), eventCount: 3 };
          const parsed =
            journal.exitCode === 0 && journal.valid !== false
              ? {
                  featureId: command.runId,
                  valid: true,
                  lastHash: journal.lastHash ?? "a".repeat(64),
                  eventCount: journal.eventCount ?? 3,
                }
              : null;
          return outcomeFrom(
            { parsed, stdout: parsed ? JSON.stringify(parsed) : "", stderr: journal.stderr ?? "" },
            journal.exitCode,
          );
        }
        default:
          return outcomeFrom({ stderr: "unknown op", failure: "invalid-command" }, 1);
      }
    },
  };
  return { port, calls };
}

/** A service wired to a temp artifact store (fresh per test). */
function kitService(
  kit: StubKit,
  dir: string,
  binding: { kind: "feature" | "fix"; id: string } = { kind: "feature", id: "FEATURE-001" },
) {
  const store = new ReportArtifactStore(join(dir, "artifacts"));
  let seq = 0;
  const service = new KitMissionVerification({
    missionId: "ms_test",
    port: kit.port,
    binding,
    artifactStore: store,
    allocateSeq: () => {
      seq += 1;
      return seq;
    },
    now: () => "2026-11-28T00:00:02.000Z",
  });
  return { service, store, dir };
}

// ── KitPort mirror sync (mission plane twin ↔ domains adapter) ──────────────

describe("P6 PR 6.2 — KitPort mirror stays in sync with the SdlcKitAdapter", () => {
  it("every KitPort op exists in the adapter's closed allowlist vocabulary", () => {
    for (const op of ["feature-phase", "fix-phase", "next", "journal-verify"] as const) {
      expect((SDLCKIT_OPS as readonly string[]).includes(op)).toBe(true);
    }
    // and the port deliberately does NOT widen the agent-facing ops
    expect((SDLCKIT_OPS as readonly string[]).length).toBe(9);
  });

  it("a real adapter behind the port bridge accepts every KitCommand kind (behavioral sync)", async () => {
    const calls: Array<{ argv: string[] }> = [];
    const runner: KitCommandRunner = async (invocation) => {
      calls.push({ argv: [...invocation.argv] });
      return { stdout: JSON.stringify({ requiredAction: "run.completed" }), stderr: "", exitCode: 0 };
    };
    const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: () => "/mock/kit" });
    const port: KitPort = {
      available: () => adapter.available(),
      execute: (command) => adapter.execute(command as SdlcKitCommand),
    };
    expect(port.available()).toBe(true);

    const commands: KitCommand[] = [
      { op: "next" },
      { op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "red" },
      { op: "fix-phase", fixId: "BUG-101", taskId: "TASK-002", phase: "green" },
      { op: "journal-verify", runId: "FEATURE-001" },
    ];
    for (const command of commands) {
      const outcome = await port.execute(command);
      expect(outcome.failure).not.toBe("invalid-command"); // the vocabularies agree
      expect(outcome.failure).toBeNull();
    }
    // the argv the adapter built flows through the shared path
    expect(calls.map((c) => c.argv[0])).toEqual(["next", "feature", "fix", "journal"]);
  });
});

// ── alignWithKitNext (SPEC §10.3 — the Kit wins) ─────────────────────────────

describe("P6 PR 6.2 — alignWithKitNext: requiredAction wins on disagreement", () => {
  const plan = ["TASK-001", "TASK-002"];

  it("agreement aligns", () => {
    const result = alignWithKitNext({
      plannedTaskIds: plan,
      intent: { taskId: "TASK-001", phase: "red" },
      next: nextAction({ requiredAction: "red", taskId: "TASK-001", phase: "red" }),
    });
    expect(result.aligned).toBe(true);
    expect(result.mismatch).toBeNull();
    expect(result.requiredAction).toBe("red");
  });

  it("disagreement: the Kit wins and the mismatch is a coordination failure", () => {
    const result = alignWithKitNext({
      plannedTaskIds: plan,
      intent: { taskId: "TASK-002", phase: "green" },
      next: nextAction({ requiredAction: "red", taskId: "TASK-001", phase: "red" }),
    });
    expect(result.aligned).toBe(false);
    expect(result.mismatch).toContain("coordination failure");
    expect(result.mismatch).toContain("the Kit wins");
    expect(result.requiredAction).toBe("red");
    expect(result.taskId).toBe("TASK-001"); // the authoritative task
  });

  it("run.completed agrees with a completion intent", () => {
    const result = alignWithKitNext({
      plannedTaskIds: plan,
      intent: { runCompleted: true },
      next: nextAction({ requiredAction: "run.completed" }),
    });
    expect(result.aligned).toBe(true);
  });

  it("run.completed disagrees with a phase intent — the Kit wins", () => {
    const result = alignWithKitNext({
      plannedTaskIds: plan,
      intent: { taskId: "TASK-002", phase: "green" },
      next: nextAction({ requiredAction: "run.completed", taskId: undefined, phase: undefined }),
    });
    expect(result.aligned).toBe(false);
    expect(result.mismatch).toContain("the Kit requires run.completed");
  });

  it("a required task outside the plan is a coordination failure", () => {
    const result = alignWithKitNext({
      plannedTaskIds: plan,
      intent: null,
      next: nextAction({ requiredAction: "red", taskId: "TASK-009", phase: "red" }),
    });
    expect(result.aligned).toBe(false);
    expect(result.mismatch).toContain("not in the plan");
  });

  it("no coordinator intent + in-plan requirement: the coordinator follows the Kit", () => {
    const result = alignWithKitNext({
      plannedTaskIds: plan,
      intent: null,
      next: nextAction({ requiredAction: "red", taskId: "TASK-001", phase: "red" }),
    });
    expect(result.aligned).toBe(true);
  });

  it("kit next unavailable → misaligned, never guessed", () => {
    const result = alignWithKitNext({ plannedTaskIds: plan, intent: null, next: null });
    expect(result.aligned).toBe(false);
    expect(result.mismatch).toContain("kit next unavailable");
  });
});

// ── KitEvidence gates (SPEC §10.4 — adapter-observed only) ───────────────────

describe("P6 PR 6.2 — KitEvidence: observed exits only, never an agent claim", () => {
  const base: KitEvidence = {
    kind: "red",
    runId: "FEATURE-001",
    taskId: "TASK-001",
    verificationStatus: "failed",
    exitCode: 0,
    observedAt: "2026-11-28T00:00:02.000Z",
    artifactRefs: ["artifact:ma_1"],
  };

  it("RED evidence requires an observed FAILING verification", () => {
    expect(kitEvidenceSchema.safeParse(base).success).toBe(true);
    expect(evidenceSatisfiesPhase(base)).toBe(true);
  });

  it("RED with a passing observation is refused — the agent's claim is never evidence", () => {
    const forged: KitEvidence = { ...base, verificationStatus: "passed" };
    const result = kitEvidenceSchema.safeParse(forged);
    expect(result.success).toBe(false);
  });

  it("GREEN/REFACTOR require an observed PASSING verification", () => {
    expect(kitEvidenceSchema.safeParse({ ...base, kind: "green", verificationStatus: "passed" }).success).toBe(true);
    expect(kitEvidenceSchema.safeParse({ ...base, kind: "refactor", verificationStatus: "passed" }).success).toBe(true);
    expect(kitEvidenceSchema.safeParse({ ...base, kind: "green", verificationStatus: "failed" }).success).toBe(false);
  });

  it("an unobserved record (no verificationStatus) is refused — fail-closed", () => {
    const unobserved = { ...base } as Partial<KitEvidence>;
    delete unobserved.verificationStatus;
    expect(kitEvidenceSchema.safeParse(unobserved).success).toBe(false);
  });

  it("journal evidence requires the hash chain", () => {
    const journal: KitEvidence = {
      ...base,
      kind: "journal",
      taskId: undefined,
      verificationStatus: undefined,
      journalHash: "a".repeat(64),
    };
    expect(kitEvidenceSchema.safeParse(journal).success).toBe(true);
    const hashless = { ...journal } as Partial<KitEvidence>;
    delete hashless.journalHash;
    expect(kitEvidenceSchema.safeParse(hashless).success).toBe(false);
  });

  it("a non-zero kit exit cannot satisfy a phase (the Kit must have recorded the step)", () => {
    expect(evidenceSatisfiesPhase({ ...base, exitCode: 1 })).toBe(false);
  });
});

// ── KitMissionVerification.verify() — the three gates ────────────────────────

describe("P6 PR 6.2 — KitMissionVerification gates", () => {
  it("happy path: chain + journal + alignment all pass, evidence recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-verif-"));
    try {
      const kit = stubKit();
      const { service } = kitService(kit, dir);
      const verdicts = await service.verify({ missionId: "ms_test", goal: "g", taskIds: ["TASK-001"] });

      const gates = verdicts.map((v) => [v.gate, v.passed]);
      expect(gates).toEqual([
        [KIT_EVIDENCE_CHAIN_GATE, true],
        [KIT_JOURNAL_GATE, true],
        [KIT_NEXT_ALIGNMENT_GATE, true],
      ]);
      // every verdict is evidenced (INV-10) with persisted raw output artifacts
      for (const verdict of verdicts) {
        expect(verdict.evidenceRefs.length).toBeGreaterThan(0);
        expect(existsSync(join(dir, "artifacts", `${verdict.evidenceRefs[0].slice("artifact:".length)}.json`))).toBe(
          true,
        );
      }
      // the journal evidence carries the chain hash
      const journalEvidence = service.observedEvidence().find((e) => e.kind === "journal");
      expect(journalEvidence?.journalHash).toBe("a".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journal tamper (exit 1): the journal gate fails and ESCALATES (T8)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-verif-"));
    try {
      const kit = stubKit({ journal: { exitCode: 1, stderr: "kit journal: hash chain violated at event 4" } });
      const { service } = kitService(kit, dir);
      const verdicts = await service.verify({ missionId: "ms_test", goal: "g", taskIds: ["TASK-001"] });
      const journal = verdicts.find((v) => v.gate === KIT_JOURNAL_GATE);
      expect(journal?.passed).toBe(false);
      expect(journal?.escalate).toContain("THREAT-MODEL T8");
      expect(journal?.summary).toContain("hash chain violated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evidence-chain failure (kit verify exit 1) fails the chain gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-verif-"));
    try {
      const kit = stubKit({ chainVerify: { exitCode: 1, stderr: "task TASK-002 lacks a green record" } });
      const { service } = kitService(kit, dir);
      const verdicts = await service.verify({ missionId: "ms_test", goal: "g", taskIds: ["TASK-002"] });
      const chain = verdicts.find((v) => v.gate === KIT_EVIDENCE_CHAIN_GATE);
      expect(chain?.passed).toBe(false);
      expect(chain?.summary).toContain("lacks a green record");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Kit still requires work: the alignment gate fails with the coordination mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-verif-"));
    try {
      const kit = stubKit({ nextQueue: [{ requiredAction: "red", taskId: "TASK-001", phase: "red" }] });
      const { service } = kitService(kit, dir);
      const verdicts = await service.verify({ missionId: "ms_test", goal: "g", taskIds: ["TASK-001"] });
      const alignment = verdicts.find((v) => v.gate === KIT_NEXT_ALIGNMENT_GATE);
      expect(alignment?.passed).toBe(false);
      expect(alignment?.summary).toContain("plan intends completion but the Kit requires TASK-001 red");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a parse failure (non-JSON journal output) fails closed — the phase state is never guessed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-verif-"));
    try {
      const kit = stubKit({ journal: { exitCode: 0 } });
      // sabotage: the stub returns valid JSON, so force a parse failure via a
      // raw-output port instead
      const sabotage: KitPort = {
        available: () => true,
        execute: async (command) =>
          command.op === "journal-verify"
            ? outcomeFrom({ parsed: null, stdout: "not json", failure: "parse" }, 0)
            : kit.port.execute(command),
      };
      const store = new ReportArtifactStore(join(dir, "artifacts"));
      const service = new KitMissionVerification({
        missionId: "ms_test",
        port: sabotage,
        binding: { kind: "feature", id: "FEATURE-001" },
        artifactStore: store,
        allocateSeq: () => 1,
      });
      const verdicts = await service.verify({ missionId: "ms_test", goal: "g", taskIds: ["TASK-001"] });
      expect(verdicts.find((v) => v.gate === KIT_JOURNAL_GATE)?.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── advanceRequiredPhase (SPEC §10.3 — the Kit dictates the step) ───────────

describe("P6 PR 6.2 — advanceRequiredPhase follows the Kit's requiredAction", () => {
  it("advances the phase the Kit requires, recording the observed evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-adv-"));
    try {
      const kit = stubKit({
        nextQueue: [{ requiredAction: "red", taskId: "TASK-001", phase: "red" }],
        phases: { "red:TASK-001": { exitCode: 0, observed: "failed" } },
      });
      const { service } = kitService(kit, dir);
      const advanced = await service.advanceRequiredPhase(["TASK-001", "TASK-002"]);
      expect(advanced.ok).toBe(true);
      expect(advanced.advanced?.kind).toBe("red");
      expect(advanced.advanced?.taskId).toBe("TASK-001");
      expect(advanced.advanced?.verificationStatus).toBe("failed"); // observed FAILING — SPEC §10.4
      // the port received exactly the Kit-dictated phase op
      expect(kit.calls[1]).toEqual({ op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "red" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fix binding advances through the fix-phase op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-adv-"));
    try {
      const kit = stubKit({
        nextQueue: [{ requiredAction: "green", taskId: "TASK-001", phase: "green" }],
        phases: { "green:TASK-001": { exitCode: 0, observed: "passed" } },
      });
      const { service } = kitService(kit, dir, { kind: "fix", id: "BUG-101" });
      const advanced = await service.advanceRequiredPhase(["TASK-001"]);
      expect(advanced.ok).toBe(true);
      expect(advanced.advanced?.kind).toBe("green");
      expect(kit.calls[1]).toEqual({ op: "fix-phase", fixId: "BUG-101", taskId: "TASK-001", phase: "green" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Kit refuses the transition (its invariant) → surfaced, never retried here", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-adv-"));
    try {
      const kit = stubKit({
        nextQueue: [{ requiredAction: "green", taskId: "TASK-001", phase: "green" }],
        phases: { "green:TASK-001": { exitCode: 1, stderr: "no RED recorded for TASK-001" } },
      });
      const { service } = kitService(kit, dir);
      const advanced = await service.advanceRequiredPhase(["TASK-001"]);
      expect(advanced.ok).toBe(false);
      expect(advanced.reason).toContain("kit refused green for TASK-001");
      expect(advanced.reason).toContain("no RED recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kit next unavailable → nothing advances (fail-closed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-adv-"));
    try {
      const kit = stubKit({ nextQueue: ["unavailable"] });
      const { service } = kitService(kit, dir);
      const advanced = await service.advanceRequiredPhase(["TASK-001"]);
      expect(advanced.ok).toBe(false);
      expect(advanced.reason).toContain("no active feature runs"); // the kit's own words, surfaced
      // only the `next` call happened — no phase op was attempted
      expect(kit.calls.map((c) => c.op)).toEqual(["next"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.completed → nothing to advance, alignment agrees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-kit-adv-"));
    try {
      const kit = stubKit({ nextQueue: [{ requiredAction: "run.completed" }] });
      const { service } = kitService(kit, dir);
      const advanced = await service.advanceRequiredPhase(["TASK-001"]);
      expect(advanced.ok).toBe(true);
      expect(advanced.advanced).toBeNull();
      expect(advanced.alignment.aligned).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Coordinator e2e — the I6 invariant + T8 + ungated aborts ────────────────

const MULTI_STEP_GOAL = "1. write the failing test\n2. implement the fix\n3. verify the suite";

function trackerRef(health: TrackerReportRef["health"] = "healthy"): TrackerReportRef {
  return { reportId: "tr_1", artifactId: "ma_1", health, observationCount: 2, blockerCount: 0 };
}
function predictorRef(): PredictionReportRef {
  return { reportId: "pr_1", artifactId: "ma_2", riskCount: 1 };
}
function decision(partial: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    decisionId: "cd_default",
    missionId: "ms_ignored",
    action: "verify",
    rationale: "check the gates",
    basedOnReports: ["tr_1", "pr_1"],
    evidenceRefs: ["artifact:ma_1"],
    schemaVersion: 1,
    ...partial,
  };
}

/** Scripted trio with a decision queue + rejection capture (for mismatch feedback). */
function scriptedRoles(decisions: DecisionCandidate[]) {
  const seen: Array<{ lastRejection?: { reason: string; gate: string } }> = [];
  const roles: MissionRoleAgents = {
    observe: async () => ({ report: trackerRef(), artifactPayload: { turn: 1 } }),
    assess: async () => ({ report: predictorRef(), artifactPayload: { riskCount: 1 } }),
    decide: async (input) => {
      seen.push({ ...(input.lastRejection ? { lastRejection: input.lastRejection } : {}) });
      return decisions[Math.min(seen.length - 1, decisions.length - 1)];
    },
  };
  return { roles, seen };
}

function kitPolicy(): MissionPolicy {
  const res = resolveMissionPolicy({
    overrides: {
      requireKitWorkflow: true,
      // the I6 walk needs one more turn than the supervised default child
      // budget allows (delegate → claim → verify → complete)
      budget: { maxChildren: 16 },
      delegationPolicy: { maxTotalChildren: 16 },
    },
  });
  if (!res.ok || !res.policy) throw new Error(`test policy refused: ${res.reason}`);
  return res.policy;
}

function kitCoordinator(
  missionsDir: string,
  roles: MissionRoleAgents,
  kit: StubKit,
  pol: MissionPolicy = kitPolicy(),
): MissionCoordinator {
  const opts: MissionCoordinatorOptions = {
    policy: pol,
    roles,
    workers: {
      review: () => ({ allowed: true, reason: "capability match", childAgentId: "devagent" }),
      delegate: async () => ({ status: "completed" as const, output: "done" }),
    },
    verification: {
      verify: async () => [{ gate: "tests", passed: true, summary: "suite green", evidenceRefs: ["run:run_1"] }],
    },
    approvals: { resolve: async () => "approved" as const },
    missionsDir,
    planSteps: [{ id: "TASK-001", description: "implement", status: "pending", dependencies: [], retryCount: 0 }],
    kit: { port: kit.port },
  };
  return new MissionCoordinator(opts);
}

function kitIntent(): MissionIntent {
  return {
    goal: MULTI_STEP_GOAL,
    successCriteria: ["suite green"],
    constraints: [],
    submittedBy: "user",
    kitBinding: { kind: "feature", id: "FEATURE-001" },
  };
}

describe("P6 PR 6.2 — coordinator wiring (Kit-bound missions)", () => {
  it("I6: mission completion requires deterministic verification evidence (gateTaskCompletion / Kit journal), never an agent's claim (enforced P6)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const kit = stubKit(); // chain ok, journal valid, next run.completed
      const { roles } = scriptedRoles([
        decision({
          decisionId: "cd_d1",
          action: "delegate",
          delegation: { goal: "implement TASK-001", requiredCapabilities: ["code-edit"] },
          taskIds: ["TASK-001"],
        }),
        decision({ decisionId: "cd_claim", action: "complete", rationale: "the agent believes it is done" }), // the CLAIM
        decision({ decisionId: "cd_verify", action: "verify", taskIds: ["TASK-001"] }), // the EVIDENCE
        decision({ decisionId: "cd_complete", action: "complete" }),
      ]);
      const coordinator = kitCoordinator(missionsDir, roles, kit);

      const outcome = await coordinator.run(kitIntent());
      // the claim alone could not complete the mission: it was rejected,
      // the journal gates ran first, and only then completion was accepted
      expect(outcome.outcome).toBe("completed");
      const events = coordinator.journalEvents();
      const rejections = events.filter((e) => e.type === "commander.decision.rejected");
      expect(rejections.length).toBe(1); // the claim was refused — INV-6
      const verification = events.filter((e) => e.type === "mission.verification");
      expect(verification.length).toBe(3); // the three kit gates, journaled before completion
      const gates = verification.map((e) => e.payload.gate);
      expect(gates).toContain(KIT_JOURNAL_GATE);
      // completion fired exactly once, AFTER the journal gate was observed
      const types = events.map((e) => e.type);
      expect(types.filter((t) => t === "mission.completed")).toHaveLength(1);
      expect(types.indexOf("mission.completed")).toBeGreaterThan(types.lastIndexOf("commander.decision.rejected"));
      // and the journal verdict carries the raw-output evidence (INV-10)
      const journalVerdict = verification.find((e) => e.payload.gate === KIT_JOURNAL_GATE);
      expect(journalVerdict?.evidenceRefs.length).toBeGreaterThan(0);
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("journal tamper fixture → mission aborted + escalation event (THREAT-MODEL T8)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const kit = stubKit({ journal: { exitCode: 1, stderr: "hash chain violated at event 4" } });
      const { roles } = scriptedRoles([decision({ decisionId: "cd_v1", action: "verify", taskIds: ["TASK-001"] })]);
      const coordinator = kitCoordinator(missionsDir, roles, kit);

      const outcome = await coordinator.run(kitIntent());
      expect(outcome.outcome).toBe("aborted");
      expect(outcome.summary).toContain("human escalation");

      const events = coordinator.journalEvents();
      // the escalation verdict is journaled — the journal IS the incident record
      const escalated = events.find((e) => e.type === "mission.verification" && e.payload.escalate !== undefined);
      expect(escalated?.payload.escalate).toContain("THREAT-MODEL T8");
      expect(events[events.length - 1].type).toBe("mission.aborted");
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("requireKitWorkflow without a Kit binding aborts ungated (SPEC §10.5)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const kit = stubKit();
      const { roles } = scriptedRoles([]);
      const coordinator = kitCoordinator(missionsDir, roles, kit);
      const intent = { ...kitIntent(), kitBinding: undefined };
      const outcome = await coordinator.run(intent);
      expect(outcome.outcome).toBe("aborted");
      expect(outcome.summary).toContain("no Kit feature/fix binding");
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("requireKitWorkflow + binding but Kit unavailable → aborted, never ungated (SPEC §10.5 row 1)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const kit = stubKit({ available: false });
      const { roles } = scriptedRoles([]);
      const coordinator = kitCoordinator(missionsDir, roles, kit);
      const outcome = await coordinator.run(kitIntent());
      expect(outcome.outcome).toBe("aborted");
      expect(outcome.summary).toContain("external-unavailable");
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("bound but optional (no requireKitWorkflow) + Kit missing → degraded, not aborted; standard gates apply", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const supervised = resolveMissionPolicy();
      if (!supervised.ok || !supervised.policy) throw new Error("supervised policy refused");
      const kit = stubKit({ available: false });
      const { roles } = scriptedRoles([
        decision({ decisionId: "cd_v1", action: "verify", taskIds: ["TASK-001"] }),
        decision({ decisionId: "cd_c1", action: "complete" }),
      ]);
      const coordinator = kitCoordinator(missionsDir, roles, kit, supervised.policy);
      const outcome = await coordinator.run(kitIntent()); // binding present, policy does not require
      // degraded overlay forces re-observation (the tracker observes twice before
      // the productive turns), but the mission is NOT aborted — the standard
      // verification gates still apply (the degraded mission cannot complete
      // until the fresh tracker report clears the overlay)
      expect(outcome.outcome).not.toBe("aborted");
      expect(kit.calls.length).toBe(0); // the missing Kit was never invoked
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("delegate → the Kit's required phase advances through the adapter (never an LLM)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const kit = stubKit({
        nextQueue: [
          { requiredAction: "red", taskId: "TASK-001", phase: "red" }, // before the worker's test exists
          { requiredAction: "run.completed" }, // after the red was recorded + gates run
        ],
        phases: { "red:TASK-001": { exitCode: 0, observed: "failed" } },
      });
      const { roles } = scriptedRoles([
        decision({
          decisionId: "cd_d1",
          action: "delegate",
          delegation: { goal: "write the failing test for TASK-001", requiredCapabilities: ["code-edit"] },
          taskIds: ["TASK-001"],
        }),
        decision({ decisionId: "cd_v1", action: "verify", taskIds: ["TASK-001"] }),
        decision({ decisionId: "cd_c1", action: "complete" }),
      ]);
      const coordinator = kitCoordinator(missionsDir, roles, kit);

      const outcome = await coordinator.run(kitIntent());
      expect(outcome.outcome).toBe("completed");
      // the coordinator (not the worker, not the commander) advanced RED
      expect(kit.calls.map((c) => c.op)).toContain("feature-phase");
      const phaseCall = kit.calls.find((c) => c.op === "feature-phase") as { phase?: string; taskId?: string };
      expect(phaseCall?.phase).toBe("red");
      expect(phaseCall?.taskId).toBe("TASK-001");
      // the observed failing verification is persisted as a verification-evidence artifact
      const missionDir = join(missionsDir, coordinator.missionId);
      const artifacts = readdirSync(join(missionDir, "artifacts"));
      const redRaw = artifacts
        .map(
          (f) => JSON.parse(readFileSync(join(missionDir, "artifacts", f), "utf8")) as { payload?: { gate?: string } },
        )
        .find((a) => a.payload?.gate === "red:TASK-001");
      expect(redRaw).toBeDefined();
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("a kit/plan mismatch is fed back to the Commander as a coordination failure", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const kit = stubKit({
        nextQueue: [{ requiredAction: "red", taskId: "TASK-009", phase: "red" }], // NOT in the plan
      });
      const { roles, seen } = scriptedRoles([
        decision({
          decisionId: "cd_d1",
          action: "delegate",
          delegation: { goal: "work on something else", requiredCapabilities: ["code-edit"] },
          taskIds: ["TASK-001"],
        }),
      ]);
      const coordinator = kitCoordinator(missionsDir, roles, kit);
      // the plan does not contain TASK-009 → the mismatch must reach the next decide
      const outcome = await coordinator.run(kitIntent());
      expect(outcome.outcome).not.toBe("completed"); // misaligned work cannot complete
      const rejections = seen.filter((s) => s.lastRejection !== undefined);
      expect(rejections.length).toBeGreaterThan(0);
      expect(
        rejections.some(
          (s) =>
            (s.lastRejection?.reason ?? "").includes("kit alignment") ||
            (s.lastRejection?.reason ?? "").includes("kit phase"),
        ),
      ).toBe(true);
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });

  it("non-Kit missions are untouched by the adapter (SPEC §10.5 last row)", async () => {
    const missionsDir = mkdtempSync(join(tmpdir(), "nexum-kit-e2e-"));
    try {
      const supervised = resolveMissionPolicy();
      if (!supervised.ok || !supervised.policy) throw new Error("supervised policy refused");
      const kit = stubKit({ available: false }); // even a missing kit must not matter
      const { roles } = scriptedRoles([
        decision({ decisionId: "cd_v1", action: "verify", taskIds: ["TASK-001"] }),
        decision({ decisionId: "cd_c1", action: "complete" }),
      ]);
      const coordinator = kitCoordinator(missionsDir, roles, kit, supervised.policy);
      const intent: MissionIntent = {
        goal: MULTI_STEP_GOAL,
        successCriteria: [],
        constraints: [],
        submittedBy: "user",
      }; // no binding, supervised policy
      const outcome = await coordinator.run(intent);
      expect(outcome.outcome).toBe("completed");
      expect(kit.calls.length).toBe(0); // the adapter was never touched
    } finally {
      rmSync(missionsDir, { recursive: true, force: true });
    }
  });
});
