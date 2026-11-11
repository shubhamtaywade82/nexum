# Agent Execution Kernel

Nexum is evolving from "agent runtime + one large agent product" into a
layered platform: a **generic agent execution kernel** at the bottom, with
domain products (DevAgent, CryptoAgent, future agents) mounted on top as
compositions of tool packs. This document describes the kernel — the code
under `src/kernel/` — and the target layering.

## Why a kernel

Before the kernel, the `Agent` class in `src/cli/agent.ts` assembled
everything: providers, routing, memory, planning, tools, browser, exchange
streams, LSP, docs, learning, and UI plumbing. That god-object worked, but
it made the runtime inseparable from the coding-agent product, and every
new capability (or new agent product) grew the same class.

The kernel extracts the _reusable execution machinery_ behind explicit
contracts. The runtime now knows nothing about Git, Rails, or Binance;
products teach it those domains by mounting packs.

## Layering

```
┌────────────────────────────────────────────┐
│ Applications                                │
│ CLI / TUI / embedded API · DevAgent ·       │
│ CryptoAgent · future agents                 │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│ Control Plane (existing orchestrator)       │
│ Planner · TaskGraph · Scheduler · Delegate  │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│ NEXUM KERNEL  (src/kernel)                  │
│                                             │
│ AgentRuntime      AgentRegistry             │
│ ExecutionStrategy (react, plan_execute, …)  │
│ Context port      BudgetTracker             │
│ Event families    GateRegistry              │
└──────────┬───────────────────┬─────────────┘
           ▼                   ▼
┌────────────────────┐  ┌──────────────────────────────────┐
│ ModelGateway       │  │ ToolGateway (+ PolicyEngine)     │
│ Router · Catalog   │  │ Catalog · validate → policy →    │
│ CapabilityRegistry │  │   concurrency → execute(timeout) │
│ per-tier gates     │  │ ToolCatalog · ToolPacks          │
└─────────┬──────────┘  └─────────┬────────────────────────┘
          ▼                       ▼
   Provider (local/cloud)   Tool packs (src/packs)
                            filesystem · git · lsp · browser ·
                            crypto-trading · …
```

Dependency rule: **the kernel never imports domains** (`exchange/`,
`intelligence/rails`, `tools/*` implementations, `cli/`, `tui/`). Domains
adapt _into_ the kernel through `ToolPack`s; applications adapt the kernel
_out_ through the ports (`ContextManager`, `EventSink`).

## Core contracts

| Contract                             | Purpose                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `AgentRuntime.execute(request, ctx)` | The single entry point: resolve agent → pick strategy → drive one run                    |
| `ExecutionRequest`                   | agentId, TaskSpec, optional strategy / capability filter / budgets                       |
| `ExecutionContext`                   | Per-run wiring: runId, signal, gateways, context port, event sink, budget                |
| `ExecutionResult`                    | status (`completed`/`failed`/`cancelled`/`budget_exhausted`/`timeout`), output, usage    |
| `ExecutionBudget`                    | maxToolCalls, maxModelCalls, maxTotalTokens, maxCostUsd, deadlineMs                      |
| `ToolGateway`                        | `discover()` + `invoke()` behind the policy/validation pipeline                          |
| `ToolDefinition`                     | risk, sideEffects, execution spec (timeout/concurrency/idempotence), confirmation policy |
| `PolicyEngine`                       | "May this agent run this tool now?" — pure decisions, gateway enforces                   |
| `ModelGateway`                       | The one port to inference: capability → Router → per-tier gates + budget accounting      |
| `ModelCapabilityRegistry`            | Rich model profiles: numeric capability scores, constraints, cost                        |
| `GateRegistry`                       | Layered concurrency: global / model / provider / agent / tool / workspace / domain       |
| `EventSink` + families               | Events classified as execution / domain / presentation for targeted projections          |

## The tool pipeline

Every kernel-mediated tool call flows through one enforced pipeline:

```
resolve (aliases) → decode → normalize → validate
  → policy → per-tool concurrency lease → execute (timeout, abort)
```

Argument repair (positional arrays, numeric-key objects, alias mapping —
the weak-model affordances the legacy `Registry` shipped) now happens
_before_ validation, and mutating tools can be excluded from repair via
their definition. Policy denials, schema failures, timeouts, saturation,
and handler exceptions all surface as structured `ToolResult`s, so the
model loop stays resilient without try/catch scaffolding at call sites.

The catalog and the gateway are deliberately separate:

- `ToolCatalog` answers **"what tools exist?"** — a pure registry.
- `ToolGateway` answers **"may this agent execute this tool now?"** — and
  then supervises the execution.

## Tool packs

Packs are the unit of product composition. Each pack is a named bundle of
tools with its security metadata declared _with the domain_:

```ts
const packs = [filesystemPack(root), shellPack(root), gitPack(root), lspPack(lsp)];
for (const pack of packs) toolManager.registerToolPack(pack);

// A crypto product mounts exactly one extra pack:
toolManager.registerToolPack(cryptoPack(stream));
```

The crypto pack demonstrates the boundary: the runtime never imports
Binance. Market-data tools declare `risk: "read"`, while paper-trading
execution declares `risk: "critical"`, `financial: true`, `concurrency: 1`,
and mandatory confirmation — the `RulePolicyEngine` demands confirmation
for any financial side effect _even if the tool opts out_, so trading can
never silently bypass human review.

During the migration window the `AgentToolManager` keeps the legacy
`Registry` in sync with the kernel catalog: the CLI agent's proven loop
keeps its exact behavior (validation `off`, explicit destructive-action
approval), while kernel-native runs get the full strict pipeline.

## Policies and approvals

- `RulePolicyEngine` composes rules: deny lists, risk ceilings, mode
  restrictions (`ask`/`review` are read-only), and confirmation floors.
  First matching rule wins; decisions carry the rule id for audit trails.
- `ApprovalBroker` is the reusable human-in-the-loop resolver — the
  destructive classification table and pending-request plumbing moved out
  of `cli/agent.ts`, so CLI, TUI, API servers, and background workers share
  one implementation. UIs plug in via `setResponder`.
- Unattended runs bypass confirmation by explicit contract (`unattended:
true`), never by silence.

## Strategies

The ReAct loop is no longer baked into the runtime. `ExecutionStrategy` is
a kernel contract; the runtime ships `react` and `plan_execute`, and
`graph`/`workflow` strategies can be added without touching the kernel.
Strategies own _the loop_; the kernel owns _the limits_ — budgets,
timeouts, events, cancellation, concurrency, state. `runGuarded` maps
abort and budget errors onto the right `ExecutionResult` statuses.

## Budgets and layered concurrency

`BudgetTracker` enforces per-run ceilings with typed errors
(`ToolCallBudgetError`, `TokenBudgetError`, `CostBudgetError`,
`WallClockBudgetError`), so runs end as `budget_exhausted` or `timeout`
instead of draining resources silently.

`GateRegistry` generalizes the existing `ConcurrencyGate` into named
scopes. Defaults: global 32, model 8, provider 3, agent 4, tool 4,
workspace 8, domain 1. A crypto agent sets `domain: 1` for trading
execution — strictly serialized by construction.

```ts
await gates.run("domain", "trading-execution", () => placeOrder(spec));
```

## Event families

`RuntimeEvent` remains one union during migration, but `familyOf(event)`
classifies every event as `execution`, `domain`, or `presentation`, and
`filteringSink` lets consumers subscribe to a slice. State projections
read execution events; UI chrome reads presentation events; domain events
describe the world (git, memory, MCP, LSP). This is the seam where the
single bus starts behaving like three families without a breaking rewrite.

## Embedding the kernel

```ts
const agent = new Agent({ config });
const kernel = agent.getKernel();
// kernel.runtime        — agent registry + strategies + gates
// kernel.modelGateway   — capability-routed inference
// kernel.toolGateway    — policy-supervised tool invocation
// kernel.toolCatalog    — what tools exist (with risk metadata)
// kernel.approvalBroker — human-in-the-loop resolver

const runId = agent.startExecutionRun(); // run scope + abort signal
// …agent.runUserMessage("…") as usual…
agent.cancelExecutionRun(); // cooperative cancellation
```

Headless, kernel-native execution (no Agent) works too:

```ts
const ctx = createExecutionContext(request, {
  modelGateway,
  toolGateway,
  events: myEventSink,
  budget: { maxToolCalls: 50, deadlineMs: 120_000 },
});
const result = await new DefaultAgentRuntime().execute(request, ctx);
```

## Migration status

In place: kernel contracts, tool gateway + catalog, policy engine, approval
broker, model gateway + capability registry, gate registry, event
families, ReAct/Plan-Execute strategies, `DefaultAgentRuntime`, pack-based
tool registration, crypto domain pack, and the Agent wiring above.

**Strategy extraction (step 1) is done**: `Agent.runUserMessage` no longer
contains the think→act→observe loop. The kernel's `ReActStrategy` runs the
loop and the Agent supplies product policies through `StrategyHooks`
(`src/kernel/strategies/strategy-hooks.ts`): `selectTools` (dynamic tool
selection + always-on escalation tools), `callModel` (quick→cloud
escalation, streamed output with buffered verification), `onModelUsed`
(usage metering), `prepareToolCall` (tolerant argument parsing + guidance),
`beforeToolCall` (human approvals), `onToolObserved` (observation push,
Rails indexing, `escalate_task` detection, product loop detector),
`onToolFailed` (error telemetry), and `finalAnswer` (streamed transcript
accumulator). The same strategy runs headless with zero hooks, so CLI, TUI,
and embedded products now share one loop implementation. Ownership rule:
when `onToolObserved` is installed, the strategy never pushes tool results
and never runs its own loop detector — the product owns both.

### Evolution Plane (done)

The self-development loop (`src/evolution/`, `ClosedLoopEngine`) now spawns
its agent work through the kernel instead of running a private tool loop
over the raw Provider. Two implementations of the `EngineeringAgentRuntime`
seam exist:

- **`NexumEngineeringAgentRuntime`** (legacy) — a hand-rolled chat loop with
  the propose-only tool protocol; supervised by nothing but its own
  `maxTurns` counter. Kept as the standalone/unsupervised option.
- **`KernelEvolutionAgentRuntime`** (promoted,
  `src/evolution/mutation/kernel-agent-runtime.ts`) — the SAME protocol
  (schemas shared from one vocabulary) as a per-mutation kernel tool pack
  mounted behind a `ToolGateway`, spawned as one `ExecutionRequest` through
  `AgentRuntime.execute`. Every mutation run now gets the kernel's full
  supervision: the agent concurrency gate, budgets (turn budget →
  `maxToolTurns`; optional `maxModelCalls`/deadline ceilings), execution
  events, abort-signal cancellation, and the gateway pipeline
  (validate → policy → concurrency → timeout) on every tool call.

Protocol parity is deliberate: `finish`/`decline` stay terminal (the
`onToolObserved` hook ends the kernel run when either is observed), a
prose-only turn can never terminate the run (the `callModel` hook strips
text-only responses so the kernel's think-nudge fires, matching the legacy
recovery nudge), the turn budget maps onto the legacy error, and queue-time
scope checks share ONE verdict function (`mutationScopeViolation`,
`path-scope.ts`) with the fail-closed re-audit, so the checks cannot drift.
The trust boundary is unchanged — prompt contract → queue-time rejection →
fail-closed re-audit → strategy attribution → executor actual-diff audit —
the kernel adds supervision underneath it, not shortcuts around it.

Remaining lever (in order of leverage):

1. Split packages once the seams have settled (`@nemesis-oss/nexum-core`,
   `-models`, `-tools`, `-mcp`, `-devagent`).

### Control Plane promotion (done)

The Orchestrator (`src/orchestrator/`) now consumes kernel ports instead of
private primitives, so plan execution participates in the same runtime model
as every other work item:

- **Kernel gate registry** — the plan's concurrency gate is derived from the
  `GateRegistry` as `global:control-plane` (`concurrencyLimit` as its
  ceiling), so plan-level parallelism is visible in gate snapshots and obeys
  the layered concurrency model. An explicit `gate` option still wins for
  embedders that bring their own.
- **Kernel event stream** — every ASL step transition is published to an
  optional `EventSink` as a `mission.step` RuntimeEvent (execution family),
  snapshotted at publish time, alongside the legacy `onStepChange` product
  callback.
- **Cooperative cancellation** — `OrchestratorOptions.signal` aborts the
  plan: no new steps are scheduled, queued steps never start, in-flight
  steps unwind through their own signals, and non-terminal steps are marked
  `cancelled` (not `failed` — no cascade, no replan trigger). A step that
  genuinely completed before the abort landed stays `completed`. Rollback is
  skipped on abort and the checkpoint is deliberately kept, so
  `Agent.resumePlannedTask` picks the plan back up. The Agent wires its run
  scope signal into both plan entry points, so run-level cancellation now
  covers the plan loop.
- **Kernel-native delegator** — `RuntimeStepRunner`
  (`src/orchestrator/runtime-step-runner.ts`) implements `StepRunner` by
  projecting a `PlanStep` onto the kernel's `ExecutionRequest` port
  (`task.goal`, orchestration bookkeeping in `task.metadata`) and spawning
  the run through `AgentRuntime.execute`, mapping `ExecutionResult.status`
  onto `StepOutcome`: `completed` → success, `failed`/`timeout` → retryable,
  `cancelled`/`budget_exhausted` → blocking. The CLI keeps `AgentStepRunner`
  (product turns with the full preamble/hooks); kernel-embedded products —
  headless runners, Nexum SDK consumers, future agents — get
  plan execution without importing the CLI product layer.

### Gateway enforcement flip (step 2, done)

The Agent's tool gateway no longer runs in migration mode — it now enforces
the full pipeline with `validation: "strict"` and a `RulePolicyEngine`
posture. Products choose a posture instead of hand-rolling rule chains
(`src/kernel/policy/postures.ts`):

- **parity** (the CLI DevAgent) — arg-aware rules keep the historical UX:
  only destructive shell commands, `git push` / `gh pr create`, and
  `delete_file` ask for confirmation. Financial side effects always ask
  (a tool that moves money can never bypass confirmation) — the paper-trade
  confirmation is the one deliberate UX delta.
- **standard** — every tool at risk ≥ `high` asks first (shell, git,
  github, docker-class surfaces).
- **restricted** — risk ≥ `medium` asks, plus optional deny lists and risk
  ceilings for unattended runners and the crypto agent.

Mechanics: the gateway never blocks on UX. When policy demands
confirmation it returns a structured `ConfirmationRequired` outcome; the
`ReActStrategy` hands it to the `resolveConfirmation` hook — approved calls
re-execute under `confirmed: true`, rejections become `ApprovalRejected`
observations, and headless runs (no hook) feed the structured denial back
to the model as the observation. `ExecutionRequest.mode` /
`ExecutionRequest.unattended` flow through `ExecutionContext` into every
policy decision: read-only modes deny mutating tools via
`ModeRestrictionRule`, and unattended runs bypass confirmations by contract
(deny rules still apply). Approval UX is unchanged — `describeConfirmation`
renders policy outcomes into the same approval requests the pre-kernel
classification produced, and the shared shell-pattern table now lives in
`src/kernel/policy/rules.ts` so policy and UX cannot drift.
