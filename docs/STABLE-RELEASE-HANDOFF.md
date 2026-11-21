# Stable Release Handoff Runbook — nexum 2.0.0

> Generated 2026-11-21. Branch: `fix/release-blockers-b3-oidc-audits`
> (8 commits ahead of `main`). This is what's left to do **locally** to
> take nexum from its current alpha.4 state on `main` to a published
> `2.0.0` stable.

## What's already done in this branch

Eight commits ready to merge into `main`. Code changes verified by
targeted test runs (conversation/runtime/credentials/package-surface
suites) plus a full-suite run on the final state.

| #   | Commit              | Gate                      | What                                                                                                                                                                                                                                                                 |
| --- | ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `chore(release)`    | B3 (Phase 1)              | `package.json` repo/homepage/bugs URLs repointed from 404 `nemesis-oss/nexum` to working `shubhamtaywade82/nexum`                                                                                                                                                    |
| 2   | `ci(release)`       | Phase 2 (OIDC)            | `release.yml` no longer references `NPM_TOKEN`; uses npm trusted publishing via `id-token: write` + `--provenance`. RELEASE-READINESS.md updated                                                                                                                     |
| 3   | `test(credentials)` | Phase 3 (keychain)        | New `tests/credentials/keychain-linux-roundtrip.test.ts` (live libsecret round-trip, skipped unless `NEXUM_KEYCHAIN_LIVE_TESTS=1`) + new `keychain` nightly job. STABILITY.md updated                                                                                |
| 4   | `fix(mcp)`          | Phase 3 (MCP audit + fix) | New `docs/SECURITY-AUDIT-MCP.md`. H1 fix landed: `messagesForModel()` fences every tool/file/web/MCP output in a per-call nonce `<tool_result>` block; system prompt clause 8 tells the model tool output is untrusted data. 6 new tests. Also `docs/BRAND-AUDIT.md` |
| 5   | `fix(index)`        | B6 (Phase 1)              | New `docs/B6-TARBALL-AUDIT.md`. Found + fixed 8 Tier-1 exports missing from the public surface (WorkspaceManager, CancellationScope/Registry, GateRegistry, ConcurrencyGate, newRunId/newTaskId, loadConfig). Export count 290 → 298                                 |
| 6   | `test(surface)`     | Phase 4 (API freeze)      | New `docs/API-FREEZE-AUDIT.md`. New `tests/package-surface.test.ts` closes the "no test imports from package surface" structural gap. New STABILITY.md "2.0.0 API Freeze" section                                                                                    |
| 7   | `docs(migration)`   | Phase 5 (migration docs)  | New `docs/MIGRATION-2.0.md`                                                                                                                                                                                                                                          |
| 8   | this commit         | handoff                   | This runbook                                                                                                                                                                                                                                                         |

**Summary of state after this branch merges to `main`:**

| Phase       | Gate                          | Status                                                                                    |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| 1 (alpha.5) | B1 autoApprove default        | ✅ Already done on main                                                                   |
| 1 (alpha.5) | B2 bin aliases                | ✅ Already done on main                                                                   |
| 1 (alpha.5) | B3 repo URLs                  | ✅ Done in this branch                                                                    |
| 1 (alpha.5) | B4 dist-tag logic             | ✅ Already done on main                                                                   |
| 1 (alpha.5) | B6 tarball audit              | ✅ Done in this branch (PASS)                                                             |
| 1 (alpha.5) | B7 alpha positioning          | ✅ Already done on main                                                                   |
| 2 (alpha.5) | OIDC trusted publishing       | ✅ Code done in this branch; **npm-side trusted-publisher mapping is local**              |
| 3 (beta.1)  | Plugin capability enforcement | ✅ Already done on main (PR #70)                                                          |
| 3 (beta.1)  | Keychain Linux round-trip     | ✅ Test done in this branch; **first nightly run is local** (GitHub Actions)              |
| 3 (beta.1)  | MCP prompt-injection audit    | ✅ Audit + H1 fix done in this branch (gate PASSES on the MCP surface)                    |
| 4 (rc.1)    | B5 brand audit                | ⚠️ Audit doc done; **final KEEP/RENAME decision is local** + new org-name blocker (see F) |
| 4 (rc.1)    | API freeze                    | ⚠️ Structural prerequisite closed; remaining per-symbol gaps deferred to RC PR            |
| 5 (2.0.0)   | Stable publish                | ❌ All local (push, burn-in, migration docs review)                                       |

## Step-by-step local actions

### A. Merge the branch (5 min)

```bash
cd /path/to/your/local/nexum
git fetch origin
git checkout main
git merge --no-ff fix/release-blockers-b3-oidc-audits
# resolve if needed (branch was cut from current main @ adeb111)
git push origin main
```

### B. Configure npm trusted publishing (Phase 2 gate) — 10 min, manual

The code in `release.yml` no longer references `NPM_TOKEN`. Before the
first publish under OIDC works, you need to map the GitHub repo to the
npm package on npmjs.com:

1. Log into npmjs.com with the account that owns `@nemesis-oss/nexum`.
2. Open the package settings (or create the scope/org if `@nemesis-oss`
   doesn't exist yet — it currently 404s at the registry, so the first
   publish is also the first time the scope exists).
3. Add a Trusted Publisher:
   - **Repository owner:** `shubhamtaywade82`
   - **Repository name:** `nexum`
   - **Workflow filename:** `release.yml`
   - **Environment:** (leave blank or set to `release`)
4. Save. The mapping is what lets `npm publish --provenance` authenticate
   via OIDC without a token.

**Until this is done, the first tag push will fail at the `npm publish`
step in `release.yml` — by design, fail-closed.**

### C. Publish 2.0.0-alpha.5 (Phase 1 → 2) — 5 min

```bash
cd /path/to/your/local/nexum
npm version 2.0.0-alpha.5 --no-git-tag-version
# update CHANGELOG.md with the alpha.5 section listing:
#  - First public npm release
#  - B1, B2, B3, B4, B6, B7 closed
#  - The two BREAKING changes from PR #70 (already on main)
#  - Link to STABILITY.md and docs/MIGRATION-2.0.md
git add -A
git commit -m "chore(release): 2.0.0-alpha.5 — first public release"
git tag v2.0.0-alpha.5
git push origin main
git push origin v2.0.0-alpha.5
```

The tag push triggers `release.yml`. It runs `release:check`
(lint + format + build + test + package:check), then
`npm publish --provenance --access public --tag next`.

**Verify after publish:**

```bash
npm view @nemesis-oss/nexum dist-tags
# expected: { next: "2.0.0-alpha.5" }
# there must NOT be a `latest` tag yet
npm view @nemesis-oss/nexum
# repository, homepage, bugs must all resolve (no 404s)
# provenance badge must be visible on the package page
```

**Install smoke from a clean machine:**

```bash
mkdir /tmp/alpha5-smoke && cd /tmp/alpha5-smoke
npm init -y
npm install @nemesis-oss/nexum@next
node --input-type=module -e "
import * as m from '@nemesis-oss/nexum';
console.log('exports:', Object.keys(m).length);   // expect >= 298
console.log('WorkspaceManager:', typeof m.WorkspaceManager);  // function
"
nexum doctor    # in an empty dir
```

### D. Wait for nightly keychain job (Phase 3 gate) — 1 day

The new `keychain` job in `.github/workflows/nightly.yml` runs at 03:15 UTC
(or manually via the Actions UI → "Run workflow"). It installs
`libsecret-tools` + `dbus-x11` + `gnome-keyring` on an Ubuntu runner and
runs `tests/credentials/keychain-linux-roundtrip.test.ts` for real.

- Wait for the first nightly run to go green.
- If it fails, the failure will be in the Actions logs — most likely
  cause is `gnome-keyring-daemon` not unlocking the session keyring with
  an empty password. The job script handles that, but if Ubuntu changes
  the default keyring behavior, you'll need to adjust the unlock step.

### E. Publish 2.0.0-beta.1 (Phase 2 → 3) — 5 min

After alpha.5 has had a few days of soak and the nightly keychain job is
green:

```bash
npm version 2.0.0-beta.1 --no-git-tag-version
# CHANGELOG.md: 2.0.0-beta.1 — feature complete
#  - plugin capability enforcement (PR #70)
#  - keychain Linux round-trip (nightly green)
#  - MCP prompt-injection audit closed (H1 fix landed)
git add -A && git commit -m "chore(release): 2.0.0-beta.1 — feature complete"
git tag v2.0.0-beta.1
git push origin main && git push origin v2.0.0-beta.1
```

### F. Brand audit decision (Phase 4 gate) — 1–2 weeks

`docs/BRAND-AUDIT.md` has the evidence. The decision is yours (and
optionally a trademark attorney's).

**Resolved 2026-11-22:** the GitHub name `Nemesis-oss` is a **user account
owned by the maintainer** (created 2022), not an unrelated party. It is a
User, not an Organization, so it cannot be turned into an org, but the repo
can be transferred to it (Settings -> Transfer ownership -> `Nemesis-oss`;
GitHub redirects the old URL). The npm scope `@nemesis-oss` and the GitHub
account then match. Until the transfer, `package.json` URLs stay on
`shubhamtaywade82/nexum`. REBRANDING.md §7's "org" wording means this account.

Two paths:

**F1. KEEP "Nexum":**

1. Open `docs/REBRANDING.md` §1 and replace the "Provisional name notice"
   block with: `Final decision: Nexum (brand audit dated 2026-11-21,
see docs/BRAND-AUDIT.md)`.
2. Resolve the GitHub org name question (above).
3. Complete the manual trademark searches the audit could not do
   headlessly: USPTO direct, EUIPO eSearch, India IPO (OTP-gated — most
   relevant jurisdiction). Consult a trademark attorney if any live mark
   is deemed conflicting.
4. Commit + push.

**F2. RENAME:**

1. Update `src/platform/brand.ts` (single source of truth — REBRANDING.md
   §1) and `package.json` `name`/`bin`/`keywords`/`description`.
2. Update REBRANDING.md §1 with the final name + audit date.
3. Update README.md, STABILITY.md, SECURITY.md, all docs.
4. Commit + push as a major-version-bump prep (this would push 2.0.0
   to a later date and likely ship 2.0.0-alpha.6 first).

### G. Close API freeze gaps (Phase 4 gate) — 2–4 hours

`docs/API-FREEZE-AUDIT.md` lists the open per-symbol gaps (9 ❌ + 2 ⚠️).
Each needs either a contract test or a formal demotion to Tier 2/3. The
structural prerequisite is already closed
(`tests/package-surface.test.ts` ships in this branch).

The simplest path: hand the list to your local agent tool. The audit doc
§4 lists them:

- `defineToolPack` — smoke test that builds a pack via the factory
- `ToolResult`, `ToolInvocation`, `ToolPack`, `AgentDescriptor`,
  `EventEnvelope`, `CorrelationIds` — `satisfies` type assertions
- `ExecutionStrategy` — direct import + `satisfies` check
- `PlanExecuteStrategy`, `GraphStrategy` — direct construction test
  (not just registry name check)
- `newTaskId` — one-line behavior test (prefix + uniqueness)

When all are resolved, update the STABILITY.md "2.0.0 API Freeze"
section's verdict from CONDITIONAL to PASS, and bump the
package-surface test's `TIER_1_RUNTIME_EXPORTS` list if any new symbols
were promoted (promotion candidates are listed in the audit doc §5).

### H. Publish 2.0.0-rc.1 (Phase 3 → 4) — 5 min

```bash
npm version 2.0.0-rc.1 --no-git-tag-version
# CHANGELOG.md: 2.0.0-rc.1 — release candidate, API frozen
git add -A && git commit -m "chore(release): 2.0.0-rc.1 — release candidate"
git tag v2.0.0-rc.1
git push origin main && git push origin v2.0.0-rc.1
```

### I. Burn-in (Phase 4 → 5) — 1–2 weeks

Use your **local nexum + Ollama subscription + API key** to actually
run `2.0.0-rc.1` against your real workloads:

```bash
npm install -g @nemesis-oss/nexum@next
nexum --version    # must print 2.0.0-rc.1
# point it at your local Ollama + API key as you normally would
nexum serve &
# ... exercise the workflows you care about ...
```

- Track issues opened against rc.1.
- Fix only bugs, no API changes (Tier 1 is frozen).
- Each bug fix → `npm version 2.0.0-rc.2` (or `.3`, etc.).
- Promote to 2.0.0 stable when rc.N has had no Critical/High bugs for
  ≥7 days.
- Specifically verify the H1 fence doesn't regress any real workflow:
  if a model starts refusing to act on legitimate tool output (over-
  cautious reading of the untrusted-data clause), tune the clause 8
  wording in `src/cli/agent-conversation.ts` before stable.

### J. Finalize migration docs (Phase 5 gate) — 30 min

Review `docs/MIGRATION-2.0.md` against the actual published 2.0.0. Update
the "Status: draft" line to "Status: final — 2.0.0 published YYYY-MM-DD".
Update README.md's installation section to use the bare install (drop the
`@next` qualifier):

```diff
- npm install @nemesis-oss/nexum@next
+ npm install @nemesis-oss/nexum
```

### K. Publish 2.0.0 stable (Phase 5) — 5 min

```bash
npm version 2.0.0 --no-git-tag-version
# CHANGELOG.md: 2.0.0 — stable. Stability guarantee live.
#   - Tier 1 exports covered by semver
#   - dist-tag switched to latest
#   - migration documentation complete (docs/MIGRATION-2.0.md)
# Update STABILITY.md: remove "Developer Preview" notice, replace with
#   "Stability guarantee live as of 2.0.0".
# Update README.md status block: "Status: Stable (2.0.0)".
git add -A && git commit -m "chore(release): 2.0.0 — stable"
git tag v2.0.0
git push origin main && git push origin v2.0.0
```

**Verify after publish:**

```bash
npm view @nemesis-oss/nexum dist-tags
# expected: { latest: "2.0.0", next: "2.0.0" }  (or just latest)
npm install @nemesis-oss/nexum    # bare install now works
nexum --version                   # 2.0.0
```

## Estimated timeline

| Phase  | Step                                       | Time      | Who                          |
| ------ | ------------------------------------------ | --------- | ---------------------------- |
| A      | Merge branch                               | 5 min     | you                          |
| B      | npm trusted-publisher config               | 10 min    | you (npmjs.com UI)           |
| C      | Publish alpha.5                            | 5 min     | you (push tag)               |
| (soak) | alpha.5 burn-in                            | 3–5 days  | calendar                     |
| D      | Nightly keychain green                     | 1 day     | calendar                     |
| E      | Publish beta.1                             | 5 min     | you                          |
| (soak) | beta.1 burn-in                             | 3–5 days  | calendar                     |
| F      | Brand audit decision + org-name resolution | 1–2 weeks | you (+ attorney if RENAME)   |
| G      | Close API freeze gaps                      | 2–4 hours | your local agent tool or you |
| H      | Publish rc.1                               | 5 min     | you                          |
| I      | Burn-in with local nexum + Ollama          | 1–2 weeks | you                          |
| J      | Finalize migration docs                    | 30 min    | you                          |
| K      | Publish 2.0.0 stable                       | 5 min     | you                          |

**Total elapsed: 4–6 weeks of calendar time.** Active work: ~6 hours.
The rest is soak/burn-in time, which your local nexum + Ollama setup
makes much more thorough than the sandbox could.

## What you should NOT do

- Don't push the `v2.0.0-alpha.5` tag before step B (npm trusted-publisher
  mapping) is done — `release.yml` will fail at the publish step.
- Don't skip the soak windows. Each phase exists to catch a different
  class of issue: alpha catches packaging/install problems; beta catches
  integration drift (keychain, MCP); rc catches API-freeze violations.
- Don't ship 2.0.0 without step F (brand audit decision) —
  RELEASE-READINESS.md §B5 explicitly blocks 2.0.0 on it. The audit doc
  is complete; you just need to make the call and record it in
  REBRANDING.md §1. The new org-name blocker must be resolved in the
  same decision.
- Don't skip step G — even though the structural prerequisite
  (`tests/package-surface.test.ts`) is closed, the per-symbol contract
  tests are what makes the freeze meaningful. Shipping rc.1 with ❌ gaps
  leaves the freeze as documentation, not enforcement.

## Files changed by this branch (for review)

```
.github/workflows/nightly.yml                      |  50 +++ (keychain job)
.github/workflows/release.yml                      |   7 +- (drop NPM_TOKEN)
RELEASE-READINESS.md                               |  39 +-- (B3/B4/OIDC updates)
STABILITY.md                                       |  85 ++- (CredentialService, plugin line, API freeze section)
docs/API-FREEZE-AUDIT.md                           | 200 +++++++++ (new)
docs/B6-TARBALL-AUDIT.md                           | 176 ++++++ (new)
docs/BRAND-AUDIT.md                                | 190 +++++++ (new)
docs/MIGRATION-2.0.md                              | 308 ++++++++++ (new)
docs/SECURITY-AUDIT-MCP.md                         | 620 ++++++++++++ (new)
docs/STABLE-RELEASE-HANDOFF.md                     | this file (new)
package.json                                       |   6 +- (B3 URLs)
src/cli/agent-conversation.ts                      |  40 +-- (messagesForModel + clause 8)
src/cli/agent.ts                                   |   8 +- (4 model-call sites)
src/index.ts                                       |  15 + (8 missing Tier-1 exports)
tests/cli/agent-conversation.test.ts               | 101 ++++ (6 new fence tests)
tests/credentials/keychain-linux-roundtrip.test.ts | 181 +++++++ (new)
tests/package-surface.test.ts                      | 126 +++++ (new)
```

17 files, ~2,600 insertions, 8 commits.
