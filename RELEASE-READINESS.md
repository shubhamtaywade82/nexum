# RELEASE-READINESS.md — First Public npm Release Plan

> **Status:** Active planning document. Governs the first public publication of
> `@nemesis-oss/nexum` and the path from alpha to a stable `2.0.0`.
> Registry and repository facts below were verified on **2026-11-10**.

## 1. Current state (verified 2026-11-10)

| Fact | Status |
|---|---|
| `@nemesis-oss/nexum` on npm | **Never published** (registry 404) — clean slate |
| Repo version | `2.0.0-alpha.3` on `main`, MIT, developer preview |
| `@nemesis-oss/devagent-ts`, `devagent-ts`, `devagent` on npm | **Never published** (all 404) — no predecessor users to migrate |
| `@x12i/nexum` on npm | Exists, actively maintained (`2.0.1`, 2026-09-19), also at 2.x — brand-confusion risk |
| `nemesis-oss/nexum` on GitHub | **Does not exist** (404); repo lives at `shubhamtaywade82/nexum`, but `package.json` metadata already points at the org repo |
| Release pipeline | `release:check` (lint + format + build + test + package:check) and `.github/workflows/release.yml` with provenance; auth via long-lived `NPM_TOKEN` secret |

Two consequences follow from "never published":

1. Every version number is available; `2.0.0-alpha.4` is the proposed next release.
2. The DevAgent-era compatibility promises (`docs/REBRANDING.md` §1) were written
   for a predecessor package that never shipped to npm. The CLI bin aliases
   protect no existing users and should be removed **before first publish**
   (Blocker B2) — once published, they become a promise we must honor.

## 2. Release blockers

No public release until every blocker's "Done when" passes.

### B1 — Dangerous default: `NEXUM_AUTO_APPROVE=true`

`docs/guide/configuration.md` documents `autoApprove` defaulting to `true`
("Approve confirmation-required tool calls without prompting; includes
destructive workspace operations"). For an agent with filesystem, shell, git
and network tools, this default is unsafe for a public audience.

Changes:

- Default to interactive approval: `autoApprove: false` unless explicitly set.
- Unattended execution requires explicit opt-in: `--yolo` flag or
  `NEXUM_AUTO_APPROVE=true` in the environment/config.
- Security-sensitive operations (workspace guard, sandbox scope, `git push`,
  PR/issue actions) fail closed when approval is unavailable in headless mode,
  instead of auto-approving.
- Update `docs/guide/configuration.md`, `SECURITY.md`, `README.md`, and the
  affected tests (`tests/cli/default-activation.test.ts`,
  `tests/cli/workspace-trust.test.ts`).

**Done when:** a fresh install with zero configuration prompts before
destructive operations; tests cover the new default and the fail-closed
headless path; all three documents updated.

### B2 — Remove legacy CLI bin aliases (`devagent`, `devagent-ts`)

Decision (2026-11-10): one product, one executable — `nexum`. Rationale: no
DevAgent package was ever published to npm, so the "retained during the
transition (at least one major version)" bin-alias promise in REBRANDING.md §1
serves no existing users.

Changes:

- `package.json`: `bin` reduced to `nexum` only.
- `docs/REBRANDING.md` (amend in the same PR — the contract file wins):
  - §1: remove "CLI bin aliases" from the retention list.
  - §5: single-bin block plus the new rationale (registry shows no predecessor
    package, hence no users to carry).
  - §7: drop release rows A, C, D — they schedule `devagent-ts@1.0.1/1.0.2`
    npm releases for a package that never existed.
  - §8: remove the alias row from the verification matrix.
- `README.md`: remove the alias lines in the CLI section and the "remain as
  aliases … for one major version" promise in the migration section.
- `CHANGELOG.md`: document the alias removal.
- Keep (per the existing contract, until 3.0): `DEVAGENT_*` env fallbacks with
  deprecation warnings, `.devagent/` → `.nexum/` migration, `nexum migrate`,
  all `src/platform/` compat code, `devagent-sandbox:latest` fallback in
  `src/platform/brand.ts`, and historical documents per REBRANDING.md §9.
- Do NOT rename: `src/agents/devagent/` and the `DevAgent` SDK export — a
  product-agent name, not CLI surface (REBRANDING.md §6 scope discipline).

**Done when:** `npm pack` ships exactly one bin link; a search for `devagent`
bin references outside historical docs, `src/platform/`, and the changelog
returns nothing; REBRANDING.md and `package.json` agree.

### B3 — Repository metadata points at a nonexistent repo

`package.json` `repository`/`homepage`/`bugs` point at
`github.com/nemesis-oss/nexum`, which 404s today. An npm page with three
broken links is a failed first impression.

Either:

- **(preferred)** complete the org migration per REBRANDING.md §7 — rename or
  transfer to `nemesis-oss/nexum`, verify old-URL redirects, update remaining
  links, **or**
- repoint metadata to `shubhamtaywade82/nexum` and defer the org move.

**Done when:** every URL in the published metadata resolves (`npm repo`,
`npm bugs`, `npm docs`, npm package page links).

### B4 — Release workflow would tag prereleases as `latest`

`release.yml` publishes with `npm publish --provenance --access public` and no
`--tag`. npm applies the `latest` dist-tag **by default, even for prerelease
versions**, so publishing `2.0.0-alpha.4` as-is would make the alpha the
default install for every `npm install @nemesis-oss/nexum`.

Changes:

- Compute the dist-tag from the version in the workflow:

  ```yaml
  - name: Compute dist-tag
    id: dist
    run: |
      VERSION="$(node -p "require('./package.json').version")"
      if [[ "$VERSION" == *-* ]]; then TAG=next; else TAG=latest; fi
      echo "tag=$TAG" >> "$GITHUB_OUTPUT"

  - name: Publish to NPM Registry
    run: npm publish --provenance --access public --tag ${{ steps.dist.outputs.tag }}
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```

- README installation docs use `@nemesis-oss/nexum@next` during the alpha
  window and explain why (with only a `next` tag published, a bare
  `npm install @nemesis-oss/nexum` fails by design — good friction for a
  developer preview, but it must be documented, not discovered).

**Done when:** the workflow contains the tag logic; the first real publish
lands under `next`, not `latest`; README documents the `@next` install.

### B5 — Brand audit (name is provisional)

REBRANDING.md still carries the "provisional name pending availability /
trademark / domain / package audit" notice. The unrelated `@x12i/nexum`
(active, also at 2.x) increases search confusion. The audit does not need to
block the alpha if the name is consciously accepted, but it **must** block
`2.0.0` stable.

**Done when (2.0.0 gate):** npm/domain/trademark search results are recorded
in REBRANDING.md and the provisional-name notice is replaced with the final
decision.

### B6 — Tarball and clean-install audit

The `files` allowlist (`dist/`, `bin/`, `docker/nexum-sandbox/`,
`.env.example`, `config.example.jsonc`, `README.md`, `LICENSE`) is a good
base. Before first publish, verify from the packed tarball:

- No credentials, tokens, dev fixtures, or unintended files: review the
  `npm pack --dry-run` listing; scan for `.env*`, `*.pem`, `*token*`,
  `*secret*`, test fixtures.
- All advertised `exports` subpaths resolve and load their TypeScript
  declarations from a fresh `node_modules` install (smoke script).
- Native dependencies (`better-sqlite3`, `esbuild`, `unrs-resolver`) install
  on a clean environment; verify at least one platform outside CI.
- `nexum` runs from the installed package on Linux; macOS and Windows verified
  at least manually during alpha, via a CI OS matrix during beta.
- Fresh-workspace smoke: `nexum doctor` in an empty directory initializes
  `.nexum/` without errors.

**Done when:** the reviewed `npm pack --dry-run` listing is attached to the
release PR and a clean-room install + smoke test passes.

### B7 — Stability honesty in positioning

`STABILITY.md` correctly lists incomplete subsystems (Linux keychain write
path, plugin capability enforcement, `ProcessSubagentProvider`). For the alpha
this is acceptable **if** the npm description, README, and first-release notes
all say "developer preview — no stability guarantee; pin the exact version".
The gaps themselves gate `2.0.0` (Phase 5), not the alpha.

**Done when (alpha):** preview positioning present in README and release
notes. **Done when (2.0.0):** the STABILITY.md incomplete list is empty or
every remaining item is explicitly scoped out with a tracking issue.

## 3. Release phases

| Phase | Version | Dist-tag | Theme | Gates |
|---|---|---|---|---|
| 1 | `2.0.0-alpha.4` | `next` | First public release | B1–B4, B6, B7 (alpha positioning) |
| 2 | `2.0.0-alpha.5` | `next` | Early adopters | Feedback fixes; SDK quickstart + example integrations; OIDC trusted-publisher migration (drop `NPM_TOKEN`); CI OS matrix (Linux/macOS/Windows) |
| 3 | `2.0.0-beta.1` | `next` | Feature complete | Plugin capability enforcement; keychain Linux round-trip test; security review of the MCP tool prompt-injection surface |
| 4 | `2.0.0-rc.1` | `next` | Release candidate | API freeze; STABILITY.md Tier 1 finalized; B5 brand audit closed |
| 5 | `2.0.0` | `latest` | Stable | Stability guarantee live; dist-tag switch to `latest`; migration documentation complete |

Version numbers are proposals — the registry history is empty, so any next
number is available. No phase is promoted to `latest` before Phase 5.

## 4. Publish runbook

### 4.1 Every release (first and subsequent)

```bash
# 0. Confirm intended registry state
npm view @nemesis-oss/nexum versions --json    # 404 until first publish
npm view @nemesis-oss/nexum dist-tags --json

# 1. Bump version (npm version also commits and tags vX.Y.Z)
npm version 2.0.0-alpha.4

# 2. Full validation (same gate as CI)
npm run release:check

# 3. Inspect the exact tarball that will be published
npm pack --dry-run

# 4. Push commit + tag; the tag push triggers release.yml
git push origin main --follow-tags
```

Manual alternative (requires npm 2FA):

```bash
npm publish --access public --tag next --provenance
```

### 4.2 First publish only

- Verify `npm view @nemesis-oss/nexum` still 404s immediately before
  publishing (no race with a squatter on the scope).
- Confirm `--access public` — scoped packages default to restricted.
- After publishing, confirm the provenance attestation is visible on the npm
  package page.

### 4.3 Post-publish verification (every release)

| Check | Expected |
|---|---|
| `npm view @nemesis-oss/nexum dist-tags` | Version under `next` (phases 1–4) / `latest` (phase 5) |
| `npm install -g @nemesis-oss/nexum@next && nexum --version` | Matches published version |
| `npm view @nemesis-oss/nexum` metadata | `repository`, `homepage`, `bugs` all resolve |
| Clean project: `npm install @nemesis-oss/nexum@next` + import smoke | All advertised exports load |
| `nexum doctor` in an empty directory | Initializes `.nexum/`, reports healthy |
| npm package page | Provenance badge shown, README rendered, no unintended files |

### 4.4 Bad-publish recovery

- **Wrong dist-tag:** `npm dist-tag add @nemesis-oss/nexum@<version> <tag>` to
  correct, then remove the wrong entry.
- **Broken release:** unpublish promptly (`npm unpublish
  @nemesis-oss/nexum@<version>` — most reliable within 72h of publication and
  with no dependents), then republish a fix; otherwise
  `npm deprecate @nemesis-oss/nexum@<version> "Use <fix-version>"`.
- Document any recovery in `CHANGELOG.md`.

## 5. Distribution strategy

- **One package.** Do not pre-split into `-core`, `-mcp`, `-evolution`,
  `-plugin-sdk`; premature splitting multiplies dependency and compatibility
  overhead. Revisit only with demonstrated demand.
- **Auth:** migrate `release.yml` from the long-lived `NPM_TOKEN` secret to
  npm trusted publishing (OIDC) during Phase 2. Provenance is already wired
  (`id-token: write` + `--provenance`).
- **Ecosystem role:** Nexum consumes the other Nemesis OSS packages (model
  SDKs, exchange SDKs) as infrastructure rather than duplicating their
  functionality.

## 6. Explicitly out of scope for first publish

- Splitting into multiple npm packages (deferred until demand exists).
- Website/docs portal polish (VitePress docs already build; portal work is
  Phase 2+).
- `DEVAGENT_*` env compatibility beyond the 3.0 boundary already promised in
  REBRANDING.md §1.

## 7. Document history

| Date | Change |
|---|---|
| 2026-11-10 | Created. Registry/repo facts verified; blockers B1–B7 defined; phase plan alpha.4 → 2.0.0; publish runbook and recovery procedures added. |
