# Nexum Production Readiness Audit

_Date: 2026-09-28_
_Scope: `main` branch, including the latest security/trust work (plugin sandbox, evolution loop, subagents, filesystem boundary, web layer, credentials, CI/release setup, and documentation)._

## Bottom line

Nexum has moved substantially forward since the previous review. The core kernel, ToolGateway, policy engine, checkpointing, LSP, MCP, evolution loop, publisher signing, capability attestation, credential providers, and TUI are no longer the main problem.

The remaining problem is **integration integrity**: several subsystems are implemented as impressive standalone modules but are not yet wired into a single coherent production contract.

Current classification:

| Area | Current state |
|---|---|
| Core agent runtime | Strong |
| Tool execution/security pipeline | Strong, but filesystem boundary is fragmented |
| TUI | Strong implementation, stale spec |
| Evolution/self-development | Advanced, but measurement has integrity gaps |
| Marketplace | Partially productionized; activation path incomplete |
| Plugin security | Improved significantly, but worker isolation is not a true security sandbox |
| Subagents | Major unfinished area |
| Credentials | Implemented, but contains real scoping/platform bugs |
| Web access | Functional, security hardening incomplete |
| Webhooks | Functional, replay protection incomplete |
| Public package/release hygiene | Not ready |
| Documentation consistency | Definitely not ready |

---

## P0 — fix before calling Nexum production/public-ready

### 1. Subagent providers are still partially fake

This is the largest remaining implementation gap.

**SDKSubagentProvider** creates a runtime, but execution is explicitly simulated:

```
// Real impl: invoke runtime.execute().
return {
  ...
  output: `[sdk:${subagentId}] processed: ${message}`,
};
```

The one-shot path similarly just waits 10ms and fabricates completion. The API claims a "fresh isolated Nexum SDK per subagent," but the provider does not execute the runtime.

**ExternalAgentSubagentProvider** is even clearer:

```
// Real impl: write to child process stdin.
```
```
// Real impl: SIGTERM the child process.
```
```
// We simulate completion
```

`binaryPath`, `cwd`, `extraArgs`, and `apiKey` are not actually used to spawn or control an external agent.

**ACPSubagentProvider** is functional only at the most minimal HTTP level. Its own documentation admits it does not implement protocol handshake, capabilities, streaming, or proper cancellation semantics.

**`defaultSubagentProviders()`** registers `in-process`, `process`, `acp`, `sdk`, and `external` as though all five are available. But ACP has no endpoint by default, SDK has no runtime factory by default, and External is effectively simulated. The capability catalog can therefore advertise providers that aren't actually executable.

**Required fix:** make provider state explicit — `AVAILABLE`, `DEGRADED`, `UNCONFIGURED`, `UNSUPPORTED` — and do not advertise a provider as executable unless its dependencies are actually wired.

**Priority: P0**

---

### 2. Marketplace is not an end-to-end plugin system yet

The marketplace pipeline (catalog → signature verification → publisher trust → sha256 → install record) is much better now, but currently ends at:

```
.nexum/plugins/cache/foo@1.0.0/plugin.tar.gz
```

`MarketplaceService.install()` downloads and verifies the artifact, but there is no production path connecting:

```
Marketplace → extract → manifest validation → dependency resolution → sandbox selection → PluginHost.register() → PluginHost.start()
```

Marketplace currently behaves more like a verified artifact cache than a complete plugin marketplace.

**Required architecture:**

```
Marketplace
   -> Resolve exact artifact
   -> Verify publisher signature
   -> Verify artifact digest
   -> Extract into immutable version dir
   -> Validate manifest
   -> Resolve dependencies
   -> Choose execution isolation
       - trusted -> process/in-process
       - untrusted -> container/process sandbox
   -> Register
   -> Start
   -> Health-check
```

**Priority: P0**

---

### 3. NPM marketplace has a real version-selection bug

`NpmMarketplaceSource.download()` fetches the package packument and effectively chooses:

```
const version = packument["dist-tags"]?.latest ?? entry.version;
```

That is wrong for an explicit version install. If the catalog selected `foo@1.4.0` but npm's `latest` is `foo@1.5.0`, the downloader can fetch `1.5.0`. With a digest, verification may catch it; without one, the wrong version installs silently.

The installer must download `entry.version` and verify the actual downloaded version against the requested version.

**Priority: P0**

---

### 4. Plugin `worker_threads` isolation is not a security boundary

The new plugin sandbox work is a major improvement, but the terminology needs tightening. `IsolatedPluginSandbox` uses `worker_threads`, which provides a separate JS isolate, resource limits, message boundary, and lifecycle control — but **not** true OS-level isolation. Plugin code can still potentially access the filesystem, network, `process.env`, Node built-ins, native modules, and any host resources permitted to the process.

Worker ≠ hostile-code sandbox. It is isolation from host JS objects, not isolation from host privileges.

**Production model should be:**

```
Trusted plugin       -> in-process
Semi-trusted plugin   -> worker / process
Untrusted plugin      -> OS/container sandbox
                          (network policy, filesystem policy,
                           CPU/memory/PID limits, credentials boundary)
```

The current worker tier should be described as process-context isolation / execution isolation, not container-equivalent sandboxing.

**Priority: P0 for the security model**

---

### 5. Plugin sandbox is opt-in, not actually integrated with PluginHost

`DefaultPluginHost.register()` still accepts a raw plugin (`host.register(plugin)`) and executes it directly. The host does not automatically select the sandbox based on publisher trust, manifest, capabilities, plugin source, or execution profile. The secure path depends on the caller remembering to call `sandboxPlugin(plugin, policy)` — too easy to bypass.

**Better:** `host.install(plugin, trustContext)`, which internally routes trusted → direct, community → policy sandbox, unknown → isolated process/container. Security should be a host decision, not a caller convention.

**Priority: P0**

---

### 6. Filesystem isolation is still fragmented

`WorkspaceGuard` is excellent, and the filesystem pack uses it:

```
const guard = new WorkspaceGuard({ root });
const editor = new CasEditor({ guard });
```

But many other tools still call `resolveWorkspacePath()` directly instead: `ReadFileTool`, `WriteFileTool`, `WatchTool`, `BackupTool`, directory tools, search tools, database tools, LSP tools, legacy edit tools. Documentation says the guard is the centralized filesystem boundary, but only part of the filesystem surface actually uses it — `resolveWorkspacePath()` does not enforce the same semantics (`writeScope`, operation-specific verdicts, centralized security policy).

This matters most for the evolution system, which can restrict mutation scope (candidate worktree → allowed mutation paths), but normal filesystem tools aren't universally consuming the same write-scope abstraction. The actual-diff audit catches some problems after the fact; prevention should happen at the filesystem boundary.

**Priority: P0/P1**

---

## P1 — serious correctness/security gaps

### 7. Credential scoping is currently broken

The contract says `CredentialScope.tags` means "only credentials matching ALL of these tags are visible." `ScopedCredentialService` only checks `this.scope.names` — it does not enforce `scope.tags`. So `service.scope({ tags: ["trading"], names: [] })` does not actually constrain anything.

Also `CredentialService.defaultScope` is stored but never enforced. Two scope-contract gaps: `defaultScope` unused, `tags` unused.

**Priority: P1**

### 8. Linux keychain write path is probably incorrect

The Linux implementation invokes `secret-tool store ...`, but the executor abstraction only supports `exec(command, args)` — there is no stdin/secret input channel, and `secret-tool store` normally expects the secret via stdin. The read side is reasonable; the write side is not equivalent to the macOS implementation. Current tests validate the abstraction, not a real round-trip. Needed: a Linux integration test that proves `set()` → `resolve()` → same secret.

**Priority: P1**

### 9. Web fetch has an SSRF/resource-exhaustion problem

`NodeFetchProvider` does `fetch(url, { redirect: "follow" })` then `await response.text()` with no maximum response size, IP/private-network restriction, redirect destination validation, DNS rebinding protection, or URL scheme policy beyond whatever `fetch()` allows. An agent with web access can potentially reach `localhost`, `127.0.0.1`, RFC1918 ranges, link-local addresses, and cloud metadata endpoints, and can download arbitrarily large content into memory. `PolicyEngine` is a tool-level control, not a network security boundary.

**Production web policy should include:** URL policy, IP policy, redirect policy, response-size limit, timeout, content-type limit, optional domain allowlist — and ideally network access for untrusted workloads should run outside the trusted host process.

**Priority: P1**

### 10. Browser isolation is similarly too weak for untrusted browsing

`BrowserManager` launches Chromium directly with no automatic container, network namespace, credential isolation, domain policy, or download restriction. Fine for a trusted local coding assistant; not equivalent to a secure remote/untrusted browsing sandbox.

**Priority: P1**

### 11. Webhooks still permit replay within the timestamp window

Webhook verification has HMAC + timestamp freshness, which is good, but timestamp freshness is not replay prevention — a captured valid request can be replayed repeatedly inside the freshness window. Dangerous if a webhook can trigger a trade, deploy, GitHub mutation, agent task, or external API mutation. Needed: event nonce/provider event ID + deduplication store + TTL, or a payload-hash replay cache.

**Priority: P1**

### 12. SubagentService has a concurrency accounting bug

`spawn()` increments `activeCount++`, and one-shot promises decrement it on completion — but `cancel()` also decrements `activeCount`, creating a possible double decrement (spawn +1, cancel -1, promise finally -1 again). The clamp to zero hides the symptom but can cause the service to believe capacity is available when it isn't. Use one ownership path for lifecycle accounting.

**Priority: P1**

### 13. Evolution metrics are not yet scientifically trustworthy

In `metricsFromExperimentStore()`: `transferGain: r.metrics.generalization` treats transfer and generalization as the same measurement. `executorSensitivity: 0` is recorded outright. Experience correlation is reconstructed from `heldOutGain` rather than actual prior-experience confidence. The CLI can present "transfer gain," "executor sensitivity," and "experience → improvement correlation" without having actually measured those quantities — a serious issue given the evolution plane's premise is evidence-grounded self-development. The system must never manufacture a measurement merely because the report schema expects one.

**Priority: P1**

### 14. Evaluation observations lose actual token usage

`observeExecution()` currently converts `model.answered` into `promptTokens: 0, completionTokens: 0` even though the real agent has usage data elsewhere. Evaluation metrics such as `run.tokens`, cost, and efficiency can become meaningless when using event-derived observations. Fix at the event-contract level (`model.answered` should carry `model, tier, promptTokens, completionTokens, latency`), and have evaluation consume the same source of truth as runtime accounting.

**Priority: P1**

---

## P1/P2 — documentation and product-contract drift

### 15. SECURITY.md is materially stale

Still says Plugin Marketplace / Plugin Runtime "INCOMPLETE," publisher authenticity "missing," plugin sandbox "missing," keychain/Vault "incomplete." None of that describes current `main`, which now has publisher signatures, trust store, install policies, plugin policy sandbox, worker isolation, capability attestations, revocation, keychain implementation, Vault implementation, and a security CLI. The threat model must be rewritten around the actual architecture.

### 16. STABILITY.md is stale

Still lists `KeychainCredentialProvider`, `VaultCredentialProvider`, plugin sandbox isolation, and npm/git signatures as "not implemented" — all obsolete. Also still references `2.0.0-alpha.1` while the current package is `2.0.0-alpha.2`. Actively misleading to consumers.

### 17. QUICKSTART.md is stale

Installs `npm install -g @nemesis-oss/nexum@2.0.0-alpha.1` while current is `alpha.2`, and describes some plugin/security functionality as incomplete when much of it has since landed. Fix before the next release.

### 18. docs/SPEC.md is badly out of sync with the implementation

Probably the biggest documentation inconsistency. Still describes `src/tui/`, `src/tui/zones/`, `src/layout/`, while the actual implementation is `src/ui/`, `src/ui/layout/`, `src/ui/views/`, `src/runtime/events/bus.ts`. Says roughly 8 main views; the runtime currently exposes 15, including `lsp`, `files`, `settings`, `context`, `rails`, `timeline`, `dashboard`. The old spec's fixed UI assumptions no longer match the current dashboard/sidebar architecture. Either rewrite it against the current architecture or explicitly archive it as a historical design document — at present it is neither, and should not keep being called "frozen."

**Priority: P1**

### 19. Stale `src/tui` references in actual source comments

Examples: `src/runtime/types.ts`, `src/ui/ui/theme-registry.ts`, `src/interaction/picker.ts`, `scripts/vendor-termcn.mjs`. These are source-level architectural breadcrumbs pointing to directories that don't exist. Clean these globally.

---

## Release / OSS readiness

### 20. Current main is ahead of the published package

Security/trust commits exist after the `2.0.0-alpha.2` release, so published `alpha.2` and `main` (`alpha.2` + significant new functionality) have diverged. The next release should be deliberate — `2.0.0-alpha.3` or a move toward the actual stable milestone — not a moving `alpha.2`.

### 21. GitHub release metadata needs cleanup

The alpha release is presented as a regular GitHub release rather than clearly as a pre-release. For a package still declaring `2.0.0-alpha.*`, the release presentation should make that status unambiguous.

### 22. Main branch protection is missing

At minimum: PR required, CI required, branch up-to-date requirement, no force push, no direct push. Then make release branches/tags controlled.

### 23. Security CI is still too thin

Current CI covers lint, format, build, tests, docs, package check. Missing dedicated security automation: CodeQL, dependency review, secret scanning, dependency updates, npm/package provenance validation, supply-chain checks. Especially relevant because Nexum intentionally executes shell, MCP, browser, plugins, GitHub, credentials, and web workloads — a much larger attack surface than a normal TypeScript library.

### 24. Network tests are excluded from normal CI

`SKIP_NETWORK_TESTS=true` is sensible for deterministic PR CI, but there needs to be a second integration lane:

```
PR CI            -> fast deterministic suite
Nightly/release   -> Docker, Playwright, MCP, LSP, web,
                     keychain adapters, package installation,
                     real npm artifact
```

Otherwise many of Nexum's most important integrations are only compile-tested or mocked.

### 25. Package smoke testing is still too shallow

`package:check` proves `npm pack → install → CLI exists → basic imports exist`, but doesn't comprehensively exercise all advertised package subpaths. Given the number of exports in `src/index.ts`, add an automated public-API matrix covering all exported subpaths, all stable exports, CLI startup, CLI doctor, CLI `--help`, `nexum rpc`, plugin loading, and the MCP adapter.

### 26. Root repository contains obvious junk

`index.html` is a "Flappy Bird Clone" with `style.css`/`script.js` unrelated to Nexum — obvious repository contamination, should simply be deleted. Also review `scratch/` for things that should become tests/examples or disappear. Public repositories lose credibility quickly when leftovers like this remain.

**Priority: P1 cleanup**

### 27. Package/repository metadata should be reconciled

The repository being developed is `shubhamtaywade82/nexum`, while package metadata points to `nemesis-oss/nexum`. May be intentional ahead of an org transition, but must be definitively reconciled before a public release — `repository`, `homepage`, `bugs`, README links, CLI user-agent, documentation links, npm package metadata, and GitHub organization should all resolve consistently.

### 28. Changelog/version discipline needs tightening

`Unreleased` contains a huge amount of new evolution/security functionality — good for documentation, but the project now needs tighter release discipline: feature merged → changelog entry → version bump → release notes → tag → package publish → docs version/status update. At present, code state, docs state, package state, and release state are not synchronized.

---

## Architectural note: "security through policy" vs. "security through isolation"

This distinction should become a first-class Nexum design principle. `PolicyEngine`, `WorkspaceGuard`, `ToolGateway`, MCP trust, plugin sandbox policy, capability attestation, worker isolation, and Docker sandbox all do different jobs, but the boundaries aren't yet perfectly clean. The final architecture should explicitly define:

```
AUTHORIZATION    "May this actor invoke this capability?"
ISOLATION        "What can the code physically access?"
INTEGRITY        "Was this artifact altered?"
ATTESTATION      "Who authorized this capability?"
AUDIT            "What happened?"
RESOURCE CONTROL "How much can it consume?"
REVOCATION       "Can previously granted authority be withdrawn?"
```

Right now some of these mechanisms overlap conceptually, especially around plugins and capabilities.

---

## What to do next

The remaining work collapses into six engineering tracks:

**Track 1 — Make every advertised subagent provider real**
```
Subagent
+- InProcess
+- Process
+- SDK        (real)
+- ACP        (real protocol)
+- External   (real process adapter)
```

**Track 2 — Finish the secure plugin lifecycle**
```
Marketplace -> verify -> extract -> inspect -> dependency resolve
            -> sandbox -> register -> start -> health -> revoke -> uninstall
```

**Track 3 — Unify security boundaries**
```
ToolGateway -> WorkspaceGuard -> network policy -> process/container policy
```
No parallel legacy security paths.

**Track 4 — Fix evidence integrity**
Real token usage, real transfer metrics, real executor sensitivity, real experience confidence, real held-out evaluation. No synthetic values in scientific reports.

**Track 5 — Rewrite the public contract**
Update README, QUICKSTART, SECURITY, STABILITY, SPEC, CHANGELOG against the actual current architecture.

**Track 6 — Public-release hardening**
Main branch protection, security CI, nightly integration suite, package API matrix, release automation, repo cleanup, metadata reconciliation.

---

## Assessment

The important change from the previous review is that Nexum is no longer missing huge architectural subsystems — a surprisingly broad platform has already been built. The remaining problem is more dangerous in a different way: several surfaces now look production-grade from their APIs and documentation while the end-to-end execution path is still partial.

The biggest examples:

- SDK subagents — simulated
- External agents — simulated
- ACP — minimal protocol adapter
- Marketplace — verified artifact cache, not full lifecycle
- Plugin worker isolation — isolation, not hostile-code security boundary
- Filesystem — centralized guard only partially adopted
- Evolution metrics — some reported values aren't actually measured
- Web fetch — no SSRF/resource boundary
- Webhook — no replay deduplication
- Docs — several generations behind implementation

These are the items to attack before adding more features. Adding another large subsystem now would increase surface area faster than the reliability of the existing one.
