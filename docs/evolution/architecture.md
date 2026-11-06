# Evolution Task Catalogue — Architecture

This document describes the architecture of the **Evolution Task Catalogue**: a
permanent, registry-driven backlog of engineering improvement objectives that
the autonomous evolution system evaluates against the Nexum repository.

The catalogue exists to give Nexum a **defined set of improvement objectives**
instead of asking it vague questions such as _"How can you improve yourself?"_.
Every objective is a discrete task with an ID, an investigation plan, an
acceptance contract, and a reporting contract.

## Goals

1. **Replace open-ended self-improvement prompts with concrete, enumerable tasks.**
2. **Make improvement decisions auditable.** Every report, experiment, and
   activation can be traced back to a task in the catalogue.
3. **Decouple the catalogue from the engine.** Adding or revising an
   improvement objective is a YAML edit, not an engine change.
4. **Keep the backlog permanent.** The catalogue is a first-class part of the
   repository; it is reviewed, versioned, and cited by the evolution engine
   across model generations.

## Non-goals

- The catalogue does **not** grant write access to the source tree by itself.
  Code changes only happen through the existing mutation executor
  (`GitWorktreeMutationExecutor`) and only for tasks in `implement` mode that
  have passed all applicable acceptance gates.
- The catalogue does **not** replace the closed-loop engine
  (`ClosedLoopEngine`). It feeds it. Diagnosis episodes, experiments, and
  delivery records continue to flow through the v2 closed-loop lifecycle.
- The catalogue does **not** auto-promote. Acceptance is gated by the
  two-stage selector, held-out evaluation, CI, and human review exactly as in
  the existing evolution pipeline.

## Component map

```
                ┌────────────────────────────────────────────┐
                │  config/evolution/*.yml                    │
                │   task-catalog.yml  policies.yml           │
                │   evaluation.yml    schedules.yml          │
                └─────────────────────┬──────────────────────┘
                                      │ load
                                      ▼
            ┌─────────────────────────────────────────────┐
            │  TaskLoader  (YAML → zod-validated tasks)    │
            └─────────────────────┬───────────────────────┘
                                  │
                                  ▼
            ┌─────────────────────────────────────────────┐
            │  TaskRegistry                                │
            │   • byId, byCategory, byPriority             │
            │   • dependency graph                          │
            └─────────────────────┬───────────────────────┘
                                  │
                ┌─────────────────┼──────────────────┐
                ▼                 ▼                  ▼
        TaskPrioritizer    BacklogTracker      TaskRunner
        (weighted rank)    (state machine)    (3 modes)
                                                    │
                          ┌─────────────────────────┼─────────────┐
                          ▼                         ▼             ▼
                    diagnose                  experiment       implement
                    (read-only)            (isolated worktree) (branch)
                          │                         │             │
                          ▼                         ▼             ▼
                  ReportGenerator            evidence →    GitWorktreeMutation
                  (standard report)          candidate       Executor
                          │                         │             │
                          ▼                         ▼             ▼
                  ReportStore              TwoStageSelector    acceptance
                  (SQLite, immutable)      + held-out gate     gates
                          │                         │             │
                          └────────────┬────────────┴─────────────┘
                                       ▼
                              EvolutionDecision
                              accept / reject / defer / investigate
```

## Data flow

1. **Load.** `TaskLoader` reads `config/evolution/*.yml` and validates every
   task definition against a zod schema. Invalid tasks are reported and
   skipped; the engine never sees them.
2. **Register.** `TaskRegistry` indexes tasks by id, category, priority, and
   dependency. The registry is read-only after load.
3. **Prioritize.** `TaskPrioritizer` ranks tasks using the weighted factors
   from `policies.yml` and the current evidence window. A task may be deferred
   if its evidence confidence is below threshold even if its impact is high.
4. **Dispatch.** `TaskRunner` picks the next eligible task and executes it in
   the mode declared by the task (`diagnose`, `experiment`, or `implement`).
   Mode determines permissions, not the task itself.
5. **Report.** Every task run produces a `Report` following the standard
   contract from `evaluation.yml`. Reports are immutable and stored in
   `report-store.db`.
6. **Decide.** The standard evolution decision flow
   (`accept` / `reject` / `defer` / `investigate-further`) consumes the report
   plus any experiment evidence. Decisions are recorded against the backlog
   entry so the same hypothesis is never re-opened without new evidence.
7. **Backlog.** `BacklogTracker` updates task state
   (`pending` / `investigated` / `in_progress` / `completed` /
   `rejected_deferred`), tracks the last evaluated commit, the report id, the
   related experiment id, the evidence window, and the next-evaluation
   condition.

## Three execution modes

| Mode         | Purpose                                        | Permissions              |
| ------------ | ---------------------------------------------- | ------------------------ |
| `diagnose`   | Inspect and generate an improvement report     | Read-only                |
| `experiment` | Test hypotheses or alternative implementations | Isolated workspace       |
| `implement`  | Implement an approved improvement              | Isolated branch/worktree |

Mode is declared per task in the catalogue, not chosen at runtime by the
agent. This prevents an agent from escalating a `diagnose` task into a code
change.

## Relationship to the existing v2 closed-loop engine

The catalogue does **not** replace `ClosedLoopEngine`. It supplies it with
named, structured objectives:

- The closed-loop engine's `observe → diagnose → target → mutate → evaluate
→ deliver` flow continues to run.
- When a catalogue task is in `experiment` or `implement` mode, `TaskRunner`
  delegates the mutation step to `AgentMutationStrategy` via
  `GitWorktreeMutationExecutor`, exactly as `evolve --mutate --strategy agent`
  does today.
- When a catalogue task is in `diagnose` mode, `TaskRunner` calls
  `HarnessDiagnoser` and `ExperienceStore` directly without entering the
  mutation executor.
- Reports and decisions flow into the existing `ExperimentStore` and
  `EvolutionMetricsTracker`; the catalogue adds the _task_ dimension on top.

## Storage

Three SQLite databases are used (all under the workspace state directory,
`<workspace>/.nexum/state/` by default):

| Database            | Owner             | Purpose                                            |
| ------------------- | ----------------- | -------------------------------------------------- |
| `lessons.db`        | existing          | Episodes, lessons, skills                          |
| `experience.db`     | existing          | Cross-session experience records                   |
| `experiments.db`    | existing          | Experiment provenance, lifecycle, CI, review state |
| `evolution.db`      | existing          | Harness versions, lineage, rollback                |
| `task-catalogue.db` | **new (this PR)** | Backlog state, reports, task↔experiment links      |

`task-catalogue.db` is created lazily on first catalogue use; it does not
affect existing databases.

## Failure modes the catalogue must protect against

These are codified in `policies.yml` as hard anti-rules and enforced by
`TaskValidator` and `TaskRunner`:

1. **Inventing changes to appear productive.** A report must be allowed to
   conclude `no-change`. The `Recommendation` enum includes `no_change` as a
   first-class outcome.
2. **Re-running the same diagnosis without new evidence.** `BacklogTracker`
   refuses to re-run a `diagnose` task unless the evidence window has advanced
   or the repository HEAD has moved past the `last_evaluated_commit`.
3. **Counting duplicate episodes as independent evidence.** `ReportGenerator`
   hashes episode ids and de-duplicates before computing `independentSamples`.
4. **Counting "tests pass" as success.** Acceptance requires the two-stage
   selector (capability ≥ 3% **or** reliability ≥ 4%, with held-out
   generalization reported separately), not a green CI run alone.
5. **Self-evaluation.** The implementation agent is never the evaluator. The
   evaluator is the existing `FixedExecutor` + `TwoStageSelector` pair, which
   run on a different code path from the proposing agent.
6. **Bypassing activation gates.** No catalogue task can activate a runtime
   candidate directly. Activation still flows through
   `ManifestRuntimeActivationController` after CI passes and review approves.

## Versioning

The catalogue is versioned in two places:

- `config/evolution/task-catalog.yml` carries a top-level `version: 1`.
- Each task carries an optional `schema_version` (default 1). Bumping it
  invalidates older reports referencing the same task id; this prevents
  stale reports from being cited as evidence for a redefined task.

## See also

- [`evolution-policy.md`](./evolution-policy.md) — policies, ranking weights,
  anti-rules, mode permissions.
- [`task-catalog.md`](./task-catalog.md) — the catalogue itself, in a
  human-readable format.
- [`../HARNESS_EVOLUTION.md`](../HARNESS_EVOLUTION.md) — the existing v2
  closed-loop documentation that this catalogue builds on.
