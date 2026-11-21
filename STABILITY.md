# Nexum API Stability Tiers

> **Status:** Developer Preview. The public API is **not yet** covered by
> a stability guarantee. This document describes the _intended_ tiers
> and marks which subsystems currently belong to each.

Nexum's public API (everything exported from `src/index.ts`) is organized
into three stability tiers. Consumers should depend only on **Stable**
exports in production; **Experimental** exports may break between minor
releases; **Internal** exports are not part of the public contract.

## Tier 1: Stable

These exports have a settled contract and are safe to depend on in
production code. They follow semver: breaking changes require a major
version bump.

- `Agent` — the application-level agent (CLI/TUI composition root)
- `AgentRuntime` (`DefaultAgentRuntime`) — the kernel facade
- `ExecutionStrategy` (`ReActStrategy`, `PlanExecuteStrategy`, `GraphStrategy`)
- `Tool` (`ToolDefinition`, `ToolResult`, `ToolInvocation`)
- `ToolGateway` (`DefaultToolGateway`, `ToolCatalog`)
- `ModelGateway` (`DefaultModelGateway`)
- `PolicyEngine` (`RulePolicyEngine`, `AllowAllPolicyEngine`)
- `ExecutionContext` (`createExecutionContext`)
- `BudgetManager`, `BudgetTracker`
- `ToolPack` (`defineToolPack`, `mountToolPack`)
- `AgentDescriptor` (`devAgentDescriptor`)
- `EventEnvelope`, `ExecutionEvent`
- `CancellationScope`, `CancellationRegistry`
- `GateRegistry`, `ConcurrencyGate`
- Identity primitives (`newRunId`, `newTaskId`, `CorrelationIds`, ...)
- `WorkspaceManager`
- `CliConfig`, `loadConfig`

## Tier 2: Experimental

These exports are functional but their contracts may change between minor
releases. They are suitable for early adopters and contributors, but
**not** for production dependencies without pinning the exact version.

- `PluginHost` (`DefaultPluginHost`, `NexumPlugin`, `PluginManifest`)
- `CapabilityRegistry`, `CapabilityToken` (DI seam)
- `ServiceRegistry`, `ServiceToken`
- `SkillSystem` (and the formal skill provider/loader/catalog/selector/injector)
- `SubagentService` (and all providers: `InProcess`, `Process`, `ACP`, `SDK`, `External`)
- `JobService`
- `CompactionService` (and `TokenEstimator`, `CompactionPolicy`, `SummaryProvider`)
- `SessionQueryService`
- `ContextService` (and built-in context providers)
- `CredentialService` (env + file providers stable; keychain Linux round-trip verified nightly by `tests/credentials/keychain-linux-roundtrip.test.ts` in the `keychain` nightly job — incl. the provider `delete()` method; macOS/Windows keychain still experimental; Vault provider functional with unit coverage)
- `AttachmentStore`
- `WorkflowService`
- `WebhookService`
- `WebService` (and `NodeFetchProvider`, `SimpleWebContentExtractor`, `DuckDuckGoSearchProvider`)
- `RpcServer` (and `registerAllServiceMethods`, `registerCoreMethods`)
- `SettingsService`
- `ProfileRegistry`, `ProfileLoader`, `ProfileComposer`
- `MarketplaceService` (and `HttpMarketplaceSource`, `NpmMarketplaceSource`, `GitMarketplaceSource`)
- `ControlPlaneService`
- `startRpcServer` (the `nexum rpc` entry point)

## Tier 3: Internal

These exports are implementation details and may change without notice.
They are exported for advanced consumers and contributors, but are not
part of the supported API contract.

- `ReplayProjector`, `RunReplay`, `RunRecord`, `ToolInvocationRecord`, ...
- `RUN_STATE_LAYOUT`, `PERSISTENCE_OWNERSHIP`
- `ExecutionRecorder`, `RunRecorder`
- `CorrelationTracker`, `correlationFrom`
- `LoopDetector`
- `IntentResolver`
- `MemoryStore`, `DocsStore`
- All UI components (`src/ui/*`)
- All CLI internals (`src/cli/*` except `rpc.ts`)
- All evolution internals (`src/evolution/*`)
- All domain internals (`src/domains/*`)

## Incomplete Subsystems

These are explicitly **incomplete** and should not be relied on in
production. They may be removed or significantly reworked in any release.

- Plugin runtime capability enforcement — sandbox boundary enforced
  (`src/platform/plugins/sandbox.ts` gates `provide` / `lookup` /
  `declareCapability` against the policy allow-lists + provide cap;
  `src/platform/plugins/host.ts` ships `registerUntrusted` + fail-closed
  `start()` for unsandboxed third-party plugins, default
  `refuseUnsandboxedThirdParty: true`). **Runtime capability-token
  enforcement inside the sandbox** — the layer that would let a host
  reject a capability claim _after_ setup based on observed behavior — is
  still missing.
- `ProcessSubagentProvider` — spawns real subprocesses via `nexum rpc`
  server (wired via `src/cli/rpc.ts`)

## Versioning

Nexum follows a modified semver:

- **Major** (2.x → 3.x): breaking changes to Stable exports.
- **Minor** (2.0 → 2.1): new features; Experimental exports may break.
- **Patch** (2.0.0 → 2.0.1): bug fixes only; no API changes.

Until the Stable tier is finalized (target: 2.0.0 stable), all exports
should be treated as Experimental.

## 2.0.0 API Freeze (Phase 4 / RC gate)

The Tier 1 list above is the **frozen contract** as of the 2.0.0-rc.1 cut.
After the RC tag, no breaking change to any Tier 1 export lands before
3.0 — additions are allowed (minor), bug fixes are allowed (patch),
removals and signature changes are not.

**Freeze audit:** `docs/API-FREEZE-AUDIT.md` (dated 2026-11-21). Audit
verdict: **CONDITIONAL** — 29 of 40 Tier-1 symbols have a direct contract
test; 2 are referenced only incidentally; 9 have no test reference at all
(see the audit doc for the per-symbol breakdown and the path-to-PASS).

**Known gaps deferred to the RC PR (not blockers for alpha.5/beta.1):**

1. `defineToolPack` has zero test references — every test builds packs
   ad-hoc via the concrete pack constructors. Add a smoke test.
2. The `ToolResult` and `ToolInvocation` type aliases are not directly
   asserted; they are exercised only at call sites. Add `satisfies`
   type assertions or demote.
3. `EventEnvelope` and `CorrelationIds` are documented Tier 1 but no test
   imports them by name. Same fix.
4. **Structural gap — CLOSED in this branch:** every test previously
   imported from a deep `../../src/...` path, so removing a symbol from
   `src/index.ts` would not fail any test (the B6 tarball audit caught
   exactly this with 8 Tier-1 symbols). `tests/package-surface.test.ts`
   now imports from the built `dist/index.js` — the same path an npm
   consumer uses — and asserts every Tier-1 runtime symbol is present
   with the expected kind. It runs in CI after `tsc`.

**Promotion candidates** (Tier 2 → Tier 1, see audit doc): `Task`,
`ExecutionRequest`, `ExecutionResult`, `ExecutionEventStore`,
`ExecutionRecorder`, `DevAgent`, `WorkspaceGuard`, `PathEscapeError`,
`SensitivePathError`, `CriticService`, `VerifierService`,
`budgetForProfile`, `contentHash`, `NexumRun`. Each has ≥3 test-file
references and a stable contract; promotions land in the RC PR.

## Migration Path

When an Experimental export is promoted to Stable, it will be announced
in the changelog with a "Stability: experimental → stable" note. When
an Experimental export is removed or significantly reworked, it will be
announced with a "Breaking change" note and a migration guide.

## How to Depend Safely

For production use:

1. Pin the exact version (`"dependencies": { "@nemesis-oss/nexum": "2.0.0-alpha.5" }`).
2. Only import from Tier 1 (Stable).
3. Subscribe to the changelog for Experimental → Stable promotions.
4. If you need an Experimental export, file an issue requesting promotion
   to Stable — we prioritize based on consumer demand.

For early adoption / contribution:

1. Pin to a minor version (`"@nemesis-oss/nexum": "~2.0.0-alpha.5"`).
2. Feel free to import from Tier 2 (Experimental).
3. Report breakage in issues — we'll either fix or document the migration.

For internal Nexum development:

1. Tier 3 (Internal) is fair game.
2. When promoting an Internal export to Experimental or Stable, update
   this document and the changelog.
