# Nexum Evolution Task Catalogue

This is the human-readable view of the catalogue. The machine-readable source
of truth is [`../../config/evolution/task-catalog.yml`](../../config/evolution/task-catalog.yml).
This document is regenerated when the YAML changes; do not edit it directly.

The catalogue currently defines **50 tasks** across **8 engineering domains**.
Tasks are grouped by priority: **P0** tasks must be evaluated first because
they improve Nexum's ability to learn and self-verify; **P1** tasks improve
real engineering capability and memory; **P2** tasks are platform and
post-free-Beam optimizations.

---

## P0 — Core learning and self-evolution (`learning`)

These should be the first tasks because they improve Nexum's ability to learn
and improve itself.

| ID      | Task                           | What Nexum should investigate and improve                                                        |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| EVO-001 | Episode Capture Reliability    | Verify every completed task produces a correctly structured, persisted episode.                  |
| EVO-002 | Automatic Experience Ingestion | Ensure completed episodes automatically reach the cross-session experience store.                |
| EVO-003 | Success Pattern Discovery      | Identify recurring patterns in successful tasks and convert them into improvement opportunities. |
| EVO-004 | Failure Pattern Discovery      | Identify recurring failures, root causes and preventable execution mistakes.                     |
| EVO-005 | Cross-Session Learning         | Verify that knowledge from previous sessions improves subsequent task execution.                 |
| EVO-006 | Lesson Quality Evaluation      | Evaluate lesson usefulness, duplication, confidence and retrieval relevance.                     |
| EVO-007 | Skill Generation and Promotion | Improve how reusable skills are identified, generated, validated and promoted.                   |
| EVO-008 | Improvement Target Generation  | Generate measurable improvement targets from accumulated evidence.                               |
| EVO-009 | Evolution Cycle Automation     | Implement a complete autonomous evolution cycle, from evidence collection through evaluation.    |
| EVO-010 | Evolution Persistence          | Ensure experiments, hypotheses, decisions and results survive restarts.                          |

Expected result: Nexum should become better at recognizing what it does well,
what it does badly and what it should improve next.

---

## P0 — Evolution safety and verification (`evolution_safety`)

Self-modification without reliable evaluation is dangerous. These tasks
protect the entire evolution process.

| ID      | Task                        | What Nexum should investigate and improve                                          |
| ------- | --------------------------- | ---------------------------------------------------------------------------------- |
| EVO-011 | Mutation Isolation          | Ensure every candidate is developed in an isolated worktree or branch.             |
| EVO-012 | Verification Pipeline       | Validate formatting, linting, types, tests and integration requirements.           |
| EVO-013 | Baseline Comparison         | Compare candidate performance with the parent version using identical workloads.   |
| EVO-014 | Held-Out Evaluation         | Ensure improvements generalize beyond the tasks used to produce the changes.       |
| EVO-015 | Regression Detection        | Detect performance, correctness and reliability regressions.                       |
| EVO-016 | Experiment Lifecycle        | Validate hypothesis creation, execution, evaluation, rejection and acceptance.     |
| EVO-017 | Runtime Activation          | Verify only accepted candidates can become active runtime versions.                |
| EVO-018 | Automatic Rollback          | Detect hard regressions and restore the previous stable harness.                   |
| EVO-019 | Evolution Permission Policy | Enforce restrictions on files, commands, dependencies and sensitive configuration. |
| EVO-020 | Evolution Audit Trail       | Make every decision, mutation, evaluation and activation reproducible.             |

Expected result: Nexum can improve itself without blindly trusting its own
proposed changes.

---

## P1 — Agent execution and reasoning (`agent_execution`)

These tasks improve Nexum's ability to perform actual engineering work.

| ID      | Task                       | What Nexum should investigate and improve                                                           |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| EVO-021 | Planning Quality           | Improve task decomposition, dependencies and execution planning.                                    |
| EVO-022 | Tool Selection             | Improve selection of the right tools for each task.                                                 |
| EVO-023 | Tool Execution Reliability | Improve argument validation, error handling, timeouts and retries.                                  |
| EVO-024 | Execution Recovery         | Recover intelligently from failed commands, interrupted sessions and partial work.                  |
| EVO-025 | Context Management         | Improve context selection, compaction and long-running task continuity.                             |
| EVO-026 | Subagent Coordination      | Improve delegation, parallel execution and result aggregation.                                      |
| EVO-027 | MCP Integration            | Improve MCP discovery, tool compatibility and invocation reliability.                               |
| EVO-028 | Long-Running Tasks         | Improve execution persistence, checkpoints, cancellation and resumption.                            |
| EVO-029 | Self-Verification          | Ensure the agent independently verifies the result rather than trusting its own completion message. |
| EVO-030 | Multi-Step Task Completion | Improve execution of complex tasks involving multiple tools and dependent steps.                    |

---

## P1 — Memory, intelligence and knowledge management (`memory_knowledge`)

| ID      | Task                     | What Nexum should investigate and improve                                     |
| ------- | ------------------------ | ----------------------------------------------------------------------------- |
| EVO-031 | Memory Architecture      | Evaluate short-term, session and long-term memory separation.                 |
| EVO-032 | Knowledge Retrieval      | Improve retrieval relevance and reduce irrelevant context.                    |
| EVO-033 | Knowledge Consolidation  | Identify duplicate, contradictory and outdated knowledge.                     |
| EVO-034 | Confidence and Evidence  | Ensure learned knowledge has provenance and confidence levels.                |
| EVO-035 | Knowledge Generalization | Determine whether lessons from one task class transfer to other task classes. |
| EVO-036 | Skill Effectiveness      | Measure whether promoted skills actually improve execution outcomes.          |

---

## P2 — Model intelligence and cost optimization (`model_intelligence`)

This is especially important after the free Beam access ends.

| ID      | Task                                   | What Nexum should investigate and improve                                               |
| ------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| EVO-037 | Model Capability Benchmark             | Compare models on identical planning, coding and tool-use tasks.                        |
| EVO-038 | Intelligent Model Routing              | Select models based on task complexity and required capabilities.                       |
| EVO-039 | Model Fallback                         | Recover from provider failures and unavailable models.                                  |
| EVO-040 | Token Optimization                     | Reduce unnecessary context and output tokens without reducing correctness.              |
| EVO-041 | Model Reliability                      | Detect inconsistent outputs, tool-call failures and reasoning-related execution errors. |
| EVO-042 | Local and Cloud Model Interoperability | Ensure tasks can move between local Ollama and cloud providers.                         |

---

## P2 — Platform and operational capabilities (`platform_operations`)

| ID      | Task                                   | What Nexum should investigate and improve                                                  |
| ------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| EVO-043 | CLI/TUI Reliability                    | Improve command usability, state reporting and error diagnostics.                          |
| EVO-044 | Server Architecture                    | Improve server lifecycle, API consistency and service isolation.                           |
| EVO-045 | Job and Scheduler Reliability          | Improve scheduling, distributed execution and worker recovery.                             |
| EVO-046 | Observability                          | Improve structured logs, metrics, traces and execution histories.                          |
| EVO-047 | Security Audit                         | Examine prompt injection, tool permissions, secret exposure and trust boundaries.          |
| EVO-048 | Dependency Health                      | Identify vulnerable, unnecessary or outdated dependencies.                                 |
| EVO-049 | Performance Optimization               | Identify bottlenecks in execution, storage and orchestration.                              |
| EVO-050 | Documentation and Developer Experience | Keep APIs, architecture documentation and implementation guides aligned with the codebase. |

---

## Recommended starting batch

Don't run all 50 tasks simultaneously. Start with these 10:

- EVO-001 — Episode Capture Reliability
- EVO-002 — Automatic Experience Ingestion
- EVO-003 — Success Pattern Discovery
- EVO-004 — Failure Pattern Discovery
- EVO-005 — Cross-Session Learning
- EVO-008 — Improvement Target Generation
- EVO-009 — Evolution Cycle Automation
- EVO-012 — Verification Pipeline
- EVO-014 — Held-Out Evaluation
- EVO-018 — Automatic Rollback

These cover the entire loop end-to-end (capture → ingest → diagnose → target
→ automate → verify → generalize → recover) and produce evidence that makes
every subsequent task cheaper to evaluate.

## How to add a new task

1. Append a new entry to `config/evolution/task-catalog.yml` with the next
   available `EVO-NNN` id.
2. Fill in `objective`, `execution` (mode + autonomous + allow_code_changes),
   `inputs`, `investigation`, `acceptance`, `report.required`, and the manual
   scoring fields (`impact`, `potential`, `feasibility`, `depends_on`).
3. Run `nexum evolve --task-validate` to confirm the new task passes schema
   validation.
4. Update `docs/evolution/task-catalog.md` to mirror the new entry (or
   regenerate the table).
5. Open a PR. Catalogue changes are reviewed separately from candidate
   implementations.

## Repository-specific caveat

The catalogue is a **proposed input contract**. The autonomous task
orchestration that consumes it (registry loader, mode-aware runner, backlog
tracker) is implemented in this PR; the existing `--autonomous` flag in
`src/evolution/cli.ts` is wired to the new `TaskRunner` as of this change, but
full end-to-end autonomous execution still depends on the closed-loop engine
v2 (`ClosedLoopEngine`) being able to drive the runner, which is itself under
active development. See `docs/HARNESS_EVOLUTION.md` for the current state of
the closed loop.
