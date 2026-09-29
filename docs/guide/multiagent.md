# Multi-Agent Coordination

Nexum had delegation (supervisor → spawn child → result) — a call tree. This plane adds general multi-agent coordination: peer messaging, a shared blackboard, consensus, and a true supervisor loop.

```
                    ┌────────────────────────────┐
                    │        SUPERVISOR          │
                    │  decompose → assign →      │
                    │  watch → retry → merge     │
                    └────────────┬───────────────┘
                                 │ coord.* messages
                    ┌────────────┴───────────────┐
                    │      AGENT MESSAGE BUS     │
                    │  inboxes · topics · req/resp│
                    └──┬──────────┬──────────┬───┘
                       ▼          ▼          ▼
                   Agent A     Agent B     Agent C
                       └──────────┴──────────┘
                              ▼ (CAS writes)
                    ┌────────────────────────────┐
                    │     SHARED AGENT STATE     │
                    │  goal · facts · findings · │
                    │  artifacts · decisions ·   │
                    │  statuses (versioned)      │
                    └────────────────────────────┘
                              ▼ (disagreement)
                    ┌────────────────────────────┐
                    │  CONSENSUS / CONFLICTS     │
                    │  votes · quorum · priority │
                    └────────────────────────────┘
```

## Message bus

```ts
const bus = new AgentMessageBus();
const alice = bus.register("alice");
bus.register("bob");

bus.send({ from: "alice", to: "bob", type: "coord.task.assign", payload: { taskId: "t1", goal: "..." } });
bus.send({ from: "alice", to: "*", type: "announce", payload: {} });            // broadcast
bus.subscribeTopic("topic:research", { agentId: "researcher" });                // pub/sub

const reply = await bus.request("alice", "bob", "coord.question", { question: "..." });
```

Envelopes carry `correlationId` (request/response chains), `conversationId` (working threads — `task:<id>`, `proposal:<id>`), and `inReplyTo`. Replies matching an open `request()` resolve its promise directly and never pollute the inbox. Unroutable messages produce **dead-letter receipts**, never silent drops. Bounded filterable history gives you the audit view.

## Coordination protocol

Standard vocabulary with typed payloads and builders: `coord.task.assign` / `.status` / `.result`, `coord.question` / `.answer`, `coord.proposal` / `.vote` / `.decision`, `coord.resource.request` / `.release`, `coord.heartbeat`.

## Shared state

`SharedStateStore` — the coordination blackboard with **versioning, compare-and-swap, field ownership, and explicit conflict policies**:

```ts
const shared = new SharedStateStore({
  goal: "produce the quarterly report",
  conflictPolicy: "supervisor-wins",   // "lww" | "reject" | "supervisor-wins" | custom
  supervisorId: "supervisor",
  fieldOwners: { decisions: ["supervisor"] },
});

shared.update({ owner: "analyst", expectedVersion: shared.version }, (draft) => { ... });
shared.addFact({ key: "fiscal-year", value: 2026, confidence: 0.9, owner: "analyst" });
shared.addFinding({ summary: "revenue up 12%", evidence: [{ artifactId: "art_1" }], owner: "researcher" });
shared.publishArtifact({ artifactId: "art_1", name: "dataset", owner: "researcher" });
shared.recordDecision({ rationale: "use RRF fusion", decidedBy: "supervisor" });
shared.setAgentStatus({ agentId: "analyst", state: "working" });
```

Stale CAS writes and non-owner mutations hit the conflict policy: proceed-and-log (`lww`), throw `VersionConflictError` (`reject`), supervisor-only bypass (`supervisor-wins`), or a custom resolver. Facts merge per key (confidence-based LWW); findings/artifacts/decisions accumulate set-union style. Every mutation lands in the changelog; subscribers get `(state, change)` pushes.

## Consensus

```ts
const engine = new ConsensusEngine({
  electorate: ["alice", "bob", "carol"],
  voting: new WeightedVoting({ alice: 1, bob: 2, carol: 3 }),   // or Majority / Unanimous / Quorum
  priorityResolver: new PriorityResolver(new Map([["carol", 10]])),
  bus,  // optional: proposals/votes/decisions mirrored as coord.* messages
});
const p = engine.propose({ topic: "database", value: "sqlite", proposer: "alice" });
engine.cast({ proposalId: p.id, voter: "bob", choice: "approve" });
const decision = engine.resolve(p.id);   // auto-resolves when the full electorate voted
```

Between **competing proposals**, `ConflictResolver` arbitrates deterministically: supervisor's proposal wins outright → else highest priority → else first proposal (tie-break). Resolutions are recorded as decisions in the shared state.

## Supervisor

```ts
const supervisor = new SupervisorAgent({
  bus,                              // default task port: coord.task.assign → coord.task.result
  sharedState,
  workers: [{ agentId: "researcher" }, { agentId: "analyst" }],
  planner: (goal) => [...],         // PlannerPort — default: the goal as one task
  policy: { maxRounds: 5, retryLimit: 1, maxParallel: 4, taskTimeoutMs: 30_000 },
});
const result = await supervisor.orchestrate("produce the quarterly report");
// { status: "completed" | "stalled" | "max-rounds", rounds, tasks, state, summary }
```

The loop owns coordination state and decides dynamically: who works on what, when to retry (`retryLimit`), when results merge into the shared state (findings + artifact references), and when to terminate (all done / stalled — a round with zero completions / max rounds). The risky parts are injected — `PlannerPort` decomposes goals, `TaskPort` executes assignments (swap the bus port for `SubagentService` or a distributed transport without touching the loop).
