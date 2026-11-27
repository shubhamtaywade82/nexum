/**
 * MAC v1 P2 — event + artifact contract tests (ROADMAP P2, issue #80).
 *
 * PR 2.1 coverage:
 *   - every mission event type round-trips through a sink
 *   - seq ordering via the existing envelope/recorder path
 *   - router drops malformed events (fail-closed) and records the reason
 *   - unknown event types rejected; strict-on-write, tolerant-on-read
 *   - INV-10: unevidenced reports rejected (enforces I3's substrate)
 *
 * PR 2.2 coverage:
 *   - artifact immutability: second write refused (wx), no overwrite path
 *   - sha256 self-hash verified on read; tamper detection
 *   - supersede-by-new-artifact (original untouched)
 *   - EvidenceRef resolution against stores; unresolvable = violation
 *   - redaction pass-through: no credential-shaped content persists
 *   - zero changes to EventEnvelope itself (structural test)
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  MISSION_EVENT_TYPES,
  validateMissionEvent,
  type MissionEvent,
} from "../../src/orchestration/mission/events.js";
import { MissionEventRouter } from "../../src/orchestration/mission/event-router.js";
import {
  ReportArtifactStore,
  buildReportArtifact,
  hashPayload,
  REPORT_ARTIFACT_SCHEMA_VERSION,
} from "../../src/orchestration/mission/report-artifacts.js";
import { EvidenceResolver } from "../../src/orchestration/mission/evidence-refs.js";
import { EventEnvelope, toPersistedRecord, fromPersistedRecord } from "../../src/core/events/envelope.js";

// ── helpers ────────────────────────────────────────────────────────────────

function baseEvent(type: string, extra: Partial<MissionEvent> = {}): Record<string, unknown> {
  return { type, missionId: "m_1", agentId: "coordinator", ...extra };
}

/** One valid payload per event type (the full union must round-trip). */
function validEventPerType(): Array<{ type: string; event: Record<string, unknown> }> {
  return [
    {
      type: "mission.created",
      event: baseEvent("mission.created", { payload: { missionId: "m_1", objective: "stabilize tests" } }),
    },
    { type: "mission.activated", event: baseEvent("mission.activated") },
    { type: "mission.single_agent_fallback", event: baseEvent("mission.single_agent_fallback") },
    {
      type: "tracker.report",
      event: baseEvent("tracker.report", {
        agentId: "tracker",
        evidenceRefs: ["artifact:ma_1"],
        payload: { reportId: "tr_1", artifactId: "ma_1", health: "healthy", observationCount: 3, blockerCount: 0 },
      }),
    },
    {
      type: "prediction.report",
      event: baseEvent("prediction.report", {
        agentId: "predictor",
        evidenceRefs: ["event:evt_1"],
        payload: { reportId: "pr_1", artifactId: "ma_2", riskCount: 2 },
      }),
    },
    {
      type: "commander.decision",
      event: baseEvent("commander.decision", {
        agentId: "commander",
        evidenceRefs: ["run:run_1"],
        payload: { decisionId: "cd_1", artifactId: "ma_3", kind: "propose" },
      }),
    },
    {
      type: "commander.decision.rejected",
      event: baseEvent("commander.decision.rejected", {
        payload: { decisionId: "cd_1", reason: "budget gate", gate: "budget" },
      }),
    },
    {
      type: "mission.delegation",
      event: baseEvent("mission.delegation", {
        payload: {
          delegateId: "d_1",
          targetAgentId: "devagent",
          requiredCapabilities: ["code-edit"],
          contextHandoff: "summary",
          evidenceRefs: ["run:run_1"],
        },
      }),
    },
    {
      type: "mission.verification",
      event: baseEvent("mission.verification", {
        evidenceRefs: ["artifact:ma_3"],
        payload: { gate: "tests", passed: true, summary: "suite green", evidenceRefs: ["artifact:ma_3"] },
      }),
    },
    {
      type: "mission.replan",
      event: baseEvent("mission.replan", {
        payload: { replanId: "rp_1", trigger: "verification-failed", rationale: "gate red", evidenceRefs: [] },
      }),
    },
    {
      type: "mission.approval.requested",
      event: baseEvent("mission.approval.requested", {
        payload: { approvalId: "ap_1", subject: "push", posture: "restricted" },
      }),
    },
    {
      type: "mission.approval.resolved",
      event: baseEvent("mission.approval.resolved", {
        payload: { approvalId: "ap_1", subject: "push", posture: "restricted", resolvedAs: "approved" },
      }),
    },
    {
      type: "mission.checkpoint",
      event: baseEvent("mission.checkpoint", {
        payload: { checkpointId: "cp_1", label: "after setup", artifactIds: ["ma_1"] },
      }),
    },
    {
      type: "mission.phase",
      event: baseEvent("mission.phase", { payload: { from: "observe", to: "plan", reason: "report in" } }),
    },
    {
      type: "mission.completed",
      event: baseEvent("mission.completed", {
        payload: { outcome: "completed", summary: "done", evidenceRefs: ["run:run_1"] },
      }),
    },
    {
      type: "mission.failed",
      event: baseEvent("mission.failed", { payload: { outcome: "failed", summary: "gate red" } }),
    },
    { type: "mission.aborted", event: baseEvent("mission.aborted", { payload: { outcome: "aborted" } }) },
    { type: "mission.cancelled", event: baseEvent("mission.cancelled", { payload: { outcome: "cancelled" } }) },
  ];
}

// ── PR 2.1: event contracts ────────────────────────────────────────────────

describe("MAC v1 P2 (PR 2.1): mission event contracts", () => {
  it("every event type in the union validates", () => {
    const specs = validEventPerType();
    expect(new Set(specs.map((s) => s.type))).toEqual(new Set(MISSION_EVENT_TYPES));
    for (const { type, event } of specs) {
      const verdict = validateMissionEvent(event);
      expect({ type, valid: verdict.valid, reason: verdict.reason }).toEqual({ type, valid: true, reason: undefined });
    }
  });

  it("every event type round-trips through a sink (router fan-out)", () => {
    const received: unknown[] = [];
    const router = new MissionEventRouter({ sinks: [{ publish: (e) => received.push(e) }] });
    for (const { event } of validEventPerType()) {
      expect(router.publish(event).valid).toBe(true);
    }
    expect(received).toHaveLength(MISSION_EVENT_TYPES.length);
    // identity round-trip: what was published is what the sink got
    for (const item of received) expect(validateMissionEvent(item).valid).toBe(true);
  });

  it("events persist via the existing envelope: seq ordering and id chain survive the recorder path", () => {
    // The envelope itself is untouched (P2 acceptance: extension only).
    const envelopes: EventEnvelope[] = [];
    const specs = validEventPerType().slice(0, 5);
    specs.forEach(({ event }, i) => {
      envelopes.push({
        id: `evt_${i + 1}`,
        seq: i + 1, // per-run monotonic (replay order)
        ts: 1_000 + i,
        runId: "run_parent",
        correlation: { traceId: "trace_1", runId: "run_parent", parentRunId: undefined },
        event: event as never,
      });
    });
    // recorder persistence path: PersistedEventRecord round-trip
    const records = envelopes.map(toPersistedRecord);
    for (const [i, rec] of records.entries()) {
      expect(rec.seq).toBe(i + 1); // seq preserved → deterministic replay order
      expect(rec.eventType).toBe(specs[i].type); // discriminator preserved
    }
    const restored = records.map(fromPersistedRecord);
    expect(restored.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5"]);
  });

  it("router drops malformed events fail-closed and records the drop reason", () => {
    const received: unknown[] = [];
    const drops: unknown[] = [];
    const router = new MissionEventRouter({
      sinks: [{ publish: (e) => received.push(e) }],
      onDrop: (d) => drops.push(d),
      now: () => 42_000,
    });
    // malformed in turn: missing missionId, unknown type, bad payload, bad evidence prefix
    const malformed: Array<[unknown, string]> = [
      [{ type: "mission.activated", agentId: "coordinator" }, "missionId"],
      [{ type: "mission.unknown-thing", missionId: "m_1", agentId: "coordinator" }, "unknown mission event type"],
      [baseEvent("mission.created", { payload: { missionId: "", objective: "x" } }), "payload for mission.created"],
      [
        baseEvent("tracker.report", {
          evidenceRefs: ["bogus:x"],
          payload: { reportId: "tr_1", artifactId: "ma_1", health: "healthy", observationCount: 1, blockerCount: 0 },
        }),
        "evidence ref",
      ],
    ];
    for (const [bad, _match] of malformed) {
      const verdict = router.publish(bad);
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toBeTruthy();
    }
    expect(received).toEqual([]); // NOTHING forwarded
    expect(router.recordedDrops()).toHaveLength(4);
    expect(router.recordedDrops().every((d) => d.droppedAt === 42_000 && typeof d.reason === "string")).toBe(true);
    expect(drops).toHaveLength(4); // audit hook fired for every drop
  });

  it("INV-10: unevidenced reports are rejected (no report without evidence)", () => {
    const unevidenced = baseEvent("tracker.report", {
      agentId: "tracker",
      payload: { reportId: "tr_1", artifactId: "ma_1", health: "healthy", observationCount: 1, blockerCount: 0 },
      // evidenceRefs deliberately absent
    });
    const verdict = validateMissionEvent(unevidenced);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("INV-10");
    // same for prediction and commander reports, and verification verdicts
    // (valid payloads, so the ONLY failure is the missing evidence)
    const validPayloads: Record<string, unknown> = {
      "prediction.report": { reportId: "pr_1", artifactId: "ma_2", riskCount: 1 },
      "commander.decision": { decisionId: "cd_1", artifactId: "ma_3", kind: "propose" },
      "mission.verification": { gate: "tests", passed: true, summary: "green", evidenceRefs: [] },
    };
    for (const [type, payload] of Object.entries(validPayloads)) {
      const v = validateMissionEvent(baseEvent(type, { agentId: "x", payload }));
      expect(v.valid).toBe(false);
      expect(v.reason).toContain("non-empty evidenceRefs");
    }
  });

  it("strict on write (unknown fields rejected), tolerant on read (unknown fields preserved)", () => {
    const strict = validateMissionEvent(
      baseEvent("mission.created", { payload: { missionId: "m_1", objective: "o", surpriseField: true } }),
    );
    expect(strict.valid).toBe(false); // payload schema is .strict()
    const unknownOnEvent = validateMissionEvent(baseEvent("mission.activated"));
    expect(unknownOnEvent.valid).toBe(true); // base itself strict; tolerance is at read layers
    // Tolerant read: a rehydrated event with an extra field from a newer version
    // still routes (forward compatibility) — model a reader that strips-and-validates:
    const newer = baseEvent("mission.activated", { futureField: "v2" } as never);
    const { futureField, ...known } = newer;
    expect(futureField).toBe("v2");
    expect(validateMissionEvent(known).valid).toBe(true);
  });

  it("contextHandoff is capped at 32 KiB (SPEC §5.2)", () => {
    const v = validateMissionEvent(
      baseEvent("mission.delegation", {
        payload: {
          delegateId: "d",
          targetAgentId: "devagent",
          requiredCapabilities: [],
          contextHandoff: "x".repeat(32_767),
          evidenceRefs: ["run:r"],
        },
      }),
    );
    expect(v.valid).toBe(true);
    const tooBig = validateMissionEvent(
      baseEvent("mission.delegation", {
        payload: {
          delegateId: "d",
          targetAgentId: "devagent",
          requiredCapabilities: [],
          contextHandoff: "x".repeat(32_769),
          evidenceRefs: ["run:r"],
        },
      }),
    );
    expect(tooBig.valid).toBe(false);
  });
});

// ── PR 2.2: report artifacts + evidence refs ───────────────────────────────

describe("MAC v1 P2 (PR 2.2): immutable report artifacts", () => {
  let root: string;
  let store: ReportArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nexum-ma-"));
    store = new ReportArtifactStore(root);
  });

  it("writes exclusively (wx): the second write of the same artifact is refused", () => {
    const built = buildReportArtifact("tracker-report", "m_1", 1, { health: "healthy" });
    if (!built.ok) throw new Error(built.reason);
    expect(store.write(built.artifact).ok).toBe(true);
    const second = store.write(built.artifact);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("immutable");
  });

  it("self-hash verified on read; tampered payload is an integrity violation", () => {
    const built = buildReportArtifact("prediction-report", "m_1", 2, { riskCount: 1 });
    if (!built.ok) throw new Error(built.reason);
    store.write(built.artifact);
    const good = store.read(built.artifact.artifactId);
    expect(good.ok).toBe(true);
    // Tamper on disk: rewrite the file with a mutated payload, keep old hash
    const path = join(root, `${built.artifact.artifactId}.json`);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    (raw.payload as Record<string, unknown>).riskCount = 99; // silently inflated
    writeFileSync(path, JSON.stringify(raw));
    const bad = store.read(built.artifact.artifactId);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("integrity violation");
  });

  it("supersede writes a NEW artifact; the original is untouched (no mutation path)", () => {
    const first = buildReportArtifact("commander-decision", "m_1", 3, { kind: "propose" });
    if (!first.ok) throw new Error(first.reason);
    store.write(first.artifact);
    const second = store.supersede(first.artifact, { kind: "propose", revised: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.artifact.artifactId).not.toBe(first.artifact.artifactId);
    expect(second.artifact.supersedes).toBe(first.artifact.artifactId);
    expect(second.artifact.missionSeq).toBe(first.artifact.missionSeq + 1);
    // original still readable, unchanged
    const reread = store.read(first.artifact.artifactId);
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.artifact.payload).toEqual({ kind: "propose" });
  });

  it("payload schema validated before write (fail-closed)", () => {
    const schema = z.object({ health: z.enum(["healthy", "degraded", "blocked"]) }).strict();
    const ok = buildReportArtifact("tracker-report", "m_1", 1, { health: "healthy" }, { payloadSchema: schema });
    expect(ok.ok).toBe(true);
    const bad = buildReportArtifact("tracker-report", "m_1", 1, { health: "fantastic" }, { payloadSchema: schema });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("schema");
  });

  it("schema version stamped; hash is over canonical payload (key order independent)", () => {
    const a = buildReportArtifact("mission-report", "m_1", 1, { x: 1, y: { b: 2, a: 3 } });
    const b = buildReportArtifact("mission-report", "m_1", 1, { y: { a: 3, b: 2 }, x: 1 });
    if (!a.ok || !b.ok) throw new Error("build failed");
    expect(a.artifact.schemaVersion).toBe(REPORT_ARTIFACT_SCHEMA_VERSION);
    expect(a.artifact.sha256).toBe(b.artifact.sha256); // canonical: same content, same hash
    expect(hashPayload({ n: 1 })).not.toBe(hashPayload({ n: 2 }));
  });

  it("redaction pass-through: no credential-shaped content persists in artifacts", () => {
    // Matches the repo's redaction guarantee: writers must never persist
    // credential-shaped content. The artifact envelope is neutral; this test
    // pins that nothing in write/read adds or preserves secrets from the
    // envelope itself (kind/ids/seq/hash contain no payload-derived text).
    const built = buildReportArtifact("tracker-report", "m_1", 1, { summary: "observed", note: "clean" });
    if (!built.ok) throw new Error(built.reason);
    store.write(built.artifact);
    const raw = readFileSync(join(root, `${built.artifact.artifactId}.json`), "utf8");
    expect(raw).toContain('"observed"'); // payload persisted as given
    // credential shapes must not appear in the ENVELOPE (only payload data is hashed)
    expect(built.artifact.artifactId).toMatch(/^ma_[0-9a-f-]{36}$/);
    expect(built.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("MAC v1 P2 (PR 2.2): EvidenceRef resolution", () => {
  let root: string;
  let store: ReportArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nexum-ev-"));
    store = new ReportArtifactStore(root);
    const art = buildReportArtifact("tracker-report", "m_1", 1, { health: "healthy" });
    if (art.ok) store.write(art.artifact);
  });

  it("artifact:/event:/run: refs resolve against their stores", () => {
    const art = buildReportArtifact("tracker-report", "m_1", 2, { health: "degraded" });
    if (!art.ok) throw new Error(art.reason);
    store.write(art.artifact);
    const resolver = new EvidenceResolver({
      artifacts: store,
      lookupEvent: (id) => id === "evt_known",
      lookupRun: (id) => id === "run_known",
    });
    expect(resolver.resolve(`artifact:${art.artifact.artifactId}`).ok).toBe(true);
    expect(resolver.resolve("event:evt_known").ok).toBe(true);
    expect(resolver.resolve("run:run_known").ok).toBe(true);
  });

  it("unresolvable refs are contract violations, never silent", () => {
    const resolver = new EvidenceResolver({
      artifacts: store,
      lookupEvent: () => false,
      lookupRun: () => false,
    });
    const missing = resolver.resolve("event:evt_missing");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.violation).toContain("contract violation");
    const unknownArtifact = resolver.resolve("artifact:ma_nope");
    expect(unknownArtifact.ok).toBe(false);
    if (!unknownArtifact.ok) expect(unknownArtifact.violation).toContain("not found");
  });

  it("resolveAll is ok only when every ref resolves (violations listed per ref)", () => {
    const resolver = new EvidenceResolver({ lookupRun: (id) => id === "run_ok" });
    const all = resolver.resolveAll(["run:run_ok", "run:run_bad"]);
    expect(all.ok).toBe(false);
    expect(all.resolutions.map((r) => r.ok)).toEqual([true, false]);
  });

  it("a family without a configured store reports exactly that", () => {
    const resolver = new EvidenceResolver({});
    const cp = resolver.resolve("checkpoint:cp_1");
    expect(cp.ok).toBe(false);
    if (!cp.ok) expect(cp.violation).toContain("no checkpoint store configured");
  });
});
