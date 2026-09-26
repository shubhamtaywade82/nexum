/**
 * Tests for the consensus engine, voting strategies, priority resolution,
 * and inter-proposal conflict resolution.
 */
import { describe, it, expect } from "@jest/globals";
import {
  ConsensusEngine,
  MajorityVoting,
  UnanimousVoting,
  WeightedVoting,
  QuorumVoting,
  PriorityResolver,
  ConflictResolver,
} from "../../src/multiagent/consensus.js";
import { AgentMessageBus } from "../../src/multiagent/bus/message-bus.js";
import { SharedStateStore } from "../../src/multiagent/shared-state.js";

const electorate = ["alice", "bob", "carol"];

function votes(list: Array<[string, string]>) {
  return list.map(([voter, choice]) => ({ voter, choice, ts: 0 }));
}

describe("voting strategies", () => {
  const ctx = (vs: Array<[string, string]>) => ({
    proposal: { topic: "database choice", value: "sqlite", proposer: "alice" },
    votes: votes(vs),
    electorate,
  });

  it("majority approves on >50% of decided votes", () => {
    const strategy = new MajorityVoting();
    expect(
      strategy.tally(
        ctx([
          ["alice", "approve"],
          ["bob", "approve"],
          ["carol", "reject"],
        ]),
      ).outcome,
    ).toBe("approved");
    expect(
      strategy.tally(
        ctx([
          ["alice", "approve"],
          ["bob", "reject"],
        ]),
      ).outcome,
    ).toBe("deadlock");
    expect(
      strategy.tally(
        ctx([
          ["alice", "reject"],
          ["bob", "reject"],
        ]),
      ).outcome,
    ).toBe("rejected");
    expect(
      strategy.tally(
        ctx([
          ["alice", "abstain"],
          ["bob", "abstain"],
        ]),
      ).outcome,
    ).toBe("deadlock");
  });

  it("unanimous requires every non-abstain voter to approve", () => {
    const strategy = new UnanimousVoting();
    expect(
      strategy.tally(
        ctx([
          ["alice", "approve"],
          ["bob", "abstain"],
        ]),
      ).outcome,
    ).toBe("approved");
    expect(
      strategy.tally(
        ctx([
          ["alice", "approve"],
          ["bob", "reject"],
        ]),
      ).outcome,
    ).toBe("rejected");
    expect(strategy.tally(ctx([])).outcome).toBe("deadlock");
  });

  it("weighted voting counts per-agent weights", () => {
    const strategy = new WeightedVoting({ alice: 1, bob: 5 });
    // 1 (approve) vs 5 (reject) → rejected under weights, approved under heads.
    expect(
      strategy.tally(
        ctx([
          ["alice", "approve"],
          ["bob", "reject"],
        ]),
      ).outcome,
    ).toBe("rejected");
    expect(
      new WeightedVoting().tally(
        ctx([
          ["alice", "approve"],
          ["bob", "reject"],
        ]),
      ).outcome,
    ).toBe("deadlock");
  });

  it("quorum gates on participation", () => {
    const strategy = new QuorumVoting(0.9);
    const low = strategy.tally(ctx([["alice", "approve"]]));
    expect(low.outcome).toBe("deadlock");
    expect(low.rationale).toContain("quorum not met");
    const high = new QuorumVoting(0.3).tally(ctx([["alice", "approve"]]));
    expect(high.outcome).toBe("approved");
  });

  it("priority resolver breaks deadlocks by voter priority", () => {
    const resolver = new PriorityResolver(new Map([["carol", 10]]));
    const broken = resolver.breakDeadlock({
      proposal: { topic: "t", value: "v", proposer: "alice" },
      votes: votes([
        ["alice", "approve"],
        ["bob", "reject"],
        ["carol", "reject"],
      ]),
      electorate,
    });
    expect(broken?.outcome).toBe("rejected");
    expect(broken?.rationale).toContain("carol");
  });
});

describe("ConsensusEngine", () => {
  it("runs propose → cast → resolve with majority voting", () => {
    const engine = new ConsensusEngine({ electorate });
    const record = engine.propose({ topic: "index strategy", value: "rrf", proposer: "alice" });
    expect(record.id).toMatch(/^prop_/);
    engine.cast({ proposalId: record.id, voter: "alice", choice: "approve" });
    engine.cast({ proposalId: record.id, voter: "bob", choice: "approve" });
    engine.cast({ proposalId: record.id, voter: "carol", choice: "reject" });

    const outcome = engine.resolve(record.id);
    expect(outcome.outcome).toBe("approved");
    expect(outcome.winner).toBe("rrf");
    expect(outcome.tally).toEqual({ approve: 2, reject: 1 });
    // Resolution is final: repeat calls return the same decision.
    expect(engine.resolve(record.id)).toBe(outcome);
  });

  it("auto-resolves when the full electorate has voted", async () => {
    const engine = new ConsensusEngine({ electorate: ["a", "b"] });
    const record = engine.propose({ topic: "t", value: 1, proposer: "a" });
    engine.cast({ proposalId: record.id, voter: "a", choice: "approve" });
    engine.cast({ proposalId: record.id, voter: "b", choice: "approve" });
    await engine.awaitResolution(record.id, 100);
    expect(engine.proposal(record.id)?.resolved?.outcome).toBe("approved");
  });

  it("rejects non-electorate voters, unknown proposals, and bad options", () => {
    const engine = new ConsensusEngine({ electorate });
    const record = engine.propose({ topic: "t", value: "x", proposer: "alice", options: ["sqlite", "postgres"] });
    expect(() => engine.cast({ proposalId: record.id, voter: "outsider", choice: "approve" })).toThrow("electorate");
    expect(() => engine.cast({ proposalId: "prop_missing", voter: "alice", choice: "approve" })).toThrow(
      "unknown proposal",
    );
    expect(() => engine.cast({ proposalId: record.id, voter: "alice", choice: "mysql" })).toThrow(
      "not one of the proposal options",
    );
    engine.cast({ proposalId: record.id, voter: "alice", choice: "postgres" });
    engine.cast({ proposalId: record.id, voter: "bob", choice: "postgres" });
    engine.cast({ proposalId: record.id, voter: "carol", choice: "abstain" });
    expect(engine.resolve(record.id).winner).toBe("postgres");
  });

  it("breaks deadlocks through the priority resolver", () => {
    const engine = new ConsensusEngine({
      electorate: ["alice", "bob"],
      priorityResolver: new PriorityResolver(new Map([["bob", 10]])),
    });
    const record = engine.propose({ topic: "t", value: "plan-b", proposer: "alice" });
    engine.cast({ proposalId: record.id, voter: "alice", choice: "approve" });
    engine.cast({ proposalId: record.id, voter: "bob", choice: "reject" });
    const outcome = engine.resolve(record.id);
    expect(outcome.outcome).toBe("rejected");
    expect(outcome.rationale).toContain("priority");
    expect(outcome.rationale).toContain("bob");
  });

  it("mirrors proposals, votes, and decisions onto the bus", () => {
    const bus = new AgentMessageBus();
    bus.register("observer");
    const observer = bus.inbox("observer")!;
    const unsubscribe = bus.subscribeTopic("topic:coordination", { agentId: "observer" });

    const engine = new ConsensusEngine({ electorate: ["a", "b"], bus });
    const record = engine.propose({ topic: "t", value: "v", proposer: "a" });
    engine.cast({ proposalId: record.id, voter: "a", choice: "approve" });
    engine.cast({ proposalId: record.id, voter: "b", choice: "approve" });
    engine.resolve(record.id);

    const types = observer.drain().map((m) => m.type);
    expect(types).toEqual(["coord.proposal", "coord.vote", "coord.vote", "coord.decision"]);
    unsubscribe();
  });

  it("weighted voting changes the outcome through the engine", () => {
    const engine = new ConsensusEngine({
      electorate: ["junior", "senior"],
      voting: new WeightedVoting({ junior: 1, senior: 3 }),
    });
    const record = engine.propose({ topic: "t", value: "rewrite", proposer: "senior" });
    engine.cast({ proposalId: record.id, voter: "junior", choice: "approve" });
    engine.cast({ proposalId: record.id, voter: "senior", choice: "reject" });
    expect(engine.resolve(record.id).outcome).toBe("rejected");
  });
});

describe("ConflictResolver", () => {
  it("the supervisor's proposal wins outright", () => {
    const resolver = new ConflictResolver({ supervisorId: "boss", priority: new Map([["worker", 100]]) });
    const resolution = resolver.resolve({
      topic: "api design",
      proposals: [
        { proposer: "worker", value: "grpc" },
        { proposer: "boss", value: "rest" },
      ],
    });
    expect(resolution.method).toBe("supervisor");
    expect(resolution.winner.value).toBe("rest");
  });

  it("falls back to priority, then deterministic first-wins", () => {
    const resolver = new ConflictResolver({
      priority: new Map([
        ["alice", 5],
        ["bob", 2],
      ]),
    });
    const byPriority = resolver.resolve({
      topic: "t",
      proposals: [
        { proposer: "bob", value: "b" },
        { proposer: "alice", value: "a" },
      ],
    });
    expect(byPriority.method).toBe("priority");
    expect(byPriority.winner.value).toBe("a");

    const tied = new ConflictResolver().resolve({
      topic: "t",
      proposals: [
        { proposer: "bob", value: "first" },
        { proposer: "alice", value: "second" },
      ],
    });
    expect(tied.method).toBe("first");
    expect(tied.winner.value).toBe("first");
  });

  it("records resolutions as decisions in the shared state", () => {
    const shared = new SharedStateStore({ goal: "g" });
    const resolver = new ConflictResolver({ supervisorId: "boss", sharedState: shared });
    resolver.resolve({
      topic: "stack",
      proposals: [
        { proposer: "boss", value: "sqlite" },
        { proposer: "dev", value: "postgres" },
      ],
    });
    const decisions = shared.snapshot().decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].rationale).toContain("[stack]");
    expect(decisions[0].decidedBy).toBe("boss");
  });

  it("throws when there is nothing to resolve", () => {
    expect(() => new ConflictResolver().resolve({ topic: "t", proposals: [] })).toThrow("at least one");
  });
});
