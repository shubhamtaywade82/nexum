/**
 * Tests for SharedStateStore: CAS, conflict policies, ownership, merge
 * semantics, subscriptions, and the changelog.
 */
import { describe, it, expect } from "@jest/globals";
import { SharedStateStore, VersionConflictError } from "../../src/multiagent/shared-state.js";

describe("SharedStateStore", () => {
  it("starts at version 0 with the goal set and snapshots immutably", () => {
    const store = new SharedStateStore({ goal: "ship the report" });
    expect(store.version).toBe(0);
    const snap = store.snapshot();
    expect(snap.goal).toBe("ship the report");
    expect(snap.facts).toEqual([]);
    snap.facts.push({ id: "x", key: "k", value: 1, confidence: 1, source: "a", ts: 0 });
    expect(store.snapshot().facts).toEqual([]); // snapshot is a deep copy
  });

  it("bumps version, records the changelog, and notifies subscribers", () => {
    const store = new SharedStateStore({ goal: "g" });
    const events: Array<{ version: number; who: string }> = [];
    store.subscribe((state, change) => events.push({ version: state.version, who: change.who }));

    store.update({ owner: "alice", summary: "seed the goal note" }, (draft) => {
      draft.goal = "g (revised)";
    });

    expect(store.version).toBe(1);
    expect(store.snapshot().goal).toBe("g (revised)");
    expect(store.changelog()[0]).toMatchObject({
      who: "alice",
      version: 1,
      conflicted: false,
      summary: "seed the goal note",
    });
    expect(events).toEqual([{ version: 1, who: "alice" }]);
  });

  it("supports compare-and-swap via expectedVersion", () => {
    const store = new SharedStateStore({ goal: "g" });
    const v1 = store.version; // 0
    store.update(
      { owner: "alice" },
      (d) => void d.facts.push({ id: "f", key: "k", value: 1, confidence: 1, source: "alice", ts: 0 }),
    );
    // Bob wrote against a stale version → default policy "lww" proceeds but logs the conflict.
    store.update(
      { owner: "bob", expectedVersion: v1 },
      (d) => void d.facts.push({ id: "f2", key: "k2", value: 2, confidence: 1, source: "bob", ts: 0 }),
    );
    const conflictedEntry = store.changelog().find((e) => e.conflicted);
    expect(conflictedEntry).toMatchObject({ who: "bob", resolution: "lww" });
  });

  it("reject policy throws VersionConflictError on stale writes", () => {
    const store = new SharedStateStore({ goal: "g", conflictPolicy: "reject" });
    const stale = store.version;
    store.update({ owner: "alice" }, (d) => {
      d.goal = "v1";
    });
    expect(() =>
      store.update({ owner: "bob", expectedVersion: stale }, (d) => {
        d.goal = "v2";
      }),
    ).toThrow(VersionConflictError);
    expect(store.snapshot().goal).toBe("v1"); // rejected write never landed
  });

  it("supervisor-wins lets only the supervisor bypass conflicts", () => {
    const store = new SharedStateStore({ goal: "g", conflictPolicy: "supervisor-wins", supervisorId: "boss" });
    const stale = store.version;
    store.update(
      { owner: "alice" },
      (d) => void d.findings.push({ id: "x", summary: "first", source: "alice", ts: 0 }),
    );
    expect(() =>
      store.update(
        { owner: "worker", expectedVersion: stale },
        (d) => void d.findings.push({ id: "y", summary: "second", source: "worker", ts: 0 }),
      ),
    ).toThrow(VersionConflictError);
    store.update(
      { owner: "boss", expectedVersion: stale },
      (d) => void d.findings.push({ id: "z", summary: "boss version", source: "boss", ts: 0 }),
    );
    expect(store.snapshot().findings).toHaveLength(2);
    expect(store.changelog().at(-1)).toMatchObject({ who: "boss", conflicted: true, resolution: "supervisor-wins" });
  });

  it("custom conflict resolvers decide per write", () => {
    const store = new SharedStateStore({
      goal: "g",
      conflictPolicy: (ctx) => (ctx.owner === "trusted" ? "proceed" : "reject"),
    });
    const stale = store.version;
    store.update(
      { owner: "anyone" },
      (d) => void d.decisions.push({ id: "d1", rationale: "first", decidedBy: "anyone", ts: 0 }),
    );
    expect(() => store.update({ owner: "stranger", expectedVersion: stale }, () => {})).toThrow(VersionConflictError);
    store.update(
      { owner: "trusted", expectedVersion: stale },
      (d) => void d.decisions.push({ id: "d2", rationale: "second", decidedBy: "trusted", ts: 0 }),
    );
    expect(store.changelog().at(-1)?.resolution).toBe("custom");
  });

  it("enforces field ownership for non-owners", () => {
    const store = new SharedStateStore({
      goal: "g",
      conflictPolicy: "reject",
      fieldOwners: { decisions: ["boss"] },
    });
    expect(() =>
      store.update(
        { owner: "worker" },
        (d) => void d.decisions.push({ id: "d", rationale: "x", decidedBy: "worker", ts: 0 }),
      ),
    ).toThrow(VersionConflictError);
    store.update(
      { owner: "boss" },
      (d) => void d.decisions.push({ id: "d", rationale: "x", decidedBy: "boss", ts: 0 }),
    );
    // Non-owned fields are unaffected.
    store.update({ owner: "worker" }, (d) => void d.findings.push({ id: "f", summary: "ok", source: "worker", ts: 0 }));
    expect(store.snapshot().findings).toHaveLength(1);
  });

  it("merges facts per key with confidence-based per-key LWW", () => {
    const store = new SharedStateStore({ goal: "g" });
    store.addFact({ key: "port", value: 3000, confidence: 0.6, owner: "alice" });
    const superseded = store.addFact({ key: "port", value: 8080, confidence: 0.9, owner: "bob" });
    expect(superseded.value).toBe(8080);
    expect(store.snapshot().facts).toHaveLength(1);
    expect(store.fact("port")?.value).toBe(8080);
    expect(store.fact("port")?.source).toBe("bob");

    // A weaker concurrent fact does not clobber the stronger one.
    store.addFact({ key: "port", value: 9999, confidence: 0.2, owner: "carol" });
    expect(store.fact("port")?.value).toBe(8080);
  });

  it("accumulates findings, artifacts, decisions, and agent statuses", () => {
    const store = new SharedStateStore({ goal: "g" });
    store.addFinding({
      summary: "graph is cyclic",
      tags: ["graph"],
      owner: "analyst",
      evidence: [{ artifactId: "art_1" }],
    });
    store.publishArtifact({ artifactId: "art_1", name: "analysis", version: 1, owner: "analyst" });
    store.recordDecision({
      rationale: "break the cycle at the weakest edge",
      decidedBy: "boss",
      alternatives: ["rewrite"],
    });
    store.setAgentStatus({ agentId: "analyst", state: "working", currentTaskId: "t1", progress: 0.5 });

    const snap = store.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.findings[0].evidence).toEqual([{ artifactId: "art_1" }]);
    expect(snap.artifacts).toHaveLength(1);
    expect(snap.decisions[0].alternatives).toEqual(["rewrite"]);
    expect(store.agentStatus("analyst")).toMatchObject({ state: "working", currentTaskId: "t1" });
    expect(store.findingsByTag("graph")).toHaveLength(1);
  });

  it("status updates replace prior statuses for the same agent", () => {
    const store = new SharedStateStore({ goal: "g" });
    store.setAgentStatus({ agentId: "w1", state: "working" });
    store.setAgentStatus({ agentId: "w1", state: "done" });
    expect(store.snapshot().agentStatuses).toHaveLength(1);
    expect(store.agentStatus("w1")?.state).toBe("done");
  });
});
