# Nexum Multi-Agent Coordination v1 — Risk Register

Companion to `docs/multi-agent/SPEC.md` and `ROADMAP.md`. Likelihood and
impact: H/M/L. "Trigger" is the observable signal that the risk is material.

| ID | Risk | L | I | Mitigation | Owner phase | Trigger / early signal |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Commander self-authorization: a decision text treated as authority by some future code path | M | H | `reValidateDecision` is the only entry to execution; INV-4 test; code-review rule: no consumer of `CommanderDecision` may execute directly | P5 | any PR that reads `CommanderDecision` outside the coordinator |
| R-02 | Budget bypass via uncounted paths (e.g. adapter CLI time not counted against wall clock) | M | M | budget envelope counts all mission-scoped work incl. adapter invocations; INV-1 includes adapter durations | P5/P6 | missions with wall-clock consumption unaccounted in the report |
| R-03 | Infinite replan/ping-pong loop (tracker → predictor → commander cycling) | M | M | replan caps, decision-failure budget, `LoopDetector` on identical decisions/DAG hashes (INV-2/3) | P5 | repeated identical decisions in `mission audit` output |
| R-04 | Evidence fabrication by a role (plausible refs) | L | H | refs must resolve against real stores; collectors deterministic and re-runnable; audit replay cross-checks; T3 threat + tests | P2/P3 | audit reconstruction mismatches |
| R-05 | Calibration theater: LLM confidence numbers leaking in as `probability` | M | M | schema + service rule: probability requires `basis: statistical` + calibration ref; INV-9; report-only until ≥ 100 labeled outcomes | P4 | any `probability` field with no calibration ref |
| R-06 | Duplication creep: a second Kit integration path (adapter vs existing `sdlc-tools.ts`) drifting apart | M | M | P6 de-duplication review requires one shared invocation path; layering test forbids a third | P6 | divergent argv construction in tests |
| R-07 | `Delegator.matchByCapability` first-match nondeterminism selecting the wrong worker as more agents register | M | M | coordinator pins `childAgentId` from its own deterministic resolution (or documented registration order); delegation-accuracy eval metric ≥ 90% | P1/P5 | delegation-accuracy drop in eval suite |
| R-08 | Spec/implementation drift after baseline pin moves (main evolves during P0–P8) | M | M | re-verify SPEC Appendix A claims per phase; pin each phase PR to a re-confirmed baseline; note in PR template | all | CI failures referencing moved symbols |
| R-09 | Role prompt-injection wasting mission budget (garbage in reports) | M | L | budget envelope caps damage; evidence resolution rejects junk; injection recorded as untrusted content | P3/P4 | high decision-rejection counts per mission |
| R-10 | Event/artifact store bloat (fine-grained observations × long missions) | M | L | report size caps in schema; retention follows existing artifact rules; `staleAfter` prevents redundant re-observation | P2/P3 | `.nexum` growth alarms in ops metrics |
| R-11 | Approval fatigue in supervised pilot (rubber-stamping) | M | M | approval requests carry full context + rollback statement; escalation quality is a pilot metric; timeout fails closed | P8 | approval latency trending to zero |
| R-12 | TUI/CLI surface regressions from new mission events (event flood) | L | M | event router batches/coalesces to the TUI store; phase mapping reuses `MissionState`; existing TUI tests must stay green | P5 | TUI test failures in P5 PRs |
| R-13 | Kit CLI contract drift (`kit next --json` schema changes upstream) | M | M | forwards-compatible parsing (ignore unknown fields, fail on missing required); `sdlc_doctor` gate at mission start; Kit pinned commit in adapter tests | P6 | adapter tests failing on Kit upgrade |
| R-14 | "Unused subsystem" repeat: mission layer ships but nothing invokes it (the `src/multiagent` failure mode) | M | H | P8 pilot makes the invocation real from day one (dogfood on this repo); ROADMAP acceptance ties every phase to a live consumer; audit CLI is a user-facing consumer | P8 | zero missions run in a pilot week |
| R-15 | Test flakiness from time-dependent invariants (wall-clock budgets) | M | L | wall-clock assertions use injected clocks (no real sleeps); budget math unit-tested with synthetic consumption | P5 | intermittent CI failures in mission tests |
