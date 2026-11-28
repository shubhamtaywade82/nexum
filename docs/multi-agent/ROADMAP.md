# Nexum Multi-Agent Coordination v1 — Implementation Roadmap (P0–P8)

Reference implementation plan for `docs/multi-agent/SPEC.md` and
`docs/adr/ADR-0001-multi-agent-coordination-layer.md`. Baseline pin:
`3d2c1d02ce7e2c206db3e7888c2753cf0c52e6ef` (main, 2026-11-22).

Conventions applying to every PR in this roadmap:

- `npm run lint && npm run format:check && npm run build && npm test` must be
  green (the repo's `release:check` core; note the test split — server/protocol
  suites run serially via `npm run test:server`).
- TypeScript strict; ESM `.js` import extensions; kebab-case filenames; files
  ≤ 300 lines and functions ≤ 30 lines where the repo follows that style
  (match surrounding code).
- No PR introduces a message bus, shared mutable state, consensus module or a
  second runtime (ADR-0001).
- Every phase closes with its invariant tests green (`TEST-STRATEGY.md`).

## Phase overview

| Phase | Deliverable | Depends on | Est. PRs | Issue |
| --- | --- | --- | --- | --- |
| P0 | ADR + spec landing + layering rules + invariants skeleton | — | 2 | [#78](https://github.com/shubhamtaywade82/nexum/issues/78) |
| P1 | Three role descriptors + worker capability tags | P0 | 1 | [#79](https://github.com/shubhamtaywade82/nexum/issues/79) |
| P2 | Event + artifact contracts with schema validation and provenance | P1 | 2 | [#80](https://github.com/shubhamtaywade82/nexum/issues/80) |
| P3 | Tracker agent (grounded observation, read-only enforcement) | P2 | 2 | [#81](https://github.com/shubhamtaywade82/nexum/issues/81) |
| P4 | Predictor agent (evidence-grounded, abstention) | P2 | 2 | [#82](https://github.com/shubhamtaywade82/nexum/issues/82) |
| P5 | Commander agent + MissionCoordinator (lifecycle, budgets, DAG, audit CLI) | P2, P3, P4 | 3 | [#83](https://github.com/shubhamtaywade82/nexum/issues/83) |
| P6 | Agentic SDLC Kit adapter (TDD + verification gates) | P5 | 2 | [#84](https://github.com/shubhamtaywade82/nexum/issues/84) |
| P7 | Evaluation suite (reliability, cost, safety, recovery) | P3–P6 | 2 | [#85](https://github.com/shubhamtaywade82/nexum/issues/85) |
| P8 | Supervised production pilot | P7 | 1 + ops | [#86](https://github.com/shubhamtaywade82/nexum/issues/86) |

---

## P0 — Architecture ADR, spec landing, invariants skeleton

**Objective.** Make the architecture decision durable and unenforceable-to-violate:
docs land in the repo, and the layering rules that keep the coordination layer
thin are test-enforced from day one.

**PR 0.1 — `docs(adr): ADR-0001 three-agent coordination layer`**

- Add `docs/adr/ADR-0001-multi-agent-coordination-layer.md` (from this pack).
- Add `docs/multi-agent/{SPEC,ROADMAP,TEST-STRATEGY,THREAT-MODEL,RISK-REGISTER,OPS-RUNBOOK}.md`.
- Wire `docs/multi-agent/*` into the VitePress sidebar (`docs/.vitepress`).
- Confirm the approval-flow export name (`ApprovalManager` vs
  `ApprovalBroker`, SPEC Appendix A, F-4) and record the outcome in
  `SPEC.md` §2 — one-line correction PR if the doc needs it.

**PR 0.2 — `test(architecture): enforce mission-plane layering rules`**

- Extend `tests/architecture/layering.test.ts`:
  - `src/orchestration/mission/**` must not import `src/ui/**`,
    `src/agents/**`, `src/domains/**`.
  - `src/agents/{tracker,predictor,commander}/**` must not import
    `src/orchestration/**` (runtime/core contracts only).
  - `src/domains/agentic-sdlc-kit/**` must not import `src/ui/**`.
- Add the five ADR invariants (I1–I5) as **failing-placeholder** test files
  with `test.todo` markers mapped to their enforcing phase (they turn real in
  P2–P5; `TEST-STRATEGY.md` INV-1..INV-14).

**Acceptance criteria**

- [ ] ADR and spec pack committed under `docs/`; VitePress build green
      (`npm run docs:build`).
- [ ] Layering test green on the new rules; CI green.
- [ ] No production code changed in P0 except the layering test file.
- [ ] Invariant IDs I1–I7 referenced in test titles traceable to ADR-0001.

---

## P1 — Three role descriptors registered

**Objective.** The trio exists as first-class, capability-scoped registrations —
cheap, inert, and testable — before any behavior lands.

**PR 1.1 — `feat(agents): register tracker, predictor, commander roles`**

- `src/agents/tracker/tracker-agent.ts`, `predictor/predictor-agent.ts`,
  `commander/commander-agent.ts`: `AgentDescriptor` factories (SPEC §4.1–4.3)
  + registration wiring in `src/agents/index.ts`.
- Add `capabilities` to the worker (`devagent`) descriptor (SPEC §8.3) —
  optional field, non-breaking.
- Registry tests:
  - `selectFor(["observe", "evidence-collection"])` → exactly `[tracker]`.
  - `selectFor(["predict", "risk-assessment"])` → `[predictor]`.
  - `selectFor(["coordinate", "mission-planning"])` → `[commander]`.
  - `selectFor(["code-edit", "test-execution"])` → `[devagent]` (new tags).
  - Role descriptors declare `allowedPolicies` ⊆ {readonly, restricted,
    standard per SPEC}; a runtime test refuses to execute a role outside its
    declared policies.
  - Pack-scope test: the packs mounted for each role contain no
    WRITE/EXECUTE-class tool for tracker/predictor (capability matrix row
    enforcement, SPEC §8.1).

**Acceptance criteria**

- [ ] `AgentRegistry.require("tracker"|"predictor"|"commander")` succeeds with
      the SPEC §4 posture declarations.
- [ ] Capability-selection tests green, including the no-match refusal
      message (`no registered agent satisfies capabilities [...]`).
- [ ] `devagent` capability tags registered; existing delegation paths
      unchanged (regression: full `npm test`).
- [ ] No behavior wired to the roles yet (inert registrations only).

---

## P2 — Event and artifact contracts

**Objective.** The communication substrate: typed mission events over the
existing envelope, immutable report artifacts with provenance, fail-closed
validation.

**PR 2.1 — `feat(mission): mission event contracts over EventEnvelope`**

- `src/orchestration/mission/events.ts` (SPEC §5.1 union), `event-router.ts`
  (typed fan-out to recorder + TUI sink + approval listeners).
- Zod schemas per payload; unknown-field tolerance on read, strict on write.
- Contract tests: every event type round-trips through the sink with `seq`
  ordering and full id chain; router drops malformed events (fail-closed) and
  records the drop reason.

**PR 2.2 — `feat(mission): immutable report artifacts + evidence refs`**

- `ReportArtifact<T>` envelope (SPEC §5.3): exclusive write (`wx`), sha256
  self-hash, `missionSeq`, supersede-by-new-artifact semantics (no mutation).
- `EvidenceRef` resolution service: `artifact:`/`event:`/`run:` refs resolve
  against their stores; unresolvable refs are contract violations.
- Contract tests: artifact immutability (second write refused), ref resolution,
  redaction pass-through (no credential-shaped content persists — matches
  existing redaction guarantees).

**Acceptance criteria**

- [ ] Event envelope adds no new bus type; all mission events persist via
      `RunRecorder` into `.nexum/runs` (replay-order `seq` verified).
- [ ] Artifact writes: `wx` semantics, self-hash verified on read, no
      overwrite path exists.
- [ ] INV-10 (contract validation rejects unevidenced reports) test exists
      and is green (enforces I3's substrate).
- [ ] Zero changes to `EventEnvelope` itself (extension only).

---

## P3 — Tracker agent

**Objective.** Grounded observation with deterministic collectors and
read-only enforcement; the first role with behavior.

**PR 3.1 — `feat(agents/tracker): grounded observation collectors`**

- Deterministic collectors: git state (via governed read-only git verbs), test
  results (sandboxed run results), CI status (github read-only verbs), agent
  traces (run-log/session_events reads), TaskGraph snapshot, budget snapshot.
- `contracts.ts` (SPEC §4.1) with the evidence rule: observations with empty
  or unresolvable `evidenceRefs` are dropped and logged; unresolved refs
  surface as `contradictory-evidence` blockers.
- `instructions.ts`: the grounding prompt contract (advisory layer; the
  collector + validation rules are the enforcement).

**PR 3.2 — `test(agents/tracker): grounding and honesty tests`**

- INV-7: no observation without resolvable evidence (collector-less claims
  rejected).
- INV-7b: collector failures produce blockers, never silence (health
  `blocked` path).
- Staleness: `staleAfter` respected by a consumer stub.
- Read-only enforcement: a scripted prompt-injection attempt in file content
  cannot make the tracker write (posture denial asserted).

**Acceptance criteria**

- [ ] Tracker produces `TrackerReport` artifacts passing schema validation
      with ≥ 1 evidence ref per observation in the scripted fixture repo.
- [ ] All WRITE/EXECUTE tool attempts by tracker are denied by policy
      (asserted in tests, not prompts).
- [ ] Health states `healthy|degraded|blocked` correctly derived in fixture
      scenarios (clean repo / failing collector / mixed).

---

## P4 — Predictor agent

**Objective.** Evidence-grounded risk assessment with labeled bases and
first-class abstention.

**PR 4.1 — `feat(agents/predictor): prediction contracts + abstention`**

- `contracts.ts` (SPEC §4.2): `basis` required; `probability` requires
  `basis: "statistical"` + calibration-dataset evidence ref (enforced by
  schema + service check — no dataset, no probability).
- `basedOnReportId` lineage validation (non-stale tracker report required).
- Semantic-memory read integration for historical patterns (read-only).

**PR 4.2 — `test(agents/predictor): abstention + basis honesty tests`**

- INV-8: missing evidence ⇒ `abstained` set, recommendations array empty
  (schema-level enforcement).
- INV-9: `probability` without calibration dataset ref is rejected at the
  contract boundary.
- Basis-labeling: a `model-hypothesis` prediction is never decision-sufficient
  downstream (coordinator stub test).
- Lineage: stale/absent tracker report ⇒ predictor refuses to run.

**Acceptance criteria**

- [ ] All four grounding rules (SPEC §4.2) test-enforced.
- [ ] Fixture-driven prediction reports: correct basis labeling, empty
      recommendations under abstention.
- [ ] No write-capable tool mounted; posture test green.

---

## P5 — Commander + MissionCoordinator

**Objective.** The deterministic core: lifecycle, decision re-validation,
delegation through the Delegator, budgets, checkpoints, cancellation, audit.

**PR 5.1 — `feat(mission): MissionPolicy + budget envelope + lifecycle`**

- `mission-policy.ts` (SPEC §9), state machine (SPEC §7) with immutable
  terminal states, checkpoints at `.nexum/missions/<id>/checkpoint.json`
  (SPEC §7.3), cancellation mapping to `DefaultAgentRuntime.cancel`.
- Budget envelope enforcement composed from `BudgetManager` +
  `DelegationPolicy` + `LoopDetector` (SPEC §12).
- INV-1 (hard budget), INV-2 (replan bounds), INV-3 (loop detection) tests
  with a scripted fake role runtime — no models needed.

**PR 5.2 — `feat(mission): commander contracts + decision re-validation`**

- `commander/contracts.ts` (SPEC §4.3); `reValidateDecision` (SPEC §11.4) as
  a pure function: profile membership, `validatePlanDag`, budget share,
  retry/replan budgets, approval-class routing, completion-evidence check.
- `Delegator.review()` called before every `delegate()`; refusal reasons
  become `DecisionRejection`s.
- INV-4 (no self-authorized execution — a "valid-looking" forged decision
  exceeding profile is refused), INV-5 (invalid DAG rejection is final, no
  silent repair), INV-6 (complete without evidence refused) tests.
- `commander/evaluator.ts` stub wired for P7.

**PR 5.3 — `feat(cli): nexum mission surface + audit`**

- Minimal CLI/TUI: `nexum mission start|status|resume|cancel|audit`
  (`audit` reconstructs from events + artifacts only, SPEC §14).
- Phase mapping onto `MissionState`/`deriveMissionPhases` so the existing TUI
  activity feed renders missions unchanged (SPEC §11.5).
- End-to-end smoke test with `ScriptedAgentRuntime`-style fake agents
  (deterministic; matches the repo's existing scripted-case testing pattern).

**Acceptance criteria**

- [ ] INV-1..INV-6 green; terminal-state immutability test green (late
      `cancel` on completed mission is a no-op recorded as a warning event).
- [ ] Resume: orphaned in-flight delegations marked, no re-execution of
      completed verified nodes, idempotency keys prevent double side
      effects (fixture test).
- [ ] `nexum mission audit <id>` output reconstructs state transitions,
      decisions + re-validation verdicts, and budget consumption without any
      LLM call.
- [ ] Layering test still green (mission plane imports clean).

---

## P6 — Agentic SDLC Kit adapter

**Objective.** The Kit becomes the workflow authority for Kit-bound missions,
through the typed, allowlisted adapter.

**PR 6.1 — `feat(domains/agentic-sdlc-kit): typed adapter over executeKitCommand`**

- `adapter.ts` (SPEC §10.2): command union → argv, id regex validation,
  deny-by-default allowlist, timeout policy, fail-closed JSON parsing.
- Phase machine ops (`feature-phase`, `fix-phase`), `next`, `journal-verify`;
  reuse/export `resolveKitCliPath`/`executeKitCommand` from
  `src/tools/sdlc-tools.ts`; de-duplication review of the five existing
  tools against the adapter path (RISK-REGISTER R-06).
- Kit-missing behavior: `degraded` + blocker; `requireKitWorkflow` missions
  abort — never proceed ungated.

**PR 6.2 — `feat(mission): Kit evidence → verification gates`**

- `verification.ts`: `KitEvidence` artifacts; RED requires observed failing
  exit; GREEN/REFACTOR require observed passing exit; `journal-verify` chain
  required for `mission.completed` on Kit-bound missions.
- Coordinator alignment with `kit next --json` (`requiredAction` wins on
  disagreement; mismatch logged as coordination failure).
- Tests with a **stub Kit CLI** (scripted fixture binary or injected runner —
  the adapter must take an injectable command runner like
  `GitHubDeliveryAdapter` takes git/HTTP): all §10.5 failure modes covered.

**Acceptance criteria**

- [ ] An LLM (scripted) attempting to declare GREEN/VERIFIED cannot advance
      the Kit phase — only adapter-observed exit codes can (INV-6 extension).
- [ ] Allowlist test: every non-union invocation is refused (including
      `kit host install`, `kit install`, `kit new`, `kit evolve`).
- [ ] Journal tamper fixture → mission aborted + escalation event (threat
      T8 covered).
- [ ] Existing five `sdlc_*` tools unchanged in behavior; shared invocation
      path with the adapter.

---

## P7 — Evaluation suite

**Objective.** Measured quality before the pilot; calibration earned, not
asserted.

**PR 7.1 — `feat(evaluation): multi-agent role + mission cases`**

- `src/evaluation/multi-agent/` per SPEC §15 and `TEST-STRATEGY.md` §4–§6:
  seeded fixture repos with known ground truth; scripted role runs;
  labeled-outcome records; held-out split (hash-based, evolution-plane
  pattern).
- Metrics wiring: evidence coverage, observation accuracy, abstention
  correctness, DAG-validity rate, delegation accuracy, recovery rate, budget
  adherence, false-success counter; `nexum eval` integration; telemetry
  counters (`mission_*`).

**PR 7.2 — `test(evaluation): gates + calibration pipeline`**

- Promotion gates from SPEC §15 as eval CLI exit criteria (report-only for
  calibration until ≥ 100 labeled outcomes).
- CI job (nightly, matching the repo's nightly workflow pattern) running the
  deterministic subset; docker-gated cases behind `NEXUM_DOCKER_TESTS`.

**Acceptance criteria**

- [ ] Deterministic suite green in CI without network and without models.
- [ ] A labeled-outcome dataset exists with the schema + retention rules
      (SPEC §6 rule 3); calibration report runnable.
- [ ] False-success counter exists and is wired into the pilot dashboard
      criteria (P8 exit).

---

## P8 — Supervised production pilot

**Objective.** Run real missions, supervised, and graduate autonomy only on
evidence.

**PR 8.1 — `feat(mission): supervised pilot defaults + ops surface`**

- `supervised` as the shipped default; `controlled-autonomous` behind
  `NEXUM_MISSION_AUTONOMY=controlled` + config; `research` profile
  worktree-bound.
- Ops: `OPS-RUNBOOK.md` surfaces (mission status/audit/metrics), alerting
  thresholds, incident playbook hooks.

**Pilot execution (not a PR — an operating period)**

- ≥ 20 supervised missions across at least three classes (bug investigation,
  test-flake diagnosis, bounded refactor) on `shubhamtaywade82/nexum` itself
  (dogfood) with the Kit workflow bound on at least half.
- Weekly review cadence: verified completion rate, false successes (must be
  0), cost per mission, escalation quality, permission-escalation findings
  (must be 0).
- Graduation criteria for any operation class to `controlled-autonomous`
  (SPEC §9): ≥ 20 missions of that class, verified completion ≥ 90%,
  false-success 0, escalation findings 0.

**Acceptance criteria**

- [ ] Pilot report published (mission metrics from the P7 pipeline) with a
      go/no-go recommendation for expanding autonomy.
- [ ] Zero successful permission escalations across the pilot.
- [ ] All invariants still green in production telemetry.
- [ ] ADR-0001 status updated (Proposed → Accepted) with pilot evidence
      linked.

---

## Issue tracking

This roadmap is tracked in-repo as one epic with linked sub-issues:

| Phase | Issue |
| --- | --- |
| Epic | [#77 — Multi-Agent Coordination v1: Tracker / Predictor / Commander](https://github.com/shubhamtaywade82/nexum/issues/77) |
| P0 | [#78 — Architecture ADR, spec landing, invariants skeleton](https://github.com/shubhamtaywade82/nexum/issues/78) |
| P1 | [#79 — Three role descriptors registered in AgentRegistry](https://github.com/shubhamtaywade82/nexum/issues/79) |
| P2 | [#80 — Event and artifact contracts with schema validation and provenance](https://github.com/shubhamtaywade82/nexum/issues/80) |
| P3 | [#81 — Tracker agent (grounded observation, read-only enforcement)](https://github.com/shubhamtaywade82/nexum/issues/81) |
| P4 | [#82 — Predictor agent (evidence-grounded, abstention)](https://github.com/shubhamtaywade82/nexum/issues/82) |
| P5 | [#83 — Commander agent + MissionCoordinator (lifecycle, budgets, audit CLI)](https://github.com/shubhamtaywade82/nexum/issues/83) |
| P6 | [#84 — Agentic SDLC Kit adapter (TDD + verification gates)](https://github.com/shubhamtaywade82/nexum/issues/84) |
| P7 | [#85 — Evaluation suite (reliability, cost, safety, recovery)](https://github.com/shubhamtaywade82/nexum/issues/85) |
| P8 | [#86 — Supervised production pilot](https://github.com/shubhamtaywade82/nexum/issues/86) |

Each phase issue is linked as a sub-issue of the epic, so acceptance criteria
and completion roll up on #77 automatically.
