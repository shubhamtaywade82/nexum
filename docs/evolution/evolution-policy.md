# Evolution Policy

This document is the normative reference for **how** the autonomous evolution
system evaluates tasks from the [task catalogue](./task-catalog.md). It is the
human-readable twin of `config/evolution/policies.yml` and
`config/evolution/evaluation.yml`: when the two disagree, the YAML is the
source of truth that the code enforces, and a PR that changes the YAML must
also update this document.

## 1. Execution modes

Every catalogue task declares one of three modes. Mode determines what the
runner is allowed to do — it is **not** chosen by the agent at runtime.

| Mode         | Purpose                                        | Permissions                                       | May activate runtime?                  |
| ------------ | ---------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| `diagnose`   | Inspect and generate an improvement report     | Read-only (no writes, no network)                 | No                                     |
| `experiment` | Test hypotheses or alternative implementations | Isolated worktree, no push, no activation         | No                                     |
| `implement`  | Implement an approved improvement              | Isolated branch/worktree, may push via `--github` | Only via the existing acceptance gates |

Hard rules:

- A `diagnose` task may **never** call `GitWorktreeMutationExecutor`. The
  runner refuses to mount the executor for read-only tasks.
- An `experiment` task may **never** push to `origin` or update
  `nexum.harness.json`'s `activeHarness` pointer.
- An `implement` task may **never** bypass the two-stage selector, held-out
  gate, CI check, or human review. Activation still flows through
  `ManifestRuntimeActivationController`.

## 2. Acceptance gates

A candidate produced by an `implement` task is accepted only if **all** of the
following hold:

1. **Stage A — experimental validity.**
   - ≥ 3 candidate runs executed.
   - ≥ 50% verification coverage on the relevant profile.
   - At least one piece of independent, non-duplicate verification evidence.
   - No catastrophic regression > 15% on any must-not-move metric.
2. **Stage B — improvement verification.**
   - Capability gain ≥ 3% **or** reliability gain ≥ 4% (OR, not AND).
   - Token overhead ≤ 25%.
3. **Held-out generalization** (reported separately, never used to choose
   whether to accept — only to invalidate acceptance if it collapses):
   - Held-out score must not drop more than 2% relative to parent.
4. **CI.** Required status checks pass on the mutation branch.
5. **Human review.** Approval recorded in the experiment record.

A green CI run alone is **not** acceptance. A passing test suite alone is
**not** acceptance. The implementation agent's self-report is **not**
acceptance.

## 3. Ranking weights

The prioritizer scores every pending task on six factors. Weights are
normalized to sum to 1.0.

| Factor                             | Weight | Source                                               |
| ---------------------------------- | ------ | ---------------------------------------------------- |
| Impact on overall agent capability | 25%    | Manual `impact` field in the task definition         |
| Frequency of observed problem      | 20%    | `ExperienceStore` failure-mode frequency             |
| Evidence confidence                | 20%    | `evidenceConfidence` from the most recent report     |
| Improvement potential              | 15%    | Manual `potential` field in the task definition      |
| Dependency importance              | 10%    | Number of other tasks that list this as `depends_on` |
| Implementation feasibility         | 10%    | Manual `feasibility` field in the task definition    |

Final rank = weighted sum. Tasks below `min_confidence_to_act` (default 0.4)
are routed to `investigate-further` rather than executed, regardless of rank.

## 4. Anti-rules (hard prohibitions)

These are enforced by `TaskValidator` and `TaskRunner` and cannot be relaxed
by the agent.

1. **Do not regenerate the same report when there is no new evidence or code
   change.** `BacklogTracker` blocks re-diagnosis unless
   `last_evaluated_commit` is older than current HEAD **or** the evidence
   window has advanced past `next_evaluation_condition`.
2. **Do not create multiple experiments for the same hypothesis.** Each
   `(task_id, hypothesis_sha256)` pair maps to at most one experiment.
   Re-formulating the hypothesis text to dodge this check is itself a
   validation error.
3. **Do not count duplicated episodes as independent evidence.** Episode ids
   are de-duplicated before `independentSamples` is computed.
4. **Do not mark an improvement successful just because tests pass.** See
   §2 above.
5. **Do not allow the implementation agent to be the only evaluator.** The
   evaluator is the existing `FixedExecutor` + `TwoStageSelector` pair on a
   separate code path.
6. **Do not activate a candidate without passing the applicable acceptance
   gates.** Activation is a separate state transition (`ELIGIBLE → DELIVERED
→ CI_PENDING → CI_PASSED → REVIEW_PENDING → APPROVED → ACCEPTED → ACTIVE`),
   not a side-effect of `implement` finishing.

## 5. Backlog states

```
pending  ──diagnose──▶  investigated  ──experiment/implement──▶  in_progress
                              │                                       │
                              │                                       │ accept
                              │                                       ▼
                              │                                    completed
                              │
                              └──reject/defer──▶  rejected_deferred
```

Transitions are recorded with: timestamp, triggering commit, report id,
related experiment id, evidence window (`[from, to]`), and
`next_evaluation_condition`. A `rejected_deferred` task is not re-evaluated
until its `next_evaluation_condition` is satisfied (typically: new evidence
class observed, or repository HEAD advances past a recorded commit).

## 6. Report contract

Every task run, regardless of mode, produces a report with the sections listed
in `evaluation.yml`. The minimum required sections are:

- `task_identification` — task id, title, evaluation date.
- `current_implementation` — actual files, classes, methods involved.
- `current_behavior` — what Nexum currently does.
- `identified_gaps` — specific deficiencies backed by evidence.
- `root_cause_analysis` — why the deficiencies exist.
- `improvement_proposals` — concrete implementation options.
- `expected_impact` — measurable expected benefits.
- `risk_assessment` — regression and security risks.
- `implementation_plan` — files/components likely to change.
- `verification_plan` — tests and benchmarks required.
- `recommendation` — `implement` / `defer` / `investigate_further` /
  `no_change`.
- `confidence` — evidence-based confidence in the findings, in `[0, 1]`.

A report that concludes `no_change` is a **successful** report. The system
rewards accurate negative findings: they prevent wasted experiment budget.

## 7. Scheduling

`schedules.yml` declares cadences per category, not per task. The default
cadences are:

| Category              | Default cadence | Reason                                        |
| --------------------- | --------------- | --------------------------------------------- |
| `learning`            | hourly          | Episodes accumulate continuously.             |
| `evolution_safety`    | per-release     | Safety gates must not drift between releases. |
| `agent_execution`     | daily           | Execution signals stabilize over a day.       |
| `memory_knowledge`    | daily           | Memory writes accrue over a day.              |
| `model_intelligence`  | weekly          | Model behavior is stable over days.           |
| `platform_operations` | weekly          | Platform metrics are slow-moving.             |
| `observability`       | weekly          | Same as above.                                |
| `documentation`       | per-release     | Docs must match the released code.            |

Cadence is a **maximum**. A task may be re-evaluated sooner if its trigger
fires (e.g. a new failure class appears in `ExperienceStore`), but never more
often than the cadence.

## 8. Permission policy

`policies.yml` enumerates:

- **Allowed paths** for `implement` mutations. Anything outside this list is
  rejected by the executor before any write.
- **Forbidden paths** that no catalogue task may touch (e.g. the evaluator,
  the held-out split hash function, the acceptance controller itself —
  preventing a candidate from redefining its own grader).
- **Allowed commands** for verification (format, lint, typecheck, test).
- **Forbidden commands** (network egress, package install, anything writing
  outside the worktree).

The forbidden-paths list explicitly includes the catalogue itself: a
catalogue task may not edit `config/evolution/task-catalog.yml` to add a task
that would auto-accept its own changes.

## 9. Changes to this policy

Any change to this document or to `policies.yml` / `evaluation.yml` requires:

- A PR (no direct pushes to `main`).
- An entry in `VALIDATION_LOG.md` recording the rationale and the expected
  effect on the loop health metrics.
- No simultaneous change to the evaluator, the held-out split, or the
  acceptance controller. Those must be separate PRs.

This separation ensures the rules of the game are never changed in the same
commit that scores a candidate under the new rules.
