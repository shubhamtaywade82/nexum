# API Freeze Audit — Tier 1 Test Coverage

> Phase 4 (RC) gate — RELEASE-READINESS.md §3 + STABILITY.md
> Audit date: 2026-11-21
> Auditor: automated (z.ai agent)

## 1. Audit scope and method

Every symbol listed in STABILITY.md §"Tier 1: Stable" was checked against
the `tests/` tree for (a) a direct import of the symbol, and (b) a test
that asserts its shape or behavior (not just incidental use). The package
entry (`src/index.ts`) was also scanned for stable-looking exports not
yet in the Tier 1 list (promotion candidates).

**Headline result:** 29 ✅ contract-asserted · 2 ⚠️ incidentally
referenced · 9 ❌ no test reference at all. Additionally, a structural
caveat applied to every symbol equally (see §3) — now closed in this
branch by `tests/package-surface.test.ts`.

## 2. Findings inventory

| Export                        | Source file                             | Direct test file(s)                                             | Contract assertion? | Notes                                                          |
| ----------------------------- | --------------------------------------- | --------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `Agent`                       | `src/cli/agent.ts`                      | tests/cli/agent-wiring.test.ts + several                        | ✅                  | behavioral tests cover routing, budget wiring                  |
| `AgentRuntime` (type)         | `src/core/types.ts`                     | tests/core/agent-runtime.test.ts                                | ✅                  | via `DefaultAgentRuntime`                                      |
| `DefaultAgentRuntime`         | `src/runtime/index.ts`                  | tests/core/agent-runtime.test.ts                                | ✅                  | elide/stub/lastAssistantText contracts                         |
| `ExecutionStrategy` (type)    | `src/core/types.ts`                     | —                                                               | ❌                  | type alias; exercised only via concrete strategies             |
| `ReActStrategy`               | `src/runtime/strategies/`               | tests/core/strategy-hooks.test.ts, enforcement-flip.test.ts     | ✅                  | hook + enforcement contracts                                   |
| `PlanExecuteStrategy`         | `src/runtime/strategies/`               | tests/contract/mcp-delegation-trading.contract.test.ts          | ⚠️                  | only via registry `names()` containing `"plan_execute"`        |
| `GraphStrategy`               | `src/runtime/strategies/`               | tests/contract/mcp-delegation-trading.contract.test.ts          | ⚠️                  | only via registry `names()` containing `"graph"`               |
| `Tool` (type)                 | `src/core/tools/tool-contract.ts`       | 13 files                                                        | ✅                  | widely asserted                                                |
| `ToolDefinition` (type)       | `src/core/tools/`                       | 13 files                                                        | ✅                  |                                                                |
| `ToolResult` (type)           | `src/core/types.ts`                     | —                                                               | ❌                  | exercised at call sites only                                   |
| `ToolInvocation` (type)       | `src/core/types.ts`                     | —                                                               | ❌                  | exercised at call sites only                                   |
| `DefaultToolGateway`          | `src/tools/gateway/tool-gateway.ts`     | tests/tools/                                                    | ✅                  |                                                                |
| `ToolCatalog`                 | `src/tools/gateway/tool-catalog.ts`     | tests/tools/                                                    | ✅                  |                                                                |
| `ModelGateway` (type)         | `src/models/gateway/model-gateway.ts`   | tests/models/                                                   | ✅                  | via `DefaultModelGateway`                                      |
| `DefaultModelGateway`         | `src/models/gateway/model-gateway.ts`   | tests/models/route-fallback.test.ts                             | ✅                  |                                                                |
| `RulePolicyEngine`            | `src/core/policy/policy-engine.ts`      | tests/core/                                                     | ✅                  |                                                                |
| `AllowAllPolicyEngine`        | `src/core/policy/policy-engine.ts`      | tests/core/                                                     | ✅                  |                                                                |
| `PolicyEngine` (type)         | `src/core/policy/policy-engine.ts`      | tests/core/                                                     | ✅                  |                                                                |
| `createExecutionContext`      | `src/runtime/context/`                  | tests/core/                                                     | ✅                  |                                                                |
| `BudgetManager`               | `src/core/`                             | tests/contract/persistence-budget-cancellation.contract.test.ts | ✅                  |                                                                |
| `BudgetTracker`               | `src/core/`                             | tests/contract/persistence-budget-cancellation.contract.test.ts | ✅                  |                                                                |
| `ToolPack` (type)             | `src/tools/gateway/tool-pack.ts`        | —                                                               | ❌                  | exercised via mountToolPack only                               |
| `defineToolPack`              | `src/tools/gateway/tool-pack.ts`        | —                                                               | ❌                  | zero test references — tests build packs ad-hoc                |
| `mountToolPack`               | `src/tools/gateway/tool-pack.ts`        | tests/tools/                                                    | ✅                  |                                                                |
| `AgentDescriptor` (interface) | `src/agents/`                           | —                                                               | ❌                  | `devAgentDescriptor` value is referenced; the interface is not |
| `devAgentDescriptor`          | `src/agents/`                           | tests/agents/                                                   | ✅                  |                                                                |
| `EventEnvelope` (type)        | `src/host/`                             | —                                                               | ❌                  | persistence behavior tested, named type not asserted           |
| `newRunId`                    | `src/core/identity.ts`                  | tests/package-surface.test.ts                                   | ✅                  | presence pinned (this branch)                                  |
| `newTaskId`                   | `src/core/identity.ts`                  | —                                                               | ❌                  | presence pinned by package-surface test; no behavior test      |
| `CorrelationIds` (type)       | `src/core/identity.ts`                  | —                                                               | ❌                  |                                                                |
| `CancellationScope`           | `src/core/cancellation/cancellation.ts` | tests/core/                                                     | ✅                  |                                                                |
| `CancellationRegistry`        | `src/core/cancellation/cancellation.ts` | tests/core/                                                     | ✅                  |                                                                |
| `GateRegistry`                | `src/core/concurrency/gate-registry.ts` | tests/core/                                                     | ✅                  |                                                                |
| `ConcurrencyGate`             | `src/core/concurrency/gate.ts`          | tests/core/                                                     | ✅                  |                                                                |
| `WorkspaceManager`            | `src/platform/workspace.ts`             | tests/platform/                                                 | ✅                  |                                                                |
| `WorkspaceGuard`              | `src/core/fs/workspace-guard.ts`        | tests/core/                                                     | ✅                  |                                                                |
| `CliConfig` (type)            | `src/cli/config.ts`                     | tests/cli/                                                      | ✅                  |                                                                |
| `loadConfig`                  | `src/cli/config.ts`                     | tests/cli/config*.test.ts                                       | ✅                  |                                                                |
| `startRpcServer`              | `src/cli/rpc.ts`                        | tests/cli/rpc*.test.ts                                          | ✅                  |                                                                |

## 3. Structural caveat (CLOSED in this branch)

**Pre-fix state:** no test imported from the package root
`@nemesis-oss/nexum` or any subpath export — every test imported from a
deep relative path (`../../src/...`). Therefore removing any symbol from
`src/index.ts` alone would not break any test. The public-surface
re-export was structurally unverified, and the B6 tarball audit proved
the failure mode was real: 8 Tier-1 symbols (`WorkspaceManager`,
`CancellationScope`, `CancellationRegistry`, `GateRegistry`,
`ConcurrencyGate`, `newRunId`, `newTaskId`, `loadConfig`) were defined
and used internally but never re-exported, so consumers got `undefined`
while every internal test passed.

**Fix (this branch):** `tests/package-surface.test.ts` imports from the
built `dist/index.js` and asserts (a) every Tier-1 runtime symbol is
present, (b) each has the expected kind (function/object), and (c) a
regression floor on total export count. It runs in CI after `tsc`.
The 8 missing exports were re-exported from `src/index.ts` (runtime
export count 290 → 298).

## 4. Open gaps and recommended actions

| Symbol(s)                                                                                        | Gap                                       | Recommended action                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `defineToolPack`                                                                                 | zero test references                      | add a smoke test that builds a pack via the factory and mounts it    |
| `ToolResult`, `ToolInvocation`, `ToolPack`, `AgentDescriptor`, `EventEnvelope`, `CorrelationIds` | type aliases exercised only at call sites | add `satisfies` type assertions, or demote to Tier 2 in STABILITY.md |
| `ExecutionStrategy` (type)                                                                       | exercised via concrete strategies only    | direct import + `satisfies` check                                    |
| `PlanExecuteStrategy`, `GraphStrategy`                                                           | verified only via registry names          | direct construction test (a class rename would not be caught)        |
| `newTaskId`                                                                                      | presence pinned; no behavior test         | one-line behavior test (prefix + uniqueness)                         |

## 5. Promotion candidates (Tier 2 → Tier 1)

Exports with ≥3 test-file references and a stable contract, not yet
documented Tier 1: `Task`, `ExecutionRequest`, `ExecutionResult`,
`ExecutionEventStore`, `ExecutionRecorder`, `DevAgent`, `WorkspaceGuard`,
`PathEscapeError`, `SensitivePathError`, `CriticService`, `VerifierService`,
`budgetForProfile`, `contentHash`, `NexumRun`.

## 6. Phase 4 (RC) API Freeze Verdict

**CONDITIONAL.**

The structural prerequisite is closed (§3), and 29 of 40 Tier-1 symbols
have direct contract tests. But per the audit's own definition, the freeze
cannot be declared PASS while 9 symbols have no test reference at all and
2 are only incidentally referenced — a freeze is only as strong as the
tests that enforce it. Path to PASS: resolve every ❌ and ⚠️ row in §4
(add a contract test or formally demote the symbol), then update the
STABILITY.md "2.0.0 API Freeze" verdict line.

This is not a blocker for alpha.5 or beta.1 — only for the rc.1 cut.
