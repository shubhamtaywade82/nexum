# ADR-0001: Three-Agent Coordination Layer (Tracker / Predictor / Commander)

- **Status:** Proposed
- **Date:** 2026-11-26
- **Supersedes:** none
- **Verified against:** `shubhamtaywade82/nexum` @ `3d2c1d02ce7e2c206db3e7888c2753cf0c52e6ef` (main, 2026-11-22); `agentic-sdlc-kit` main (AGENTS.md, README.md)
- **Full specification:** `docs/multi-agent/SPEC.md`

## Context

Nexum 2.0.0 (GA, published 2026-11-22) is an agent runtime and harness for
autonomous software engineering with a mature, layered architecture:

- **Control plane** (`src/orchestration`): `Planner`, `TaskGraph`,
  `Scheduler`, `Executor`, `Delegator`, `AgentRegistry`, `LoopDetector`,
  DAG validation (`dag-validator.ts`), and a deterministic complexity gate
  (`complexity.ts`).
- **Agent runtime** (`src/runtime`): `DefaultAgentRuntime` as composition
  root — state, budgets, policies, retries, cancellation, checkpoints
  (`.nexum/checkpoint.json`), a verification gate
  (`verification-gate.ts`), and a mission phase model
  (`mission-derive.ts`).
- **Runtime services** (per `docs/guide/architecture.md`): `ModelGateway`,
  `ToolGateway`, `PolicyEngine`, `ContextManager`, `SessionManager`,
  `ExecutionManager`, `ApprovalManager`.
- **First-class delegation** (`src/orchestration/delegation/delegator.ts`):
  `DelegationRequest → isolated ChildExecution → ResultAggregation`, with
  capability-driven child selection (`AgentRegistry.selectFor()`), budget
  inheritance (`BudgetManager.deriveChild()`), concurrency caps, and
  cancellation.
- **Evolution plane** (`src/evolution`): `ClosedLoopEngine` with worktree
  isolation, evidence-gated promotion and rollback.

A proposal circulated ("the Instagram three-agent prompt") to build three
continuously-running autonomous agents that share tools and memory and
coordinate freely. That proposal is attractive but, taken literally, would
re-create infrastructure Nexum already has — and infrastructure Nexum
explicitly removed.

### The removed `src/multiagent` precedent

Nexum's `CHANGELOG.md` (2.0.0-alpha.5, "Removed: the unused multi-agent
subsystem") records the removal of `src/multiagent` — a message bus, shared
state, consensus and supervisor loop — because _no CLI command, host
endpoint, TUI view or runtime path used it_. The restore path is preserved
(`git checkout 01b42ab -- src/multiagent tests/multiagent`) precisely so the
decision is reversible. Any new multi-agent work must justify why it will not
repeat that outcome.

Additionally, verification of the live repository surfaced capabilities the
original proposal did not account for (see `SPEC.md` Appendix A):

- an **existing SDLC Kit bridge** in `src/tools/sdlc-tools.ts`
  (`sdlc_inspect`, `sdlc_validate_spec`, `sdlc_validate_plan`, `sdlc_verify`,
  `sdlc_doctor`);
- an **existing mission phase model** in `src/runtime/mission-derive.ts`
  (`MissionState`, `createMissionState`, `deriveMissionPhases`);
- an **existing deterministic complexity gate** in
  `src/orchestration/complexity.ts` (`assessComplexity`, no model call).

## Decision

Implement the three-agent concept as **three registered, capability-scoped
agent roles plus a deterministic mission coordinator**, layered strictly on
Nexum's existing control plane:

1. **Tracker, Predictor, Commander are `AgentDescriptor` registrations** in
   the existing `AgentRegistry` (`src/runtime/agent/agent-runtime.ts`),
   following the product-agent convention of `src/agents/{devagent,cryptoagent}`.
   They are ordinary agents with narrow capability declarations, not a
   privileged subsystem.
2. **All delegation goes through the existing `Delegator`.** The Commander
   never executes tools on behalf of other agents and never spawns processes
   itself; it emits decisions that the coordinator turns into
   `DelegationRequest`s under a `DelegationPolicy`.
3. **Communication is typed, event-driven, and evidence-carrying.** Roles
   exchange references to immutable artifacts (reports) over the existing
   `EventEnvelope`/`EventSink`, not shared mutable state. Every observation,
   prediction and decision must cite evidence references; unevidenced output
   is rejected at the contract boundary.
4. **A deterministic `MissionCoordinator`** (new, in `src/orchestration/mission/`)
   owns the observe → assess → decide → execute → verify loop, the mission
   lifecycle state machine, budgets, replan limits and termination. The LLM
   roles advise; the coordinator decides what actually runs.
5. **Commander proposes; the deterministic control plane authorizes.** Every
   Commander decision is re-validated against `PolicyEngine` decisions, budget
   ceilings, `validatePlanDag` and the mission's autonomy profile before
   anything executes. Approval-required actions route through the existing
   `ApprovalManager` flow — a model output is never an authorization.
6. **The Agentic SDLC Kit remains the workflow authority.** Integration goes
   through an allowlisted adapter (extending `src/tools/sdlc-tools.ts`) that
   exposes typed commands (`kit next --json`, `kit feature … start|red|green|
refactor|verify`, `kit journal --verify`, …). TDD phase transitions stay
   with the Kit; agents cannot declare GREEN or VERIFIED.
7. **Autonomy is profiled and starts supervised.** Three profiles —
   `supervised` (default), `controlled-autonomous`, `research` — map onto
   existing policy postures, permission classes (`docs/ISSUE_AUTOMATION.md`)
   and delegation policy. Expanding autonomy requires evidence, not
   optimism.
8. **A complexity gate prevents gratuitous multi-agent execution.**
   `assessComplexity` (plus mission-policy risk signals) decides whether a
   request runs as a normal single-agent turn or as a three-role mission.

### Non-negotiable invariants (testable)

| #   | Invariant                                                                                                                                        | Enforced by                                                                                                                            | Verified by                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| I1  | No unbounded autonomous loops: every mission has hard wall-clock, model-call, tool-call, token, child-count and replan limits                    | Mission budget envelope over `BudgetManager`; `LoopDetector`; `DelegationPolicy` caps                                                  | Invariant tests INV-1..INV-3 (`TEST-STRATEGY.md`) |
| I2  | No self-authorized execution: a model-generated decision never bypasses `PolicyEngine`, `ApprovalManager` or `ToolGateway`                       | Decision re-validation in the coordinator; tool pipeline (`registry → schema → capability → policy → budget → idempotency → executor`) | INV-4..INV-6                                      |
| I3  | No unverified predictions: Predictor output classifies its basis and cites evidence; insufficient evidence ⇒ abstention, not invented confidence | Contract validation (`evidenceRefs` non-empty per prediction; `basis` enum)                                                            | INV-7..INV-9                                      |
| I4  | No unrestricted shared tools: the capability matrix is enforced by the runtime, not by prompts                                                   | Per-role `allowedPackIds`, execution profiles, policy postures, `DelegationPolicy.inheritPolicy` (narrow-only)                         | INV-10..INV-12                                    |
| I5  | No unnecessary multi-agent execution: trivial requests run single-agent                                                                          | `assessComplexity` + mission policy gate                                                                                               | INV-13..INV-14                                    |

Two derived invariants with the same standing:

| #   | Invariant                                                                                                                                                    | Enforced by                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| I6  | No agent declares its own success: mission completion requires deterministic verification evidence (verification gate / Kit journal), never an agent's claim | `gateTaskCompletion` (`src/runtime/verification-gate.ts`) + Kit evidence chain |
| I7  | Terminal mission states are immutable (late cancellation cannot rewrite a completed mission)                                                                 | Lifecycle state machine, mirroring the `SubagentSession` terminal-state rule   |

## Rejected alternatives

1. **Reintroduce `src/multiagent` (message bus, shared state, consensus,
   supervisor loop).** Rejected: it was removed as dead weight; a new
   message-bus layer duplicates `EventEnvelope`/`EventSink`, run recording
   and the `Delegator`'s child-aggregation semantics, and reintroduces the
   "unused subsystem" failure mode. Restore command stays available for
   archaeology, not for this.
2. **A standalone multi-agent runtime package.** Rejected: duplicates
   registry, orchestration, budgets, cancellation, checkpoints and
   evaluation that Nexum already ships and tests.
3. **One mega-agent with three "personas" in a system prompt.** Rejected:
   capability scoping, per-role policy postures, per-role evaluation and
   independent budget accounting all become unenforceable; prompt-level
   separation provides no isolation boundary under prompt injection.
4. **Free-form shared memory between roles.** Rejected: unstructured
   conversation dumps destroy auditability and replay. Replaced by the
   three-store split (event store / artifact store / semantic memory) in
   `SPEC.md` §6.
5. **Zero-human fully autonomous execution from day one.** Rejected: conflicts
   with Nexum's fail-closed approval posture (`autoApprove` defaults to
   `false`) and the Kit's explicit human-approval boundaries. Supervised
   first; autonomy expands only for validated, bounded operations.

## Consequences

**Positive.** Minimal new surface area; the trio inherits budgets,
cancellation, policy, recording, checkpoints, evaluation and TUI observability
for free; capability matching (`selectFor`) makes worker selection
declarative; every invariant is testable without an LLM in the loop.

**Negative.** The coordinator is new sequential logic that must be kept
deterministic and boring; contract validation adds latency to every role
transition; the capability matrix must be maintained as roles gain
capabilities.

**Neutral.** `src/tools/sdlc-tools.ts` gains a consumer with stricter
requirements (allowlist extension); the existing `MissionState` model in
`src/runtime/mission-derive.ts` is extended rather than replaced, so the TUI
activity feed keeps working unchanged.

## Compliance

This ADR must land with the layering rules respected:
`tests/architecture/layering.test.ts` must be extended to assert that
`src/orchestration/mission/**` imports no UI or domain plane, and that the
three role modules import only runtime/core contracts.

## Acceptance (P8 pilot exit)

This ADR is **Proposed** until the supervised pilot (ROADMAP P8, issue #86)
produces its evidence; it flips to **Accepted** when all of the following hold,
linked from the pilot report (`nexum mission pilot` output):

1. **Pilot evidence published** — `nexum mission pilot` over the pilot
   missions directory: ≥ 20 supervised missions across at least three classes
   (bug investigation, test-flake diagnosis, bounded refactor), with the Kit
   workflow bound on at least half.
2. **Zero successful permission escalations** across the pilot (the report's
   escalation-finding count = 0; INV-5 held in production telemetry).
3. **Zero false successes** across the pilot (the north-star safety metric;
   any finding is a P0-class defect and freezes autonomy expansion).
4. **Invariants green in production telemetry** — the P7 evaluation gates
   (`nexum eval --multi-agent`, nightly) passing over the pilot window.
5. **Graduation is per class, evidence-first** (SPEC §9): a class expands to
   `controlled-autonomous` only at ≥ 20 missions, verified completion ≥ 90%,
   zero false successes, zero escalation findings — the pilot report names
   the unmet criteria otherwise.

The pilot runs `supervised` (the shipped default); autonomy expansion
requires the explicit `NEXUM_MISSION_AUTONOMY=controlled` opt-in, and
`research` additionally requires an isolated worktree (SPEC §9 "who
enables"). An explicit CLI request alone never escalates a profile.
