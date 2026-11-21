# Migration Guide — Nexum 2.0.0

> Companion to RELEASE-READINESS.md (release plan) and STABILITY.md
> (stability tiers). This guide covers what changes for consumers who
> adopt the 2.0.0 stable release, relative to the alpha.4 baseline on
> `main` today.
>
> Status: **draft** (2026-11-21). The 2.0.0 cut has not been published yet.
> This guide will be finalized and dated when the 2.0.0 tag is pushed.

## 1. Who this is for

- **New consumers** — installing Nexum as a stable dependency for the first
  time. Start at §2.
- **Alpha adopters** — anyone who pinned `@nemesis-oss/nexum@2.0.0-alpha.4`
  (or `.5`/`beta.1`/`rc.1`) during the preview window. The breaking
  changes you need to act on are in §3.
- **DevAgent-era users** — there were none. `@nemesis-oss/devagent-ts` and
  its predecessor names were never published to npm (verified at the
  registry); the rename carries no migration burden. The `DEVAGENT_*` env
  vars still work with a deprecation warning; see §5.

## 2. Installing 2.0.0

```bash
npm install @nemesis-oss/nexum@2.0.0
# or
npm install @nemesis-oss/nexum        # resolves to latest (2.0.0 stable)
```

During the alpha/beta/rc window (Phases 1–4 in RELEASE-READINESS.md §3),
`npm install @nemesis-oss/nexum` **fails by design** — the package is only
published under the `next` dist-tag, so the bare install resolves to
nothing. The friction is intentional for a developer preview:

```bash
# During the alpha/beta/rc window (until Phase 5):
npm install @nemesis-oss/nexum@next
```

At Phase 5 (2.0.0 stable), the `latest` dist-tag is added and the bare
install works.

### Pin the exact version

```json
// package.json
{
  "dependencies": {
    "@nemesis-oss/nexum": "2.0.0"
  }
}
```

For experimental Tier-2 exports you depend on, pin the exact patch:

```json
"@nemesis-oss/nexum": "2.0.0"
```

For Tier-1 Stable exports only, a caret is safe (semver honored):

```json
"@nemesis-oss/nexum": "^2.0.0"
```

## 3. Breaking changes from the alpha baseline

Two breaking changes shipped in PR #70 (`adeb111` on `main`) before the
first public publish, so they are part of every 2.0.0 release. Both have
clear migration paths.

### 3.1 — Evolution generalization gate: default `optional` → `required`

**Before (alpha.4 and earlier).** The closed-loop evolution engine would
promote a mutation candidate to champion even if it had been validated by
only one executor (e.g. tested only against `ReActStrategy`). The default
`generalizationPolicy` was `"optional"`.

**After (2.0.0).** The default is `"required"` — a candidate must show
real transfer gain on a fixed-executor evidence set before it can be
promoted. The engine records `transferByExecutor` evidence per executor
and computes a real transfer-gain metric; if no usable fixed-executor
evidence is supplied, the candidate is blocked from promotion.

**Why.** The `"optional"` default allowed a mutation to be promoted based
on a single-executor success, which is not evidence of generalization.
This is exactly the failure mode the gate exists to prevent.

**Migration.**

- If you relied on the old default: set
  `generalizationPolicy: "optional"` explicitly in your engine config.
  The setting still exists; only the default changed.
- If you supply fixed-executor evidence already (the recommended path):
  no change needed — the new default matches what you were doing.
- If you don't use the evolution engine: no impact.

```ts
// src/evolution/engine-v2.ts
// this.generalizationPolicy = opts.generalizationPolicy ?? "required";
// Override only if you accept the single-executor risk:
const engine = new EvolutionEngineV2({
  generalizationPolicy: "optional",
  // ...
});
```

### 3.2 — Plugin host: unsandboxed third-party plugins fail-closed by default

**Before (alpha.4 and earlier).** `PluginHost.start()` would start any
registered plugin, including third-party plugins registered via
`registerThirdParty()` that were not loaded through the sandbox.

**After (2.0.0).** `PluginHost` defaults to
`refuseUnsandboxedThirdParty: true`. Third-party plugins must be loaded
through `registerUntrusted()` (which routes them through the sandbox
worker), or the host refuses to start them. The sandbox enforces
`provide` / `lookup` / `declareCapability` against policy allow-lists
plus a provide cap.

**Why.** An unsandboxed third-party plugin runs in-process with full host
capabilities — a single malicious plugin can read every secret, call
every model, mutate every workspace file. The fail-closed default makes
the safe path the default path; opting out is explicit.

**Migration.**

- If you register third-party plugins: load them via
  `registerUntrusted(pluginFile, opts)` instead of `registerThirdParty()`.
  The sandbox handles the worker lifecycle; you supply the policy.
- If you genuinely need in-process third-party plugins (e.g. a trusted
  first-party plugin you control but load as "third-party" for isolation
  reasons): set `refuseUnsandboxedThirdParty: false` explicitly. The
  opt-out is logged so it is auditable.
- If you only register first-party plugins (loaded via `register()`):
  no change needed.

```ts
const host = new PluginHost({
  refuseUnsandboxedThirdParty: true, // default; safe
});

// Safe path — sandboxed:
await host.registerUntrusted("./plugins/my-plugin.mjs", {
  sandbox: {
    provide: ["my:capability"],
    lookup: ["nexum:models:registry"],
    declare: ["my-tag"],
    provideCap: 2,
  },
});

// Explicit opt-out — auditable, not recommended:
const host = new PluginHost({ refuseUnsandboxedThirdParty: false });
host.registerThirdParty(myPlugin);
```

## 4. Stability tiers — what's covered by semver, what isn't

(See STABILITY.md for the authoritative list.)

- **Tier 1 (Stable).** ~40 exports (after the API-freeze additions in this
  branch). Covered by semver: breaking changes require a major version
  bump (3.0). The Tier-1 contract is verified by
  `tests/package-surface.test.ts`, which imports every Tier-1 symbol from
  the built `dist/index.js` and asserts presence + kind. CI runs it after
  `tsc`.
- **Tier 2 (Experimental).** ~50 exports. Functional but their contracts
  may change between minor releases. Pin the exact version if you depend
  on one.
- **Tier 3 (Internal).** Exported for advanced consumers but not part of
  the supported contract. May change without notice.

### What's still experimental at 2.0.0

- `CredentialService` — env + file providers stable; keychain Linux
  round-trip verified nightly by
  `tests/credentials/keychain-linux-roundtrip.test.ts` in the `keychain`
  nightly job; macOS/Windows keychain still experimental; Vault provider
  functional.
- Plugin runtime capability-token enforcement inside the sandbox — the
  layer that would let a host reject a capability claim _after_ setup based
  on observed behavior. The sandbox boundary itself (provide/lookup/
  declare against allow-lists) is enforced; runtime enforcement is not.
- `ProcessSubagentProvider` — spawns real subprocesses via `nexum rpc`.
  Functional but its lifecycle semantics may shift.

## 5. DevAgent-era environment variables

The `DEVAGENT_*` env vars are kept as deprecated aliases for the
`NEXUM_*` canonical names, with a one-line stderr warning the first time
each is read. They will be removed at 3.0 (per REBRANDING.md §7).

| Deprecated (`DEVAGENT_*`) | Canonical (`NEXUM_*`)  | Removed at |
| ------------------------- | ---------------------- | ---------- |
| `DEVAGENT_WORKSPACE`      | `NEXUM_WORKSPACE`      | 3.0        |
| `DEVAGENT_AUTO_APPROVE`   | `NEXUM_AUTO_APPROVE`   | 3.0        |
| `DEVAGENT_TIER`           | `NEXUM_TIER`           | 3.0        |
| `DEVAGENT_MODEL`          | `NEXUM_MODEL`          | 3.0        |
| `DEVAGENT_VERIFIER`       | `NEXUM_VERIFIER`       | 3.0        |
| `DEVAGENT_HEURISTIC_GATE` | `NEXUM_HEURISTIC_GATE` | 3.0        |

The `.devagent/` directory is auto-migrated to `.nexum/` by
`nexum migrate`. The `devagent-sandbox:latest` Docker image tag is still
recognized as a fallback in `src/platform/brand.ts`. Run `nexum migrate`
once after upgrading; it is idempotent.

## 6. Configuration changes

### `autoApprove` default (B1, already shipped)

`autoApprove` defaults to `false` in 2.0.0 (was `true` during early
development). Headless sessions with no approval listener fail-closed
rather than auto-approving destructive operations.

- Interactive UI: prompts before destructive ops.
- Headless / unattended: requires explicit opt-in
  (`autoApprove: true` / `NEXUM_AUTO_APPROVE=true` / `--yolo`).
- The `UnattendedPolicy` defaults to "may execute nothing" and refuses
  host/financial/network/mutation tools unless explicitly permitted.

If you scripted unattended runs expecting the old default, add
`NEXUM_AUTO_APPROVE=true` to the environment.

## 7. Model transport

Nexum's model transport uses `@nemesis-oss/ollama-sdk` (declared in
`package.json` `dependencies`, installed as a runtime dep). The SDK is
the only model-transport dep — provider SDKs (Anthropic, OpenAI, etc.)
are loaded lazily by the model gateway when first used, not declared as
hard runtime deps.

If your local nexum setup uses Ollama, you need nothing extra — the SDK
comes with the package. If you use cloud providers, install the relevant
provider SDK in your consumer project.

## 8. Workspace trust

First run in a new workspace prompts for trust. Trust is stored in
`~/.nexum/trusted-workspaces.json` and bound to the files' exact contents;
any change (e.g. `git pull`) asks again. Until trusted, only `model`,
`theme`, `quickModel`, tool selection, timeouts, `writeScope`, and the
model-routing flags apply from the workspace config; `sandbox`,
`dockerTool`, `dockerEgress`, `autoApprove`, `mcpServers`, `host`,
`tier`, API keys, and `systemPrompt` are ignored, and the workspace `.env`
is not loaded.

Run `nexum trust` (`nexum trust status` to inspect) to manage trust
without the interactive prompt.

## 9. Tool output is now fenced (in-session security hardening)

Tool results — MCP server output, `read_file`, `web_fetch`, `get_doc` —
are now wrapped in a per-call nonce-fenced `<tool_result nonce="...">`
block before they reach the model, and the system prompt explicitly tells
the model that text inside such a fence is untrusted data, never
instructions. See `docs/SECURITY-AUDIT-MCP.md` §6.

**Consumer impact: none for legitimate use.** If you parse the raw
`role:"tool"` message content out-of-band (e.g. for logging, telemetry,
or your own prompt-injection screen), note that the _stored_ transcript
keeps the raw content (`getMessages()`); only the _model-facing_ copy
(`messagesForModel()`) is fenced. If you were string-matching tool
output in tests against the model-facing copy, update your matchers to
account for the fence.

## 10. Gotchas

- **The dist-tag switch.** Until Phase 5, only `@next` is published. The
  bare `npm install @nemesis-oss/nexum` resolves to nothing — by design.
  Use `@next` during the preview window.
- **Native deps.** `better-sqlite3` is the only native runtime dep; it
  ships prebuilt binaries for Linux/macOS/Windows. If a prebuild is missing
  for your platform, npm falls back to `node-gyp` and you'll need a
  compiler toolchain. `esbuild` and `unrs-resolver` are dev-toolchain
  transitive deps; they are NOT runtime requirements (see
  `docs/B6-TARBALL-AUDIT.md` §7).
- **macOS/Windows keychain.** Experimental at 2.0.0. The Linux round-trip
  is verified nightly; macOS/Windows keychain providers exist but their
  round-trip tests are not yet wired into the nightly job. Use env/file
  credential providers on those platforms until Phase 5+.

## 11. Where to report issues

- Bugs: [github.com/shubhamtaywade82/nexum/issues](https://github.com/shubhamtaywade82/nexum/issues)
  (the GitHub org migration is blocked — the `nemesis-oss` name is taken
  by an unrelated user account; see `docs/BRAND-AUDIT.md` §5. A new org
  name must be chosen together with the final brand decision).
- Stability questions: file an issue requesting a Tier-2 → Tier-1
  promotion; we prioritize based on consumer demand (STABILITY.md
  §"How to Depend Safely").
- Security reports: see SECURITY.md §"Reporting a Vulnerability".

## 12. Versioning after 2.0.0

Per STABILITY.md §"Versioning":

- **Major** (2.x → 3.x): breaking changes to Tier-1 Stable exports.
  Also when deprecated `DEVAGENT_*` env aliases are removed.
- **Minor** (2.0 → 2.1): new features; Tier-2 Experimental exports may
  break.
- **Patch** (2.0.0 → 2.0.1): bug fixes only; no API changes.

The Tier-1 list is frozen as of the 2.0.0-rc.1 cut (see STABILITY.md
§"2.0.0 API Freeze"). Additions to Tier 1 land in minor releases and
are announced in the changelog with a "Stability: experimental → stable"
note.
