# Nexum Multi-Agent Coordination v1 — Ops Runbook

Operating guide for the mission layer (`docs/multi-agent/SPEC.md`). Audience:
the human supervising supervised/controlled-autonomous missions on a
Nexum-managed workspace.

## 1. Enabling and configuring

| Setting | Default | Notes |
| --- | --- | --- |
| Autonomy profile | `supervised` | `NEXUM_MISSION_AUTONOMY=controlled` or config for controlled-autonomous; `research` requires worktree isolation |
| `autoApprove` | off | unchanged from the host; keep off for missions; headless approval-less sessions fail closed |
| Kit path | auto-detected | `NEXUM_SDLC_KIT_PATH` overrides; `NEXUM_SDLC_KIT_DISABLED=true` disables (Kit-bound missions then abort, never proceed ungated) |
| Budgets | 30 min / 400 model calls / 1500 tool calls / 2M tokens / 8 children | override per mission via mission policy config, never above the envelope caps |
| Token budget | `NEXUM_TOKEN_BUDGET` | global ceiling still applies |

## 2. Daily operation

- Start: `nexum mission start "<goal>"` (or `--kit-fix FIX-101` to bind the
  Kit workflow). The complexity gate decides trio vs single-agent.
- Watch: `nexum mission status <id>` — state, phase (mapped to the existing
  mission phase labels), budget consumption, blockers.
- Live view: the TUI mission view (phases, decisions, delegations,
  verification verdicts).
- Approvals arrive with context digest, proposed action, evidence refs, risk
  class, and a rollback statement. Approve only what you have read.
- Cancel: `nexum mission cancel <id> --reason "..."` — reaches in-flight
  children; terminal states are never rewritten.

## 3. Health signals and what to do

| Signal | Meaning | Action |
| --- | --- | --- |
| Mission `degraded` | Tracker reported failing collectors | Check blockers in status; usually environment (Kit missing, permissions, CI unreachable) |
| Mission `blocked` | Blockers with no recovery path | Read the blocker's `suggestedUnblock`; abort if environmental |
| `awaiting_approval` long | Approval pending | Approve or let the 24 h timeout abort it — do not leave pending overnight |
| High `commander.decision.rejected` count | Commander flailing (or injection noise) | Inspect rejections in audit; if patterned/identical, loop detection will terminate; investigate role inputs |
| `mission_failed(budget_exhausted)` | Budget hit | Read the itemized consumption; if legitimate, re-submit with a scoped goal, not a bigger budget |
| `mission_false_success` > 0 | **Stop-the-line** | Freeze autonomy expansion; incident review (this is the north-star safety metric) |

## 4. Resume and recovery

- `nexum mission resume <id>` resumes from the last checkpoint:
  re-observation first; in-flight delegations of the previous incarnation are
  marked `orphaned` and are **not** re-run (idempotency keys protect double
  side effects); completed verified nodes are never re-executed.
- After a host crash: same procedure — checkpoints are written on every
  transition; the audit command validates checkpoint↔event-store agreement
  before resuming.
- After a Kit journal-verify failure: the mission is already aborted; treat
  as an integrity incident (THREAT-MODEL T8) — do not resume; export the
  audit and review manually.

## 5. Auditing and exporting

- `nexum mission audit <id>` — full deterministic reconstruction: every
  transition, decision + re-validation verdict, delegation, verification
  result, budget consumption, final report. Zero LLM calls; diffable.
- Export: audit output is plain text/JSON on stdout; artifacts are in the
  artifact store with `missionId` keys.
- Metrics: `GET /metrics` exposes `mission_active`,
  `mission_verified_completions`, `mission_false_success`, per-role token /
  model-call counters (P7).

## 6. Incident playbook (runaway or suspicious mission)

1. `nexum mission cancel <id> --reason "incident"` — cancellation reaches
   model calls, tools, shell containers and children.
2. `nexum mission audit <id>` — review decisions and rejections; check for
   injection patterns in evidence (THREAT-MODEL T1/T3).
3. If any approval-class action executed without a corresponding approval
   record: security incident — follow `SECURITY.md` §13 (do not open a public
   issue; email the maintainer).
4. If false success is suspected: re-run the verification gates on the
   affected task scope; the Kit journal (`kit journal <ID> --verify`) is the
   tamper-evident record for Kit-bound missions.
5. Freeze autonomy expansion for the affected mission class until the
   incident review closes (P8 graduation criteria include zero findings).

## 7. Pilot review checklist (P8, weekly)

- [ ] Missions run this week (by class); verified completion rate
- [ ] False successes: must be 0 (else stop-the-line)
- [ ] Successful permission escalations: must be 0
- [ ] Budget breaches: count + causes
- [ ] Decision rejection rate; loop-detection terminations
- [ ] Approval latency (fatigue indicator) and approval outcomes
- [ ] Cost per mission (tokens, model calls) vs. single-agent baseline
- [ ] Autonomy graduation recommendations with evidence (SPEC §9 thresholds)
