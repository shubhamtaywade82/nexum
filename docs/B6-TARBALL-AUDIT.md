# B6 Tarball & Clean-Install Audit — 2026-11-21

> RELEASE-READINESS.md §B6 gate. Audit run against `main @ adeb111` + the
> in-progress `fix/release-blockers-b3-oidc-audits` branch (re-verified
> after the branch was recreated; all numbers below are from the re-run).

## 1. Tarball contents

- **Tarball:** `nemesis-oss-nexum-2.0.0-alpha.4.tgz`
- **Package size:** 1.4 MB
- **Unpacked size:** 4.9 MB
- **Total files:** 1,272
- **Files allowlist honored:** `dist/`, `bin/`, `docker/nexum-sandbox/`,
  `.env.example`, `config.example.jsonc`, `README.md`, `LICENSE`.
  (matches `package.json` `files` allowlist)

## 2. Sensitive-file scan

Ran a regex scan over every path in the packed tarball for `.env*`,
`.pem`/`.key`/`.p12`/`.pfx`, `token|secret|credential`, `tests/`,
`.git/`, `.log`/`core`/`.dump`, `node_modules/`, OS junk.

**Result: clean.** No actual secrets, private keys, test fixtures, git
metadata, logs, cores, or `node_modules/` shipped. `.env.example` is
correctly included (it is the configuration template, not a real env
file).

The 10 path-name hits for `token|secret|credential` are all legitimate
code modules, not actual secrets:

| Path                                     | What it is                                              |
| ---------------------------------------- | ------------------------------------------------------- |
| `dist/credentials/index.{d.ts,js}`       | `CredentialService` (env/file/keychain/vault providers) |
| `dist/host/server-token.{d.ts,js}`       | `ServerToken` (host-side auth token type)               |
| `dist/ui/layout/status-tokens.{d.ts,js}` | UI status-line tokens (display)                         |
| `dist/ui/ui/token-usage.{d.ts,js}`       | UI usage display                                        |
| `dist/ui/zones/TokenLine.{d.ts,js}`      | UI token-line rendering                                 |

**Verdict:** no credentials, no unintended files. Tarball content audit
passes.

## 3. Clean-room install

Fresh `/tmp` directory, `npm init -y`, install from the produced tarball.

- 234 packages installed in 24s; `better-sqlite3@12.11.1` prebuilt binary
  installed cleanly (Linux x64) — the only native runtime dep.
- `@nemesis-oss/ollama-sdk`, `@modelcontextprotocol/client`,
  `@nemesis-oss/termina-core`, and the other declared runtime deps all
  resolved.
- Three native install-scripts ran (better-sqlite3 prebuild,
  `@openuidev/lang-core` postinstall, husky prepare); npm warned but
  completed. The `prepare: husky` script is a no-op when installed as a
  dependency (Husky detects the consumer install context) — fine for
  published packages.

## 4. Import smoke

`import * as nexum from '@nemesis-oss/nexum'` from the clean-room
install returns **298 named runtime exports** (after the 8 missing-export
fixes in this branch; was 290 before).

All Tier-1 Stable runtime exports present:

| Symbol                                                    | In `Object.keys(nexum)`? | Notes                                                                     |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `Agent`                                                   | ✅                       | runtime value                                                             |
| `DefaultAgentRuntime`                                     | ✅                       | runtime value (the `AgentRuntime` symbol in STABILITY.md is a type alias) |
| `ReActStrategy` / `PlanExecuteStrategy` / `GraphStrategy` | ✅                       | runtime values (the `ExecutionStrategy` symbol is a type alias)           |
| `DefaultToolGateway`                                      | ✅                       | runtime value (the `ToolGateway` symbol is a type alias)                  |
| `DefaultModelGateway`                                     | ✅                       | runtime value (the `ModelGateway` symbol is a type alias)                 |
| `RulePolicyEngine`, `AllowAllPolicyEngine`                | ✅                       | runtime values (the `PolicyEngine` symbol is a type alias)                |
| `BudgetManager`, `BudgetTracker`                          | ✅                       |                                                                           |
| `createExecutionContext`                                  | ✅                       |                                                                           |
| `defineToolPack`, `mountToolPack`                         | ✅                       |                                                                           |
| `CancellationScope`, `CancellationRegistry`               | ✅ (after fix)           | were missing — see §6                                                     |
| `GateRegistry`, `ConcurrencyGate`                         | ✅ (after fix)           | were missing — see §6                                                     |
| `newRunId`, `newTaskId`                                   | ✅ (after fix)           | were missing — see §6                                                     |
| `WorkspaceManager`                                        | ✅ (after fix)           | was missing — see §6                                                      |
| `loadConfig`                                              | ✅ (after fix)           | was missing — see §6                                                      |
| `startRpcServer`                                          | ✅                       |                                                                           |

## 5. `nexum doctor` smoke

Ran `nexum doctor` in an empty `/tmp` directory against the installed
package. **Exits 0.** Reports:

- Node 24.22.3 ok
- Workspace root + `.nexum` uninitialized (expected — first run)
- Local model `qwen3.5:4b` resolved (tier: local, ollama host
  `http://localhost:11434`)
- Docker not running in this sandbox (expected — sandbox limitation, not
  a package defect)
- 15 LSP providers configured

**Verdict:** clean-room `nexum doctor` initializes correctly from the
installed package on Linux.

## 6. Finding — 8 documented Tier-1 exports were missing from the public surface

**Severity:** Medium (contract drift, not a security issue).

**What the audit found.** STABILITY.md Tier 1 lists these as Stable, but
`src/index.ts` did not re-export them. Each is defined in its source file
and used internally, but consumers importing them from the package entry
got `undefined`:

| Symbol                                      | Source file                             |
| ------------------------------------------- | --------------------------------------- |
| `WorkspaceManager`                          | `src/platform/workspace.ts:90`          |
| `CancellationScope`, `CancellationRegistry` | `src/core/cancellation/cancellation.ts` |
| `GateRegistry`                              | `src/core/concurrency/gate-registry.ts` |
| `ConcurrencyGate`                           | `src/core/concurrency/gate.ts`          |
| `newRunId`, `newTaskId`                     | `src/core/identity.ts`                  |
| `loadConfig`                                | `src/cli/config.ts`                     |

**Fix.** All eight are now re-exported from `src/index.ts` (commit in
this branch). Runtime export count goes 290 → 298 and every symbol above
is present in the clean-room import smoke.

This is exactly the kind of drift the B6 audit exists to catch — a
documented Stable export that quietly stopped being importable. The new
`tests/package-surface.test.ts` (Phase 4 API-freeze work, same branch)
fails CI if any of them disappears again.

## 7. Native deps verification

RELEASE-READINESS.md §B6 names `better-sqlite3`, `esbuild`,
`unrs-resolver` as native deps to verify. Audit results:

| Dep              | Direct dep?                        | Clean-room install                | Runtime import from `src/`?                                  |
| ---------------- | ---------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `better-sqlite3` | Yes (`dependencies`)               | ✅ prebuilt binary installed      | Yes — `src/persistence/` uses it                             |
| `esbuild`        | No (transitive, via dev toolchain) | Not in tarball's runtime dep tree | No — only `tsx`/`typescript-eslint` use it (devDep)          |
| `unrs-resolver`  | No (transitive, via dev toolchain) | Not in tarball's runtime dep tree | No — only ESLint's `eslint-plugin-import-x` uses it (devDep) |

**Verdict:** `esbuild` and `unrs-resolver` are dev-toolchain transitive
deps, not runtime requirements. They appear in the nexum repo's own
`node_modules/` because devDeps install there, but they are correctly
absent from the published tarball's runtime dep tree. The §B6 list in
RELEASE-READINESS.md was an example, not a verified list — these two
should be removed from it on the next doc update. `better-sqlite3` is
the only real native runtime dep and it installs cleanly via prebuilt
binaries on Linux.

## 8. Phase-1 gate status for B6

**PASS.** Tarball is clean of unintended content (§2); clean-room install
succeeds (§3); all Tier-1 runtime exports present after the 8
missing-export fixes (§4); `nexum doctor` initializes correctly from the
installed package on Linux (§5). One Medium finding (§6) found and fixed
in this branch.

**Local-only remaining checks** (cannot run in this sandbox):

- macOS clean install + `nexum doctor` smoke (Phase 2 CI OS matrix)
- Windows clean install + `nexum doctor` smoke (Phase 2 CI OS matrix)

The Phase 2 gate adds a Linux/macOS/Windows CI matrix to `ci.yml` for the
clean-room install. That work is documented in the handoff runbook
(`docs/STABLE-RELEASE-HANDOFF.md`).
