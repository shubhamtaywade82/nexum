# Nexum API Stability Tiers

> **Status:** Developer Preview. The public API is **not yet** covered by
> a stability guarantee. This document describes the *intended* tiers
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
- `CredentialService` (env + file providers; keychain + vault are **INCOMPLETE**)
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

- `KeychainCredentialProvider` — throws "not yet implemented"
- `VaultCredentialProvider` — throws "not yet implemented"
- `NpmMarketplaceSource` discovery scope — works but lacks publisher
  authenticity / signature verification
- `GitMarketplaceSource` download — works but no signature verification
- Plugin runtime capability enforcement — not yet implemented
- Plugin sandbox isolation — not yet implemented
- `ProcessSubagentProvider` — spawns real subprocesses but requires a
  working `nexum rpc` server (now wired up via `src/cli/rpc.ts`)

## Versioning

Nexum follows a modified semver:

- **Major** (2.x → 3.x): breaking changes to Stable exports.
- **Minor** (2.0 → 2.1): new features; Experimental exports may break.
- **Patch** (2.0.0 → 2.0.1): bug fixes only; no API changes.

Until the Stable tier is finalized (target: 2.0.0 stable), all exports
should be treated as Experimental.

## Migration Path

When an Experimental export is promoted to Stable, it will be announced
in the changelog with a "Stability: experimental → stable" note. When
an Experimental export is removed or significantly reworked, it will be
announced with a "Breaking change" note and a migration guide.

## How to Depend Safely

For production use:

1. Pin the exact version (`"dependencies": { "@nemesis-oss/nexum": "2.0.0-alpha.1" }`).
2. Only import from Tier 1 (Stable).
3. Subscribe to the changelog for Experimental → Stable promotions.
4. If you need an Experimental export, file an issue requesting promotion
   to Stable — we prioritize based on consumer demand.

For early adoption / contribution:

1. Pin to a minor version (`"@nemesis-oss/nexum": "~2.0.0-alpha.1"`).
2. Feel free to import from Tier 2 (Experimental).
3. Report breakage in issues — we'll either fix or document the migration.

For internal Nexum development:

1. Tier 3 (Internal) is fair game.
2. When promoting an Internal export to Experimental or Stable, update
   this document and the changelog.
