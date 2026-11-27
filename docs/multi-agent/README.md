# Nexum Multi-Agent Coordination v1 — Specification Pack

Implementation-ready engineering documentation for the three-agent autonomous
coordination layer (**Tracker / Predictor / Commander**) inside
[Nexum](https://github.com/shubhamtaywade82/nexum), targeting the control plane
that already exists in `src/orchestration`, `src/runtime` and `src/tools`.

> **Verified baseline.** Every architectural claim in this pack was checked
> against the live repository at pinned revision
> `3d2c1d02ce7e2c206db3e7888c2753cf0c52e6ef` (merge of PR #74, 2026-11-22,
> `main`). Discrepancies and additional findings are recorded in
> `SPEC.md` Appendix A. Nothing in this pack assumes a component that was not
> confirmed to exist.

## Contents

| File | Suggested commit location | Purpose |
| --- | --- | --- |
| `ADR-0001-multi-agent-coordination-layer.md` | `docs/adr/ADR-0001-multi-agent-coordination-layer.md` | Architecture decision record: decision, rejected alternatives, invariants |
| `SPEC.md` | `docs/multi-agent/SPEC.md` | The exhaustive engineering specification (roles, contracts, events, lifecycle, capability model, autonomy profiles, SDLC Kit adapter, coordinator design) |
| `ROADMAP.md` | `docs/multi-agent/ROADMAP.md` | Phased P0–P8 implementation plan with PR-level breakdown and acceptance criteria |
| `TEST-STRATEGY.md` | `docs/multi-agent/TEST-STRATEGY.md` | Test matrix, invariant tests, security tests, evaluation gates and calibration dataset design |
| `THREAT-MODEL.md` | `docs/multi-agent/THREAT-MODEL.md` | Threat model aligned with the repo's `SECURITY.md` trust model |
| `RISK-REGISTER.md` | `docs/multi-agent/RISK-REGISTER.md` | Delivery and runtime risk register with mitigations |
| `OPS-RUNBOOK.md` | `docs/multi-agent/OPS-RUNBOOK.md` | Operating the mission layer: monitoring, resume, incidents, audit export |

## Headline decisions (full detail in ADR-0001 and SPEC.md)

1. **Three registered, capability-scoped agent roles** — `tracker`,
   `predictor`, `commander` — as `AgentDescriptor` registrations in the
   existing `AgentRegistry` (`src/runtime/agent/agent-runtime.ts`), not a new
   runtime.
2. **Reuse the existing control plane for everything heavy** — `Planner`,
   `TaskGraph`, `Scheduler`, `Executor`, `Delegator`, `LoopDetector` (all in
   `src/orchestration`), `ToolGateway`, `PolicyEngine`, `ApprovalManager`,
   budgets, checkpoints and artifacts.
3. **Event- and artifact-based communication** — typed, evidence-carrying
   events over the existing `EventEnvelope` / `EventSink`; immutable reports
   as artifacts. No message bus, no shared mutable state, no consensus.
4. **Commander proposes, the deterministic control plane authorizes.** A
   model-generated decision is never an authorization; every decision is
   re-validated against policy, budget and DAG validity before execution.
5. **Agentic SDLC Kit remains the workflow authority** through an explicit,
   allowlisted adapter (extending the existing bridge in
   `src/tools/sdlc-tools.ts`). TDD phase transitions stay deterministic;
   an LLM can never declare GREEN or VERIFIED.
6. **Supervised autonomy by default**, controlled-autonomous and research
   profiles behind explicit configuration.
7. **A complexity gate activates the trio only when justified**
   (`assessComplexity` in `src/orchestration/complexity.ts`) — a typo fix
   never spawns three agents.

## Verification summary

Confirmed against the live repo (see `SPEC.md` Appendix A for the full
claims-vs-evidence table):

- `@nemesis-oss/nexum` `package.json` declares **2.0.0** while `CHANGELOG.md`
  carries an **Unreleased** section — implementation must pin source
  revisions, not the published package.
- The unused `src/multiagent` subsystem (message bus, shared state, consensus,
  supervisor loop) **was removed**; the changelog records the restore command
  (`git checkout 01b42ab -- src/multiagent tests/multiagent`). This pack does
  not reintroduce it.
- `AgentRegistry.selectFor(required: string[]): AgentDescriptor[]`,
  `Delegator.review()/delegate()/observe()`, `DelegationPolicy`
  (`maxConcurrentChildren` default 2, `maxTotalChildren` default 8,
  `inheritPolicy` narrow-only), `BudgetManager.deriveChild()` and
  `EventEnvelope` (`src/core/events/envelope.ts`) all exist with the
  semantics this pack builds on.
- `SECURITY.md` documents the residual limitations (Docker daemon
  root-equivalence, `gh` token scope, no formal audit). The threat model
  inherits, not weakens, that posture.
- **Additional findings** beyond the original proposal: Nexum already ships an
  SDLC Kit bridge (`src/tools/sdlc-tools.ts`: `sdlc_inspect`,
  `sdlc_validate_spec`, `sdlc_validate_plan`, `sdlc_verify`, `sdlc_doctor`,
  `resolveKitCliPath()`, `executeKitCommand()`), an existing `MissionState`
  phase model (`src/runtime/mission-derive.ts`) and a deterministic
  complexity gate (`src/orchestration/complexity.ts`). The design builds on
  these instead of duplicating them.

## Tracking

The phased work is tracked in the `shubhamtaywade82/nexum` repository as one
epic issue with one linked sub-issue per phase (P0–P8):
[#77](https://github.com/shubhamtaywade82/nexum/issues/77) is the epic;
[#78](https://github.com/shubhamtaywade82/nexum/issues/78) through
[#86](https://github.com/shubhamtaywade82/nexum/issues/86) are the phase
sub-issues, in roadmap order. The full table of links lives in `ROADMAP.md`
("Issue tracking").
