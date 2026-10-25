# Nexum Harness Evolution: Self-Developing Agent Runtime

Nexum implements a meta-evolutionary control loop inspired by the **HarnessDev** paradigm ($H = \langle E, T, C, S, L, V \rangle$).

While traditional coding agents learn only _task-level_ lessons, Nexum can diagnose its own runtime execution failures, identify architectural weaknesses in its execution harness, formulate targeted mutation hypotheses, benchmark candidate changes against multi-objective Pareto dimensions, and autonomously prepare scientific GitHub Pull Requests with empirical evidence matrices.

---

## 1. The Harness Model: $H = \langle E, T, C, S, L, V \rangle$

Nexum treats the agent harness as a formal six-tuple:

```text
H = ⟨ E, T, C, S, L, V ⟩
    │  │  │  │  │  └── Verification & Safety Guardrails
    │  │  │  │  └───── Lifecycle, Recovery & Error Escalation
    │  │  │  └──────── Centralized State Store & Atomic Checkpointing
    │  │  └─────────── Context Engine, LSP & Rails Code Intelligence
    │  └────────────── Tool Runtime & Dynamic Selector
    └───────────────── Execution Loop, Orchestrator DAG & Loop Detector
```

| Component              | Subsystem                        | Purpose in Nexum                                                              |
| :--------------------- | :------------------------------- | :---------------------------------------------------------------------------- |
| **$E$ — Execution**    | `src/orchestrator/`              | Step decomposition, dependency DAGs, parallel step execution, loop detection. |
| **$T$ — Tools**        | `src/tools/`                     | 35+ tools, dynamic tool schema pruning per turn, sandbox execution.           |
| **$C$ — Context**      | `src/intelligence/`, `src/docs/` | 14-language LSP pool, Rails semantic index, DevDocs FTS5 offline search.      |
| **$S$ — State**        | `src/runtime/`                   | Immutable store, event bus, atomic step checkpoints, session transcripts.     |
| **$L$ — Lifecycle**    | `src/provider/`, `src/cli/`      | Model routing, self-escalation on failure, session resume, retry policies.    |
| **$V$ — Verification** | `src/validation/`, `src/safety/` | Test runners, lint gates, type diagnostics, path traversal containment.       |

---

## 2. The Evolutionary Control Loop

The meta-harness control loop operates as a closed feedback cycle:

```text
Telemetry (Episodes)
       ↓
Failure Diagnoser (Root Cause & Taxonomy)
       ↓
Evolution Planner (Single-Component Scoped Hypothesis)
       ↓
Candidate Mutation & Benchmark Runner
       ↓
Multi-Objective Comparator (Pareto Frontiers & Hard Regression Gates)
       ↓
       ├─ [PROMOTE] → Register in SQLite & Open GitHub Draft PR
       └─ [REJECT]  → Demote candidate & Record rationale
```

### The Single-Component Scoping Principle

To prevent regression cascades, every evolution candidate mutation is strictly confined to **one subsystem** at a time ($E$, $T$, $C$, $S$, $L$, or $V$). Multi-component mutations are blocked by the `EvolutionPlanner`.

### Multi-Objective Pareto Dimensions & Regression Gates

Candidate versions are evaluated across four objective dimensions:

1. **Capability**: Task success rate and verification pass rate.
2. **Reliability**: Tool error reduction, elimination of false successes, loop abort rate.
3. **Efficiency**: Token overhead and execution latency (capped at $\le 25\%$ token overhead).
4. **Generalization**: Performance on held-out tasks and cross-model transferability.

**Hard Regression Gates**: Any candidate that degrades reliability by $> 5\%$, generalization by $> 5\%$, or capability by $> 2\%$ is immediately **rejected**.

---

## 3. CLI Reference (`nexum evolve`)

```bash
# View all evolution options
nexum evolve --help

# Show evolutionary lineage (H0 -> Hn) and currently active baseline
nexum evolve --history

# Inspect recent episode failures in .nexum/lessons.db and recommend mutations
nexum evolve --diagnose

# Run benchmark suites matching current weaknesses
nexum evolve --benchmark

# Autonomous self-development actuator (heuristic planner by default):
# target → isolated worktree → edits → verification profile → candidate
nexum evolve --mutate --repo .

# Full production run: engineering agent + subprocess benchmark (parent
# baseline first) + canonical GitHub delivery (PR → CI → review → merge)
NEXUM_GITHUB_OWNER=<owner> NEXUM_GITHUB_REPO=<repo> nexum evolve \
  --mutate --repo . --strategy agent --benchmark --github

# Evaluate and benchmark a candidate harness mutation live
nexum evolve --candidate H1 --component execution --hypothesis "Tighten loop detector threshold"

# Instant rollback to an earlier harness version
nexum evolve --rollback H0
```

---

## 4. Interactive TUI Commands (`/evolve`)

Inside the interactive terminal workspace (`nexum`), developers can control evolution without leaving the TUI:

- `/evolve` or `/evolve history`: Displays the registered version tree and active baseline.
- `/evolve diagnose`: Analyzes recent session episodes and prints detected weaknesses with expected impact deltas.
- `/evolve benchmark`: Displays recommended benchmark categories for active weaknesses.
- `/evolve rollback <id>`: Instantly demotes newer versions and restores version `<id>` as active.

---

## 5. Provenance & Delivery Engine

When a candidate harness mutation is validated and promoted, the `GitDeliveryEngine`:

1. Creates an isolated git branch: `evolution/<version-id>-<component>`
2. Formats a structured, research-grade commit message with hypothesis and score deltas.
3. Prepares a GitHub Draft PR body with a complete empirical evidence table:

```markdown
## Nexum Harness Evolution — Promoted Mutation `H1`

### 1. Hypothesis & Root Cause

- **Target Component:** `execution`
- **Parent Version:** `H0`
- **Hypothesis:** IF loop detection thresholds are tightened THEN loop aborts will decrease.

### 2. Empirical Evaluation

| Dimension          |  Delta   | Interpretation                                |
| :----------------- | :------: | :-------------------------------------------- |
| **Capability**     | `+8.0%`  | Task success and verification accuracy        |
| **Reliability**    | `+15.0%` | Error reduction, loop aborts, false successes |
| **Efficiency**     | `+3.2%`  | Token consumption change                      |
| **Generalization** | `+5.0%`  | Held-out and cross-model transfer score       |

### 3. Decision & Provenance

- **Decision:** **`PROMOTE`**
- **Rationale:** Promoted: capability delta +8.0%, reliability delta +15.0%
- **Candidate Commit:** `HEAD`
```

---

## 6. Closed-Loop v2: Target Formation, Experience Learning & the Experiment State Machine

The v1 loop answers _"did this candidate score higher?"_. The v2 closed-loop engine (`src/evolution/engine-v2.ts`, `ClosedLoopEngine`) implements the deeper question from the Self-Developing Agents research: _"which changes reliably improve the engineering system?"_. It adds three layers on top of the v1 foundation.

### 6.1 Three Separated Kinds of Learning

```text
                      NEXUM
                        │
          ┌─────────────┼─────────────┐
          │             │             │
       TASK         EXPERIENCE      HARNESS
       LEARNING     LEARNING        EVOLUTION
          │             │             │
       skills        evidence       experiments
       lessons       digests        state machine
          │             │             │
          └─────────────┼─────────────┘
                        │
                 VALIDATED CAPABILITY
```

- **Task learning** (existing, `src/learning/`): `EpisodeRecorder → Grader → Reflector → LessonStore → SkillSynthesizer`.
- **Experience learning** (new, `src/evolution/experience/`): `TrajectoryAnalyzer → ExperienceStore → EvidenceAggregator → TransferAnalyzer`. Encodes the S³Gym findings: no single memory representation wins (raw trajectory / summary / aggregated statistics trade places per task class), self-judgment is a poor predictor (evidence confidence is down-weighted when no verifier ran), and every record binds the executor model + harness version that produced it.
- **Harness evolution** (new, `src/evolution/experiments/`, `src/evolution/acceptance/`): `ExperimentController`, the lifecycle state machine, and the `AcceptanceController`.

### 6.2 Target Formation (the Aspire layer)

`src/evolution/targets/target-engine.ts` sits between diagnosis and planning. It refuses to answer _"which file should I change?"_ until it has answered _"what capability is actually failing?"_ — producing an `ImprovementTarget` with a capability, an operationalized desired outcome, observable symptoms, must-move metrics, affected components (including plausible cross-component causes), a confidence score, and a split-aware evaluation plan. Weak evidence yields no target: the loop gathers more telemetry instead of mutating on a vague goal.

### 6.3 The Evolution State Machine

Promotion is no longer a single function call. A candidate must traverse:

```text
OBSERVED → DIAGNOSED → TARGETED → HYPOTHESIS → CANDIDATE → EVALUATING →
VALIDATED → GENERALIZED → ELIGIBLE → DELIVERED → CI_PENDING → CI_PASSED →
REVIEW_PENDING → APPROVED → ACCEPTED → ACTIVE

Failure paths:
  EVALUATING     ──→ REJECTED            (Stage A / Stage B gate failed)
  GENERALIZED    ──→ REJECTED            (held-out / transfer regression,
                                          or generalization policy unmet)
  CI_PENDING     ──→ CI_FAILED           (GitHub CI red)   ──→ CANDIDATE (rework)
  REVIEW_PENDING ──→ CHANGES_REQUESTED   (human review)    ──→ CANDIDATE (rework)
  ACTIVE         ──→ REGRESSED           (post-deploy monitoring) → ROLLBACK → ACTIVE (prior)
```

"Declared promotions" are structurally impossible: `EvolutionStateMachine` rejects skipped stages.

CI and review are FIRST-CLASS lifecycle states (v2.1): a passing CI run has its own explicit transition (`CI_PENDING → CI_PASSED → REVIEW_PENDING`), and so does an approval (`REVIEW_PENDING → APPROVED`). External feedback can no longer be silently dropped by the lifecycle — a CI verdict ALWAYS advances the experiment, in both directions. Legacy persisted records using the old `REVIEWED` state name are normalized onto `REVIEW_PENDING` via `normalizeLegacyState()`.

### 6.4 Two-Stage Candidate Selection

`src/evolution/comparison/two-stage-selector.ts` separates experiment validity from improvement:

- **Stage A — statistical / execution validity**: runs completed, verifier coverage, verifier evidence validity, no catastrophic regressions, sufficient sample size.
- **Stage B — improvement validity**: capability or reliability gain, no held-out regression, transfer evidence, acceptable token cost.

### 6.5 Fixed-Executor Evaluation & the Generalization Gate

`src/evolution/evaluation/fixed-executor.ts` treats evaluator model, harness candidate, and task suite as independent variables and builds the H0..Hn × executor matrix. `src/evolution/generalization/generalization-gate.ts` grants `GENERALIZED` only when the candidate holds or improves held-out success under the primary executor and does not collapse under any transfer executor, and reports **executor sensitivity** (spread of held-out deltas across executors) plus **direction agreement** — the research metrics for separating "the harness improved" from "this model + harness combination got lucky".

#### Generalization policy

The gate's enforcement level is configurable (`ClosedLoopEngineOptions.generalizationPolicy`):

| Policy                    | Behavior                                                                                                                                         |
| :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `optional` (default)      | Held-out/transfer evidence is recorded when supplied; its absence never blocks eligibility. Development mode.                                    |
| `required`                | A fixed-executor matrix MUST be supplied and the gate MUST pass, otherwise the candidate is rejected at `GENERALIZED → REJECTED`. Research mode. |
| `required-for-production` | `required` plus transfer-executor evidence MUST be present. Production evolution.                                                                |

This closes the "permissive held-out gate" loophole: a candidate can no longer become eligible without the fixed-executor evidence the methodology demands.

### 6.6 Mutation Scope Escalation

The single-component scoping principle remains the default, but `src/evolution/mutation/mutation-scope.ts` allows explicit escalation to a compound hypothesis after repeated single-component experiments fail to move the same capability target (bounded component span, full audit rationale).

### 6.7 Persistent Experiment Provenance in PRs

Every experiment is a persistent record (`ExperimentRecord`) with parent/candidate harness + commit, the formed target, the hypothesis, the executor matrix, visible/held-out/transfer evaluation, the two-stage decision, CI status, and review state. Eligible candidates get an evolution branch + draft PR whose body embeds the machine-readable provenance:

```yaml
experiment:
  id: exp-00142
parent:
  harness: H17
  commit: abc123
candidate:
  harness: H18
  commit: def456
target:
  capability: tool_utilization
executor:
  primary: qwen3-coder
  transfer:
    - gemini-2.5
evaluation:
  visible: {}
  held_out: {}
  transfer: {}
decision:
  result: eligible
ci:
  status: pending
review:
  state: pending
```

### 6.8 First-Class Loop Health Metrics

`src/evolution/metrics.ts` tracks: visible/held-out/transfer gains, retention rate, regression rate, rollback rate, false promotion rate, experience→improvement correlation, executor sensitivity, and — most importantly — **promotion precision**:

```text
promotion precision = # candidates actually better on held-out evaluation
                      ------------------------------------------------
                      # candidates promoted
```

### 6.9 v2 CLI Reference

```bash
# Form the capability-level improvement target from recent episodes (Aspire layer)
nexum evolve --target

# Show the evidence-grounded experience digest per task class (S³Gym layer)
nexum evolve --experience

# List experiment records with lifecycle states, CI and review status
nexum evolve --experiments

# Loop health report: promotion precision, retention, rollback, sensitivity
nexum evolve --report

# Self-development actuator: target → isolated worktree → planned edits →
# verification → candidate commit (needs --repo; benchmarks plug in separately)
nexum evolve --mutate --repo /path/to/harness --parent HEAD

# Post-activation health verdict from operational telemetry (JSONL)
nexum evolve --monitor --harness H5 --telemetry telemetry.jsonl
```

### 6.10 The Self-Development Actuator (HarnessMutationExecutor)

Everything upstream decides WHAT should change; `src/evolution/mutation/mutation-executor.ts` performs the actual self-modification and turns it into a verifiable candidate artifact. This is the component that turns Nexum from self-evaluating into self-developing:

```text
prepareWorkspace  → isolated git worktree branched at the parent commit
inspectTarget     → CodeChangePlan (pluggable MutationStrategy)
implement         → writes the planned edits (scope-guarded)
verify            → scope guard + verification commands
finalize          → candidate commit + diff artifact for the experiment
dispose           → worktree cleanup
```

Key properties:

- **Strategy-pluggable**: the default `HeuristicMutationStrategy` produces a deterministic self-describing harness policy edit; real self-modification plugs in a strategy backed by the agent runtime or an LLM. The executor only demands that every produced edit stays inside the mutation scope's component paths and survives verification.
- **Scope-guarded**: edits outside the allowed paths for the target component (or path-escaping edits) are rejected before they touch the worktree — the mutation scope policy is enforced at the filesystem boundary, not just on paper.
- **Isolated**: each candidate is a git worktree, so parallel experiments never interfere and the resulting diff is exactly the mutation.

`ClosedLoopEngine.runEvolutionCycle()` chains the actuator with the full experiment pipeline: mutation → candidate commit → benchmark callback → two-stage + generalization gates → delivery preparation. Failures are reported per stage (`prepare` / `implement` / `verify` / `finalize` / `evaluate`) with all artifacts preserved for rework.

### 6.11 GitHubDeliveryAdapter — the autonomous delivery loop

`src/evolution/delivery/github-adapter.ts` performs the REAL Git/GitHub operations and feeds external results back into the `ExperimentController`, completing the end-to-end pipeline:

```text
mutation → git commit → push branch → create PR → CI → review → feedback
        → rework (CI_FAILED / CHANGES_REQUESTED → CANDIDATE) → accept → merge
```

- `deliverExperiment()` commits, pushes the evolution branch, and opens the PR carrying the provenance body.
- `syncCiFeedback()` polls check-runs and reports the verdict through `reportCiResult()` — including the honest case: a polling timeout reports `pending` and leaves the lifecycle at `CI_PENDING` rather than fabricating a verdict.
- `syncReviewFeedback()` reads the LATEST human review of the PR's head commit and reports it through `reportReviewOutcome()` (`APPROVED` / `CHANGES_REQUESTED`). A review of an earlier commit does not count, and the merge call names the same head SHA, so a commit pushed after approval is not merged unreviewed.
- Git and HTTP are injectable, so the adapter is fully unit-testable without network access.

### 6.12 ActivationMonitor — post-activation telemetry

The `ACTIVE → REGRESSED` path is driven by live operational telemetry, not benchmark reruns. `src/evolution/monitoring/activation-monitor.ts` holds a per-harness performance **envelope** (derived from the parent harness's acceptance evaluation at activation time) and classifies ingested telemetry:

- Channels: task success rate, false success rate, tool error rate, loop abort rate, verification failure rate, token consumption, latency, and task-class distribution drift.
- Verdicts: `healthy` → `degrading` (warn band) → `regressed` (hard band; triggers rollback automatically via `ClosedLoopEngine.evaluateActivation()`).
- Samples are episode-weighted, and a task-class distribution drift beyond tolerance flags that envelope comparisons are no longer like-for-like.

This closes the loop: run → observe → learn → improve → validate → deploy → **monitor** → learn again.

### 6.13 v2 Module Map

```text
src/evolution/
├── types.ts taxonomy.ts diagnoser.ts hypothesis.ts     # v1 diagnosis core
├── planner.ts comparator.ts evaluator.ts registry.ts   # v1 plan/compare/store
├── delivery.ts engine.ts benchmarks.ts cli.ts          # v1 delivery + facade
├── state-machine.ts                                    # v2 lifecycle (13 states)
├── metrics.ts                                          # v2 loop health metrics
├── engine-v2.ts                                        # ClosedLoopEngine (v2 loop)
├── targets/        # Aspire-style target formation
├── experience/     # S³Gym-style evidence-grounded experience
├── experiments/    # provenance schema, store, controller, PR YAML
├── comparison/     # two-stage selector (validity + improvement)
├── evaluation/     # fixed-executor matrix protocol
├── generalization/ # held-out + transfer gate
├── mutation/       # scope escalation + mutation executor + agent strategy
├── delivery/       # GitHubDeliveryAdapter (real Git/GitHub delivery loop)
├── monitoring/     # ActivationMonitor + runtime activation/rollback
└── acceptance/     # candidate → validated → … → active pipeline
```

### 6.14 AgentMutationStrategy — real autonomous code mutation (v2.2)

The default `HeuristicMutationStrategy` modifies the repository but not the harness runtime's behavior: it writes a self-describing `nexum.harness.json` policy file. `src/evolution/mutation/agent-mutation.ts` closes that gap with the first-class agent boundary:

```text
target → EngineeringAgentRuntime.proposeMutation()
           ├─ inspects the worktree  (AgentWorkspaceView: readFile / listFiles)
           ├─ consults evidence      (experienceDigest / telemetryDigest)
           └─ proposes concrete file edits
       → AgentMutationStrategy maps proposals → scope-attributed CodeChangePlan
       → executor implement / verify / finalize (unchanged safety pipeline)
       → actual runtime behavior changes → benchmarks → matrix → PR
```

- `EngineeringAgentRuntime` is the pluggable seam for Nexum's own engineering runtime, an LLM API, or a sandboxed coding agent. Implementations only PROPOSE — the executor applies, verifies, and commits.
- The agent receives the allowed-path list (`allowedPathsFor(scope)`) and is asked to respect it, but nothing is trusted: enforcement stays with the executor (defense in depth).
- Safety envelope: a declined agent aborts the cycle without a candidate (`AgentDeclinedError`); a runaway response exceeding `maxEdits` aborts with `AgentMutationError`.
- `ScriptedAgentRuntime` wraps a plain handler for deterministic tests and dry runs.

This is the transition from "self-modifying repository" to **self-developing harness**: the mutation touches the implementation the benchmark suite actually exercises.

### 6.15 Scope guard v2 — actual-diff verification

The v2.1 guard checked only the PLANNED edits (`planned ⊆ allowed`). A strategy with disk access could smuggle undeclared files into the worktree and pass. The v2.2 `verify()` adds a second, independent guard:

```text
1. PLANNED ⊆ ALLOWED            (unchanged: per-edit component-path check)
2. ACTUAL ⊆ DECLARED ∪ EXTRAS   (new: git diff vs parent commit + untracked files)
```

Every path that actually changed on disk — snapshotted BEFORE verification commands run so tool artifacts cannot pollute the audit — must have been declared in the plan (or be covered by the configured `extraAllowedPaths` carve-out). Undeclared changes fail verification with `actualDiffViolations`, whatever component directory they landed in. The invariant the executor enforces is exactly:

> actual changed files ⊆ allowed mutation paths

### 6.16 The canonical production cycle (engine-integrated delivery)

As of v2.2 the canonical production path is engine-internal: when a `GitHubDeliveryAdapter` is wired and the cycle input supplies `github`, `runEvolutionCycle()` continues past eligibility through real delivery, with every external verdict fed back into the lifecycle inside the workspace lifetime:

```text
target → mutation → evaluation → eligibility
       → push mutation branch → open PR (branch overridden to the REAL mutation branch)
       → poll CI  (CI_PENDING → CI_PASSED | CI_FAILED, timeout stays honest pending)
       → poll review (REVIEW_PENDING → APPROVED | CHANGES_REQUESTED)
       → accept on approval (APPROVED → ACCEPTED → ACTIVE) → merge
       → CI_FAILED / CHANGES_REQUESTED → beginRework() re-enters the loop at CANDIDATE
```

The workspace lifecycle is owned by the cycle itself: the worktree is disposed via `try/finally` on every exit path — success, stage failure, benchmark failure — while the candidate branch and commit survive in the repository for review, rework, and provenance. `retainWorkspace: true` plus `disposeWorkspace()` supports manual delivery flows.

### 6.17 Runtime activation rollback

`HarnessRegistry.rollbackTo()` moves the version-lineage pointer; whether the LIVE process stops executing the regressed harness is a different question. `src/evolution/monitoring/runtime-activation.ts` makes runtime rollback explicit and verifiable:

```text
ACTIVE H(n) → monitor regression → freeze H(n)
  → switch runtime → H(n-1)
  → verify H(n-1) healthy in the runtime
  → persist: REGRESSED → ROLLBACK → ACTIVE + registry.rollbackTo
```

- `RuntimeActivationController` (injectable): `activeHarness()` / `switchTo()` / optional `freeze()` and `harnessHealth()`.
- `RuntimeRollbackOrchestrator.rollback()` drives the full sequence and returns a step-by-step audit report. If the switch fails or the post-switch health verification fails, the runtime is restored to the original harness and the experiment stays honestly at REGRESSED — a rollback is never reported as complete unless the prior harness is actually running again.
- Engine wiring: `rollbackActive()` / `evaluateActivationLive()` (awaited runtime rollback for production monitor ticks) and `activateOnRuntime()` (switches the live runtime onto an accepted candidate — the runtime half of activation). Without a runtime controller the loop keeps the v2.1 logical rollback (`handleRegression`), parking at ROLLBACK.

### 6.18 NexumEngineeringAgentRuntime — the production agent wiring (v2.3)

v2.2's `EngineeringAgentRuntime` seam shipped with only the deterministic `ScriptedAgentRuntime`, leaving "what actually proposes edits in production" as the open question. `src/evolution/mutation/nexum-agent-runtime.ts` closes it: **Nexum's own engineering loop**, as a bounded tool-calling chat cycle over the same `Provider` surface the interactive agent uses, pointed at the confined candidate worktree.

```text
ClosedLoopEngine (agentRuntime)
  ↓  auto-builds GitWorktreeMutationExecutor + AgentMutationStrategy
NexumEngineeringAgentRuntime
  ↓  bounded tool loop over EngineeringChatClient (Nexum Provider)
list_files / read_file / propose_edit / finish / decline
  ↓  proposals only — executor applies, verifies (actual-diff audit),
     commits, benchmarks, delivers
```

- **Tool protocol** (all confined to the `AgentWorkspaceView`): `list_files`, `read_file` (read-only inspection), `propose_edit` (queues FULL file content + rationale), `finish` (ends with queued edits), `decline` (no safe mutation — cycle aborts without a candidate). Tool arguments are accepted as objects (Ollama shape) or JSON strings (other providers).
- **Safety layers, in order**: (1) the system prompt carries the propose-only contract and the allowed-path list; (2) `propose_edit` rejects out-of-scope paths at queue time with a tool error the agent can read and self-correct; (3) the final response is re-audited fail-closed — any queued violation, budget overrun (`maxProposals`), or oversized file (`maxEditBytes`) aborts; (4) `maxTurns` bounds the whole loop; (5) the strategy attributes edits to scope components and (6) the executor audits the actual git diff. The runtime is deliberately read+propose only — no write, no shell — so the executor remains the sole writer and the verification pipeline cannot be bypassed.
- **Honest outcomes**: `finish` with zero proposals returns `declined` ("investigation finished without any proposed edit") — no candidate is fabricated; `decline` propagates as `AgentDeclinedError`.
- **Production wiring**: `chatClientFromProvider(provider, model?)` adapts `Provider.chat`; `agentMutationStrategyFromProviderOptions({ tier, model, host, apiKey, ... })` builds the whole strategy from the interactive agent's `loadConfig()` defaults. The engine accepts `agentRuntime` (+ optional `agentVerifyCommands`) and auto-builds the agent-backed executor when no explicit `mutationExecutor` is given. The CLI exposes `--mutate --agent` (opt-in; the default stays heuristic).

### 6.19 CLI production wiring — evaluation, verification profiles, delivery (v2.3.1)

v2.3 shipped a real actuator behind a CLI that still could not complete a cycle: `evaluateCandidate` was a throwing stub, the only verification gate was `node --version`, and `GitHubDeliveryAdapter` had zero `src/` construction sites. v2.3.1 closes those three seams:

```bash
export NEXUM_GITHUB_OWNER=<owner> NEXUM_GITHUB_REPO=<repo> NEXUM_GITHUB_TOKEN=<pat>
nexum evolve --mutate --repo . --strategy agent --benchmark --github
```

- **Real evaluation with a real baseline** (`--benchmark`): the candidate worktree is benchmarked in a SUBPROCESS (`src/benchmark/cli.ts --json`, `cwd` = worktree) — in-process evaluation would benchmark the host module graph, not the mutated code. The parent repository is benchmarked first (`--skip-baseline` to opt out), so the two-stage comparison measures real deltas B(H0) vs B(H1) instead of evaluating H1 against a synthetic baseline.
- **EvolutionVerificationProfile** (`--verify-profile smoke|fast|full`): repository-defined gates run sequentially inside the worktree — `smoke` (node liveness, the historical default), `fast` (prettier --check, eslint, tsc --noEmit; the new default), `full` (fast + `npm test`; automatic for `--github` delivery runs, so a PR is only opened for a CI-equivalent candidate). Unknown names fail loudly instead of silently weakening the gate.
- **Worktree toolchain linking**: the executor's `linkNodeModulesFrom` symlinks the host `node_modules` into fresh worktrees (git worktrees carry history, not dependencies), making real gates executable. Dependency directories are gitignored, so the actual-diff scope audit is unaffected.
- **Canonical delivery** (`--github`): the adapter is constructed from `NEXUM_GITHUB_*` environment variables, enabling push mutation branch → PR → CI poll → review poll → auto-accept → merge, with rework re-entry via `beginRework()`.
- **Strategy unification**: `--strategy agent|heuristic` (loud failures on typos) with `--agent` as an alias; the CLI builds one explicit executor carrying strategy + profile + linking, while the engine's `agentRuntime` auto-wiring stays available to API users.
- **Segment-aware scope containment** (`mutation/path-scope.ts`): every scope predicate (runtime proposal checks, strategy attribution, executor planned/actual audits) now uses `pathWithinAllowedPrefix` — allowed prefix `src/evolution` no longer admits the sibling `src/evolution2/...`. The executor's actual-diff audit remains the backstop; the invariant is now explicit at every layer.
- **Bounded worktree view**: `list_files` excludes dependency/build directories and caps at `maxListEntries` (400); `read_file` truncates at `maxReadBytes` (64 KiB) — the agent's context budget is a function of the configured envelope, not of the worktree size.

### 6.20 Experiment persistence & immutable artifacts (v2.3.2)

Every autonomous mutation is now a persistent, scientifically inspectable record. Previously the `--mutate` path ran the whole experiment lifecycle in-memory — records died at process exit and `--experiments` read an empty database.

- **Persisted provenance**: the mutate path wires a store-backed `ExperimentController` (`<workspace>/state/experiments.db`), so target, hypothesis, executor, evaluation, two-stage decision, lifecycle transitions, CI, and review state survive the run and feed `--experiments` and the promotion-precision report.
- **Immutable artifacts** (`experiments/experiment-artifact.ts`): one frozen JSON file per cycle — default `<workspace>/state/experiments/<experimentId>.json`, override with `--experiment-dir` — carrying the full scientific tree:
  `target → diagnosis → hypothesis → model → executor → mutation proposals → changed files → verification → baseline metrics (B(H0)) → candidate metrics (B(H1)) → held-out → transfer → delivery → CI → review → decision`, including raw per-run benchmark rows. Written exclusively (`wx`: an existing artifact is never overwritten) with a sha256 integrity hash over the payload.
- **Failures are evidence**: declined mutations and prepare/implement/verify/finalize/evaluate stage failures produce artifacts too (`decision.verdict: "failed"`, with the failed stage and reason).
- **Fixed: silent empty `changedFiles`/`diffStat`** — `prepareWorkspace` stored the literal parent ref (default `HEAD`); `finalize`'s post-commit `git diff --name-only HEAD` therefore diffed the candidate against itself, and every default `--parent HEAD` run since v2.2 produced artifacts claiming no changed files. The parent is now resolved to its SHA once at workspace creation. (The verify-time actual-diff scope audit ran pre-commit and was unaffected.)

```bash
nexum evolve --mutate --repo . --strategy agent --verify-profile full --benchmark
# → <workspace>/state/experiments/exp-<ts>.json  (immutable record of the cycle)
```

### 6.21 Experience feed & runtime activation (v2.3.3)

The two remaining deferred seams: the S³Gym experience feed now has a
production call site, and the `RuntimeActivationController` seam has a
production implementation.

- **Experience feed** (`cli.ts` `ingestParentExperience`): the mutate path
  converts the graded parent-harness episodes it loads for diagnosis into
  experience records, keyed by the resolved parent commit SHA — so
  `--experience` digests and transfer analysis operate on measured evidence
  instead of an empty store. Idempotent (episode id is the store's primary
  key) and best-effort: accumulation never breaks a mutation cycle.
- **ManifestRuntimeActivationController**
  (`monitoring/manifest-runtime-activation.ts`): the production
  `RuntimeActivationController`. The harness manifest
  (`nexum.harness.json` — the file strategies legitimately write policy
  into) becomes the activation contract: `switchTo(H(n))` resolves the
  harness to a commit (registry lineage first, then any git-resolvable ref),
  verifies the commit exists in the repository, atomically writes the
  `activeHarness` pointer (tmp + rename), and re-reads it to verify.
  Fail-closed on unknown harnesses; corrupt manifests are never clobbered;
  `harnessHealth()` is real external reality (git cat-file), so the runtime
  rollback orchestrator's post-switch verification checks the repository,
  not self-report. A successful switch clears the freeze marker.
- **CLI**: `--activate-runtime` (explicit opt-in, default OFF) wires the
  controller plus the harness registry into the mutate path. After a cycle
  whose candidate was ACCEPTED (GitHub delivery, CI passed, review approved),
  the live runtime is switched onto the candidate via
  `ClosedLoopEngine.activateOnRuntime()`; skips and failures are honest and
  recorded. The experiment artifact gains an `activation` section carrying
  the controller, harness id, commit, and outcome.
- The activation gate is deliberately conservative: without `--github`
  delivery reaching ACTIVE, activation is skipped with the reason in the
  artifact — the runtime half of acceptance cannot run ahead of the
  registry/state half.

```bash
nexum evolve --mutate --repo . --strategy agent --verify-profile full \
  --benchmark --github --activate-runtime
# → accepted candidate becomes the manifest pointer (nexum.harness.json)
```
