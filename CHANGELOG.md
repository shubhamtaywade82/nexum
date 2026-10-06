# Changelog

## Unreleased

### Added — model-aware Context Compiler & verification gate

- **`budgetForProfile`** (`src/models/profiles/context-budget.ts`): derives a
  per-call context/tool budget from a `ModelProfile` (small / standard /
  frontier size classes), clamped to the real context window minus an output
  reserve. `ModelConstraints` gains optional `preferredContextTokens` and
  `maxToolCount`.
- **`ContextCompiler`** (`src/context/compiler.ts`): compiles task node,
  constraints, success criteria, evidence (via `ContextPacker`), failures,
  decisions, facts, artifact references and a ranked tool pack into one
  budgeted, deterministic prompt block with a full exclusion manifest.
- **`gateTaskCompletion`** (`src/runtime/verification-gate.ts`) and
  **`expectCommandSucceeds`**: a task moves `running → completed` only when
  its deterministic verification contract passes.

See `docs/guide/context-compiler.md`.

### Added — ink-ui (termcn) component layer & theme system (`src/tui/ui/`)

Nexum's TUI presentation layer migrates from hand-rolled Ink primitives onto
a vendored, Nexum-owned copy of the [termcn (ink-ui)](https://github.com/shadcn-labs/termcn)
component registry (shadcn-style copy-paste install via
`scripts/vendor-termcn.mjs`), while all business logic — the runtime store,
keybindings, picker/prompt engines — stays put.

- **Theme system**: 15 built-in semantic themes (default/midnight/solarized
  - dracula, nord, github, gruvbox, tokyo-night, monokai, catppuccin,
    one-dark, vercel, high-contrast, high-contrast-light, matrix), a
    compiler-enforced `ThemeName → Theme` registry, and a `ThemeProvider`
    wired to the runtime's `theme.changed` event for instant live switching.
- **`/theme`**: no-arg now opens an interactive picker with per-theme color
  swatches; direct names Tab-complete. Selections persist to
  `.nexum/config.json`; `NEXUM_THEME` and config `theme` bootstrap the
  initial palette.
- **Component kit**: Badge, Spinner, StatusMessage, ProgressBar,
  KeyboardShortcuts, Alert, InfoBox, Heading, KeyValue, Divider, Tag,
  Dialog, Confirm, Select, MultiSelect, Toast, Markdown, Code, DiffView,
  DirectoryTree, StreamingText, ChatMessage, ThinkingBlock, TokenUsage,
  Gauge, Sparkline, JSON, Table, DataGrid, ScrollView + interaction hooks.
- **Adoption**: Help overlay (KeyboardShortcuts), model/skills/sessions/tools
  empty+loading states (StatusMessage/Spinner), Context Inspector
  (Gauge + TokenUsage); every zone, overlay, view and panel now renders
  through semantic theme tokens.
- **Compat**: default-theme output is byte-identical with the previous
  hardcoded ANSI palette (all snapshot tests unchanged).

### Added — Closed-Loop Self-Development v2 (`src/evolution/`)

Implements the deeper closed-loop RSI layers on top of the HarnessDev-style
v1 foundation, informed by the Self-Developing Agents research (Aspire /
S³Gym / HarnessDev):

- **Evolution lifecycle state machine** (`state-machine.ts`): 13 progressive
  states (`OBSERVED → … → ACTIVE`) with explicit failure paths
  (`REJECTED`, `CI_FAILED`, `CHANGES_REQUESTED`, `REGRESSED`, `ROLLBACK`)
  and recovery transitions. Declared promotions are structurally impossible.
- **TargetEngine** (`targets/target-engine.ts`): Aspire-style target
  formation between diagnosis and planning — answers "what capability is
  actually failing?" before "which file should I change?"; refuses vague
  targets with weak evidence.
- **Experience engine** (`experience/`): `ExperienceStore` (SQLite),
  `TrajectoryAnalyzer`, `EvidenceAggregator`, `TransferAnalyzer` —
  evidence-grounded experience records bound to verifier evidence, executor
  model, and harness version; multi-representation digests (raw trajectory /
  summary / aggregated statistics) selected per task class per the S³Gym
  finding that no single representation wins.
- **Two-stage candidate selection** (`comparison/two-stage-selector.ts`):
  Stage A statistical/execution validity (sample size, verifier coverage,
  catastrophic regressions) separated from Stage B improvement validity
  (capability/reliability gain, held-out, transfer, cost).
- **Fixed-executor evaluation protocol** (`evaluation/fixed-executor.ts`) and
  **GeneralizationGate** (`generalization/generalization-gate.ts`): evaluator
  model, harness candidate, and task suite as independent variables; held-out
  - transfer gates with executor-sensitivity and direction-agreement metrics.
- **Mutation scope escalation** (`mutation/mutation-scope.ts`): single
  component by default; explicit compound hypothesis after repeated
  single-component failures against the same capability.
- **Experiment provenance** (`experiments/`): persistent `ExperimentRecord`
  schema + SQLite store + `ExperimentController`; evolution PRs embed a
  machine-readable YAML provenance block making the PR a persistent
  experiment log (CI status and review state included).
- **AcceptanceController** (`acceptance/acceptance-controller.ts`): explicit
  evidence-gated pipeline `candidate → validated → eligible → delivered →
accepted → active`.
- **First-class loop health metrics** (`metrics.ts`): promotion precision,
  false promotion rate, retention/regression/rollback rates, experience→
  improvement correlation, executor sensitivity, visible/held-out/transfer
  gains.
- **`ClosedLoopEngine`** (`engine-v2.ts`): wires the full v2 loop —
  episodes → diagnosis → target formation → hypothesis → experiment →
  two-stage gates → generalization gate → delivery → CI/review feedback →
  active/rollback.
- **v2 CLI**: `nexum evolve --target | --experience | --experiments | --report`.

The v1 `EvolutionEngine` API remains fully backward compatible.

### Added — v2.1: The Self-Development Actuator, Real Delivery & Post-Activation Monitoring

Closes the gaps identified in the v2 architecture review — Nexum moves from
self-evaluating to self-developing:

- **HarnessMutationExecutor** (`mutation/mutation-executor.ts`): the missing
  actuator. `prepareWorkspace → inspectTarget → implement → verify →
finalize` turns a formed target into a verifiable candidate commit inside
  an isolated git worktree. `MutationStrategy` is pluggable (default:
  deterministic heuristic; real self-modification plugs in the agent
  runtime/LLM). Every edit is scope-guarded at the filesystem boundary and
  must survive the configured verification commands.
- **`ClosedLoopEngine.runEvolutionCycle()`**: the full self-development cycle
  — mutation → candidate commit → benchmark callback → two-stage +
  generalization gates → delivery — with per-stage failure reporting
  (`prepare` / `implement` / `verify` / `finalize` / `evaluate`) and
  artifacts preserved for rework.
- **GitHubDeliveryAdapter** (`delivery/github-adapter.ts`): performs the
  real Git/GitHub delivery loop (commit → push → PR) and feeds external
  results back into the `ExperimentController`: CI check-run polling
  (`syncCiFeedback`), latest-review polling (`syncReviewFeedback`), and
  merge support. Git and HTTP are injectable; a polling timeout reports
  `pending` honestly instead of fabricating a verdict.
- **Explicit CI/review lifecycle states** (v2.1 state machine): `CI_PENDING`,
  `CI_PASSED`, `REVIEW_PENDING`, `APPROVED` — a CI verdict ALWAYS advances
  the experiment (DELIVERED → CI_PENDING → CI_FAILED | CI_PASSED →
  REVIEW_PENDING), and a review verdict always advances it (REVIEW_PENDING →
  APPROVED | CHANGES_REQUESTED). Fixes the v2.0 bug where a passing CI run
  left the lifecycle parked at DELIVERED. `normalizeLegacyState()` maps old
  persisted `REVIEWED` records onto `REVIEW_PENDING`.
- **Generalization policy** (`ClosedLoopEngineOptions.generalizationPolicy`):
  `optional` (development, the v2.0 behavior) | `required` (research: the
  fixed-executor matrix MUST be supplied and pass) | `required-for-production`
  (research + transfer-executor evidence). Policy-blocked candidates walk
  VALIDATED → GENERALIZED → REJECTED with the reason in the audit trail.
- **ActivationMonitor** (`monitoring/activation-monitor.ts`): post-activation
  regression detection from operational telemetry (success rate, false
  success rate, tool error rate, loop aborts, verification failures, token
  consumption, latency, task-class distribution drift) against a
  performance envelope derived from the parent harness at activation time.
  `healthy → degrading → regressed`, with `regressed` auto-driving
  ACTIVE → REGRESSED → ROLLBACK.
- **Two-stage rejection path**: candidates rejected by Stage A/B now walk
  EVALUATING → REJECTED explicitly instead of being left stuck in EVALUATING.
- **v2.1 CLI**: `nexum evolve --mutate --repo <path> [--parent <sha>]`
  (self-development actuator) and `nexum evolve --monitor --harness <id>
--telemetry <file.jsonl>` (post-activation health).

### Added — v2.2: Real Autonomous Mutation, Canonical Delivery Path & Runtime Rollback

Closes the remaining gaps from the v2.1 review — Nexum moves from
self-modifying to genuinely self-developing:

- **AgentMutationStrategy** (`mutation/agent-mutation.ts`): real autonomous
  code mutation. An injectable `EngineeringAgentRuntime` (Nexum's own
  engineering runtime, an LLM, or a sandboxed coding agent) inspects the
  candidate worktree (`AgentWorkspaceView`), consults experience/telemetry
  digests, and proposes concrete edits to the ACTUAL implementation — the
  benchmark suite then evaluates mutated runtime behavior, not a policy
  manifest. Agents only propose; the executor applies, verifies, and
  commits. `ScriptedAgentRuntime` provides a deterministic handler-based
  runtime for tests and dry runs; `AgentDeclinedError` aborts cleanly and
  a `maxEdits` envelope stops runaway responses.
- **Scope guard v2 — actual-diff verification**: `verify()` now audits what
  ACTUALLY changed on disk (`git diff` vs the parent commit + untracked
  files, snapshotted before verification commands run) and fails when a
  changed path was never declared in the plan — closing the side-effect
  hole where a strategy could smuggle undeclared files while presenting a
  clean plan. Enforced invariant: `actual changed files ⊆ allowed mutation
paths`.
- **Canonical production path (engine-integrated delivery)**:
  `runEvolutionCycle({ github })` continues past eligibility through real
  delivery inside the workspace lifetime — push the actual mutation branch
  (the DeliveryReport branch is overridden with the real one), open the PR,
  poll CI, poll review, auto-accept on approval, merge. CI/review verdicts
  feed the lifecycle in-cycle; `beginRework()` re-enters the loop from
  `CI_FAILED` / `CHANGES_REQUESTED` to `CANDIDATE`.
- **Workspace lifecycle ownership**: the evolution cycle disposes the
  worktree via `try/finally` on every exit path (success, stage failure,
  benchmark failure) while the candidate branch/commit survive in the
  repository; `retainWorkspace` + `disposeWorkspace()` support manual
  delivery flows. Autonomous operation no longer leaks `/tmp` worktrees.
- **Runtime activation rollback** (`monitoring/runtime-activation.ts`):
  registry rollback now has a runtime counterpart.
  `RuntimeRollbackOrchestrator` performs freeze → switch → health-verify →
  persist (`REGRESSED → ROLLBACK → ACTIVE` + registry rollback). A failed
  switch or failed post-switch health probe restores the original harness
  and leaves the experiment honestly at REGRESSED. Engine wiring:
  `rollbackActive()`, `evaluateActivationLive()` (production monitor tick),
  and `activateOnRuntime()` (runtime half of acceptance).
- **Fix: `GitHubDeliveryAdapter` default git runner** spawned bare
  subcommands (`rev-parse`, `push`) without the `git` prefix, so the
  non-injected production path could never execute; subcommands are now
  normalized onto `git`.

### Added — v2.3: Production Agent Wiring (`NexumEngineeringAgentRuntime`)

Closes the final question from the v2.2 review — what actually implements
`EngineeringAgentRuntime` in production:

- **NexumEngineeringAgentRuntime** (`mutation/nexum-agent-runtime.ts`):
  Nexum's own engineering loop as a bounded, tool-calling chat cycle over
  the same `Provider` surface the interactive agent uses, pointed at the
  confined candidate worktree. Tools: `list_files` / `read_file` (read-only
  inspection), `propose_edit` (queues FULL file content + rationale),
  `finish`, `decline`. Accepts tool arguments as objects (Ollama) or JSON
  strings (other providers).
- **Layered safety**: prompted propose-only contract → queue-time scope
  rejection with agent-readable tool errors (self-correction) → fail-closed
  final re-audit → `maxTurns` / `maxProposals` / `maxEditBytes` envelopes →
  strategy attribution → executor actual-diff audit. The runtime is
  deliberately read+propose only (no writes, no shell): the executor stays
  the sole writer, so the verification pipeline cannot be bypassed.
- **Honest outcomes**: `finish` with zero proposals returns `declined`
  (no fabricated candidates); `decline` aborts the cycle without one.
- **Production factories**: `chatClientFromProvider(provider, model?)` and
  `agentMutationStrategyFromProviderOptions(...)` (inherits the interactive
  agent's `loadConfig()` defaults). Engine option `agentRuntime` (+ optional
  `agentVerifyCommands`) auto-builds the agent-backed
  `GitWorktreeMutationExecutor` when no explicit `mutationExecutor` is set.
  CLI: `nexum evolve --mutate --agent` (opt-in; default stays heuristic).

### Added — v2.3.3: Experience Feed & Runtime Activation

Closes the last two deferred seams from the v2.3.1/v2.3.2 reviews: the
S³Gym experience engine had no production call site (`ingestExperience` was
dead code — every `--mutate` run built an `ExperienceStore` that nothing
wrote to), and the `RuntimeActivationController` seam had no production
implementation (rollback fell back to a registry pointer move; accepted
candidates were never switched onto the live runtime).

- **Experience feed** (`cli.ts` `ingestParentExperience`): the mutate path
  converts the graded parent-harness episodes it loads for diagnosis into
  experience records keyed by the resolved parent commit SHA, before the
  cycle runs. Idempotent (episode id is the store's primary key) and
  best-effort — evidence accumulation must never break a mutation cycle.
  `--experience`, `--report` (experience→improvement correlation), and
  transfer analysis now operate on measured evidence.
- **`ManifestRuntimeActivationController`**
  (`monitoring/manifest-runtime-activation.ts`): the production runtime
  half of activation. The harness manifest (`nexum.harness.json`) becomes
  the activation contract: `switchTo(H(n))` resolves the harness id to a
  commit (registry lineage first, then any git-resolvable ref), verifies
  the commit exists (`git cat-file`), atomically writes the
  `activeHarness` pointer (tmp + rename, strategy-written policy fields
  preserved), and re-reads it to verify the switch landed. Fail-closed on
  unknown harnesses; corrupt manifests are never clobbered; `harnessHealth`
  probes the repository, not self-report, so the runtime rollback
  orchestrator's post-switch verification is external reality. A successful
  switch clears the freeze marker.
- **CLI `--activate-runtime`** (explicit opt-in, default OFF): wires the
  controller plus the harness registry into the mutate path. After a cycle
  whose candidate was ACCEPTED (GitHub delivery, CI passed, review
  approved), the live runtime is switched onto the candidate via
  `ClosedLoopEngine.activateOnRuntime()`; honest skips (experiment not
  ACTIVE) and failures are logged and recorded. The experiment artifact
  gains an `activation` section (controller, harness id, commit, outcome).
- Without `--activate-runtime` the mutate path is byte-identical to v2.3.2.

### Added — v2.3.2: Experiment Persistence & Immutable Artifacts

Before this change the `--mutate` path ran the ENTIRE experiment lifecycle
in-memory (`ExperimentController` defaults to no store), so every record was
lost at process exit while `--experiments` and the health report read an
empty `experiments.db`. v2.3.2 makes every autonomous mutation a persistent,
scientifically inspectable record:

- **Persisted experiment provenance**: `nexum evolve --mutate` now wires a
  store-backed `ExperimentController` (`<workspace>/state/experiments.db`),
  so target, hypothesis, executor, evaluation, two-stage decision, lifecycle
  transitions, CI, and review state survive the run and feed `--experiments`
  and the promotion-precision report.
- **Immutable experiment artifacts** (`experiments/experiment-artifact.ts`):
  one frozen JSON file per cycle (default
  `<workspace>/state/experiments/<experimentId>.json`, override with
  `--experiment-dir`) carrying the full scientific tree — target, diagnosis,
  hypothesis, model/executor identity, mutation proposals (with rejected
  edits), changed files, per-gate verification results, baseline B(H0) and
  candidate B(H1) aggregates WITH raw per-run rows, held-out/transfer
  results, delivery/CI/review outcome, and the two-stage decision. The
  envelope is written exclusively (`wx` — never overwritten) and carries a
  sha256 integrity hash over the payload.
- **Stage failures are first-class results**: declined mutations and
  prepare/implement/verify/finalize/evaluate failures produce artifacts too
  (`decision.verdict: "failed"` with the stage and reason) — a mutation that
  never became a candidate is still evidence.
- **Bug fix — silent empty `changedFiles`/`diffStat`**: `prepareWorkspace`
  stored the LITERAL parent ref (default `HEAD`), so `finalize`'s
  `git diff --name-only HEAD` executed AFTER the candidate commit diffed the
  commit against itself: candidate artifacts reported no changed files for
  every default `--parent HEAD` run since v2.2. The parent is now resolved
  to its SHA once at workspace creation; the verify-time actual-diff audit
  (pre-commit) was unaffected.

### Added — v2.3.1: CLI Production Wiring (evaluation, verification, delivery)

Closes the three integration seams that still blocked the first genuine
end-to-end autonomous cycle after v2.3 (the throwing `evaluateCandidate`
stub, the `node --version`-only verification gate, and the delivery adapter
that no production path constructed):

- **Real candidate evaluation** (`--benchmark`): the mutation cycle now
  benchmarks the candidate worktree through a SUBPROCESS
  (`src/benchmark/cli.ts --json`, `cwd` = worktree) instead of failing at the
  evaluate stage — in-process evaluation would benchmark the host module
  graph, not the mutated code. The parent repository is benchmarked FIRST
  for a real baseline delta B(H0) vs B(H1) (`--skip-baseline` opts out);
  `parseBenchmarkJson` maps held-out splits and loop-abort detection.
- **EvolutionVerificationProfile** (`mutation/verification-profile.ts`):
  repository-defined verification gates replacing the smoke default —
  `smoke` (node liveness, historical default), `fast` (format + lint +
  typecheck; the new CLI default), `full` (fast + `npm test`, CI-equivalent;
  automatic when `--github` is set). `nexum evolve --mutate
--verify-profile <name>`; unknown names fail loudly.
- **Worktree toolchain linking**: `GitWorktreeMutationExecutor`
  `linkNodeModulesFrom` symlinks the host `node_modules` into fresh
  worktrees so real gates (tsc/eslint/jest) can execute — `git worktree add`
  brings history, not dependencies. Dependency dirs are gitignored, so the
  actual-diff scope audit is unaffected.
- **Canonical GitHub delivery** (`--github`): builds `GitHubDeliveryAdapter`
  from the environment (`NEXUM_GITHUB_OWNER` + `NEXUM_GITHUB_REPO` required;
  `NEXUM_GITHUB_TOKEN`, `NEXUM_GITHUB_BASE_BRANCH` optional) and enables the
  full path: push mutation branch → PR → CI poll → review poll → auto-accept
  → merge, with rework re-entry.
- **CLI strategy unification**: `--strategy agent|heuristic` (unknown names
  throw) with `--agent` kept as an alias; the CLI always passes an explicit
  executor (strategy + profile + linking in one place), while the engine's
  `agentRuntime` auto-wiring remains available to API users.
- **Segment-aware scope containment** (`mutation/path-scope.ts`):
  `pathWithinAllowedPrefix` replaces bare `startsWith` at every scope layer
  (runtime proposal checks, strategy attribution, executor planned/actual
  audits) so allowed prefix `src/evolution` no longer admits the sibling
  `src/evolution2/...`.
- **Bounded worktree view**: `AgentWorkspaceView.listFiles` excludes
  dependency/build directories (`node_modules`, `dist`, `coverage`, …) and
  caps at `maxListEntries` (default 400); `readFile` truncates at
  `maxReadBytes` (default 64 KiB). The agent's context budget is now a
  function of the configured envelope, not of the worktree size.
- **Benchmark CLI `--json`**: machine-readable mode (single JSON array on
  stdout, progress suppressed) for the subprocess evaluator.
- **Tests**: +18 (`evolution-cli-wiring`); full suite 1311 passed /
  14 network-skipped; lint/format/build/docs green.

## 2.0.0 (2026-08-30)

DevAgent TS is now **Nexum** — same runtime, new name. This is a breaking
product migration: package, CLI, environment variables, and workspace state
directory all change, with one-major-version compatibility aliases so nothing
of yours is lost. Full contract: [docs/REBRANDING.md](docs/REBRANDING.md).

### Breaking

- Package renamed: `@nemesis-oss/devagent-ts` → `@nemesis-oss/nexum`
- CLI renamed: `nexum` (bin aliases `devagent` and `devagent-ts` retained for
  one major version)
- Workspace state moved: `.devagent/` → `.nexum/` — migrated automatically on
  first run (atomic copy, idempotent, never deletes the original); `nexum
migrate` prints an explicit migration report
- Global state moved: `~/.devagent/` → `~/.nexum/` (legacy read as fallback)
- Environment variables renamed: `DEVAGENT_*` → `NEXUM_*` (legacy names still
  honored as deprecated aliases — they warn on stderr and lose to the
  canonical name; suppress with `NEXUM_NO_DEPRECATION_WARNINGS=1`)

### Added

- `src/platform/` layer — `brand.ts` (single source of truth for product
  identity), `environment.ts` (canonical-then-legacy env resolution with
  deprecation warnings), `paths.ts` (state-dir resolution, workspace-root
  discovery), `workspace.ts` (`WorkspaceManager`: detect / migrate /
  initialize / resolve; global-state migration)
- `nexum migrate` command with structured report (workspace entries, history
  file, global state, active legacy env variables)
- `nexum doctor` now reports workspace-state health, legacy `.devagent`
  presence, deprecated `DEVAGENT_*` variables, and the sandbox image
- `docs/REBRANDING.md` — the authoritative DevAgent → Nexum migration contract
- Default sandbox image `nexum-sandbox:latest` (Dockerfile now node:22-slim;
  legacy `devagent-sandbox:latest` still honored when configured explicitly)

### Fixed

- CI push trigger now also covers `rename/**` branches (PRs against `main`
  were already covered)
- Node.js version documented consistently as >= 22 everywhere (AGENTS.md said
  > = 20; sandbox image was node:20-slim)

## 1.0.0 (2026-08-29)

Final DevAgent TS baseline (tagged `v1.0.0`). See git history.

## 0.1.0 (2026-08-28)

### Added

- Public API surface with typed exports (`Agent`, `Provider`, `ModelCatalog`, `Router`)
- Conditional exports map for ESM consumers
- `prepare` npm script to build before publish
- `.npmignore` to ship only compiled output
- MIT LICENSE file
- `src/index.ts` barrel entry re-exporting core classes
- `testTimeout` and `forceExit` in Jest config for reliable CI runs

### Fixed

- Removed unused imports that caused lint errors (`Capability`, `ChatMessage`, `ChatResponse`, `CommandEffect`, `existsSync`)
- CI workflow Node version aligned to `>=22` (was 20)
- App.test.tsx no longer hangs indefinitely — extracted `useStdout()` into a lazily-rendered `TerminalSizeListener` component so tests that provide explicit dimensions never attach Ink's stdout listener
- Skipped bracketed-paste integration test that sets `process.stdin.isTTY = true` (leaves open handle on real stdin)
- Eliminated all 23 `as any` type casts — replaced with proper interfaces and type guards

### Changed

- `package.json` no longer marked `private` — package is publishable to npm
- `useTerminalSize` hook in App.tsx avoids calling `useStdout()` when both dimensions are provided
- `ChatResponse.message` now includes optional `thinking` field for extended Ollama streaming responses
