# REBRANDING.md — DevAgent → Nexum Migration Contract

This document is the **authoritative mapping** for the DevAgent TS → Nexum rename.
Every code, docs, package, and CLI change in this repository must conform to the
table below. If a change disagrees with this file, this file wins — update the
change, not the contract.

> **Provisional name notice:** "Nexum" is a working product name pending final
> availability/trademark/domain/package audit. The brand is deliberately isolated
> in `src/platform/brand.ts` (single source of truth) so that swapping the final
> name later touches one constants file plus this document — not the whole tree.

## 1. Target state

| Layer | Value |
|---|---|
| Organization | Nemesis OSS |
| Product | **Nexum** |
| Technical identity | Nexum Agent Runtime / Agent Harness |
| CLI | `nexum` |
| npm package | `@nemesis-oss/nexum` |
| GitHub (target) | `nemesis-oss/nexum` (activated after repo migration, see §8) |

Retained during the transition (at least one major version):

- npm alias package `@nemesis-oss/devagent-ts` (final compat release, then deprecated)
- CLI bin aliases `devagent`, `devagent-ts`
- Environment variables `DEVAGENT_*` (read as deprecated fallbacks)
- Workspace directory `.devagent/` (auto-migrated, never destroyed)

## 2. Name mapping

| Old | New |
|---|---|
| DevAgent | Nexum |
| DevAgent TS | Nexum |
| devagent-ts | nexum |
| `@nemesis-oss/devagent-ts` | `@nemesis-oss/nexum` |
| devagent | nexum |
| DEVAGENT_* | NEXUM_* |
| `.devagent/` | `.nexum/` |
| `~/.devagent/` | `~/.nexum/` |
| `.devagent_history` | `.nexum_history` |
| DevAgent Runtime | Nexum Agent Runtime |
| Developer Agent | Coding Agent / Agent Runtime |
| `devagent-sandbox:latest` | `nexum-sandbox:latest` |
| `DEVAGENT.md` (agents file) | `NEXUM.md` (both read; `AGENTS.md` remains primary) |

### What is NOT renamed

- **Generic architecture terms**: `Agent`, `Tool`, `Provider`, `Router`,
  `ModelCatalog`, `Orchestrator`, `Planner` stay generic. The target is
  `Nexum → Agent Runtime → Agent/Tool/Provider/Router`, **not**
  `NexumAgent`/`NexumTool`/`NexumProvider` sprinkled everywhere.
- **DevDocs** (`.nexum/docs.db` ingests DevDocs bundles) — an external product.
- **Ollama** — a provider, not the product. Documentation is provider-neutral;
  Ollama is one Model Gateway provider among future ones.
- **Historical documents**: dated plans under `docs/superpowers/plans/`,
  `docs/deep-research-report.md`, and `docs/requirements/` are provenance
  records and keep their original naming.
- **Git history**: never rewritten. The log must show DevAgent TS → Nexum.

## 3. Environment variables

Canonical form is `NEXUM_*`. Legacy `DEVAGENT_*` is honored for one major
version as a **deprecated compatibility alias** with a stderr warning.

Precedence (implemented in `src/platform/environment.ts`):

```
NEXUM_<KEY>  >  DEVAGENT_<KEY>  >  config file  >  built-in default
```

| Legacy (deprecated) | Canonical |
|---|---|
| `DEVAGENT_MODEL` | `NEXUM_MODEL` |
| `DEVAGENT_TIER` | `NEXUM_TIER` |
| `DEVAGENT_WORKSPACE` | `NEXUM_WORKSPACE` |
| `DEVAGENT_TIMEOUT_MS` | `NEXUM_TIMEOUT_MS` |
| `DEVAGENT_SYSTEM_PROMPT` | `NEXUM_SYSTEM_PROMPT` |
| `DEVAGENT_SHELL_IMAGE` | `NEXUM_SHELL_IMAGE` |
| `DEVAGENT_SHELL_TIMEOUT_SEC` | `NEXUM_SHELL_TIMEOUT_SEC` |
| `DEVAGENT_TOOL_SELECTION_MODE` | `NEXUM_TOOL_SELECTION_MODE` |
| `DEVAGENT_MAX_ACTIVE_TOOLS` | `NEXUM_MAX_ACTIVE_TOOLS` |
| `DEVAGENT_QUICK_MODEL` | `NEXUM_QUICK_MODEL` |
| `DEVAGENT_LOCAL_WORKER` | `NEXUM_LOCAL_WORKER` |
| `DEVAGENT_VERIFIER` | `NEXUM_VERIFIER` |
| `DEVAGENT_SELF_CONSISTENCY` | `NEXUM_SELF_CONSISTENCY` |
| `DEVAGENT_SC_N` | `NEXUM_SC_N` |
| `DEVAGENT_SC_THRESHOLD` | `NEXUM_SC_THRESHOLD` |
| `DEVAGENT_AVAIL_TTL_MS` | `NEXUM_AVAIL_TTL_MS` |
| `DEVAGENT_AVAIL_CHECK` | `NEXUM_AVAIL_CHECK` |
| `DEVAGENT_HEURISTIC_GATE` | `NEXUM_HEURISTIC_GATE` |
| `DEVAGENT_AUTO_APPROVE` | `NEXUM_AUTO_APPROVE` |
| `DEVAGENT_PRICE_INPUT_PER_M` | `NEXUM_PRICE_INPUT_PER_M` |
| `DEVAGENT_PRICE_OUTPUT_PER_M` | `NEXUM_PRICE_OUTPUT_PER_M` |
| `DEVAGENT_MAX_LOGS` | `NEXUM_MAX_LOGS` |
| `DEVAGENT_MAX_CONVERSATION` | `NEXUM_MAX_CONVERSATION` |
| `DEVAGENT_MAX_TOOL_CALLS` | `NEXUM_MAX_TOOL_CALLS` |
| `DEVAGENT_MAX_NOTIFICATIONS` | `NEXUM_MAX_NOTIFICATIONS` |
| `DEVAGENT_DEBUG_STDIN` | `NEXUM_DEBUG_STDIN` |
| `DEVAGENT_TEST_NO_GLOBAL` | `NEXUM_TEST_NO_GLOBAL` |

Provider-level variables (`OLLAMA_HOST`, `OLLAMA_API_KEY`, `OLLAMA_API_KEYS`)
are **not** product variables and keep their upstream names.

Deprecation warning (emitted once per variable per process, to stderr):

```
DEVAGENT_MODEL is deprecated. Use NEXUM_MODEL instead.
```

Suppress with `NEXUM_NO_DEPRECATION_WARNINGS=1` (useful in CI).

## 4. Workspace state migration

Old layout:

```
.devagent/
├── memory.db
├── checkpoint.json
├── sessions/
├── docs.db
├── config.json
├── skills/
└── models.json
.devagent_history        (workspace root)
```

New layout:

```
.nexum/
├── memory.db
├── checkpoint.json
├── sessions/
├── docs.db
├── config.json
├── skills/
├── models.json
└── .migrated-from-devagent.json   (migration marker — commit point)
.nexum_history           (workspace root)
```

Resolution algorithm (implemented in `src/platform/workspace.ts`):

```
.nexum exists?
  ├─ yes → use .nexum (no migration)
  └─ no
       ↓
     .devagent exists?
       ├─ yes → migrate (copy) → validate → write marker → use .nexum
       └─ no  → initialize empty .nexum
```

Migration properties (all enforced and tested):

- **Atomic**: the marker file `.migrated-from-devagent.json` is written **last**
  and is the single commit point. An interrupted migration leaves no marker and
  is simply re-run.
- **Idempotent**: entries already present in `.nexum` are never overwritten
  (merge-on-copy). Re-running a completed migration is a no-op.
- **Recoverable**: copy errors are collected per-entry and reported; a failed
  entry never aborts the rest, and the source is untouched.
- **Non-destructive**: `.devagent/` is **copied**, never moved or deleted.
  Remove it manually only after validating the migrated workspace.

Explicit command: `nexum migrate` — inspects `.devagent/`, `DEVAGENT_*`
variables, and legacy files, then prints a migration report. Automatic
migration also runs lazily on first workspace resolution.

Global state follows the same rule: `~/.devagent/` → `~/.nexum/`
(`config.json`, `.env`, `skills/`), legacy read as fallback, never deleted.

## 5. Package identity

```json
{
  "name": "@nemesis-oss/nexum",
  "version": "2.0.0",
  "bin": {
    "nexum": "bin/cli.js",
    "devagent": "bin/cli.js",
    "devagent-ts": "bin/cli.js"
  }
}
```

Why major `2.0.0`: the package name, CLI, environment variables, workspace
state directory, and brand all change — a breaking product migration. The bin
and env aliases carry existing users across the boundary for one major cycle.

## 6. Scope discipline

This rename intentionally does **not** include architecture refactors
(Agent decomposition, context engine, policy engine, `src/platform/` beyond the
four brand/workspace files). Rename first, restructure second — one variable at
a time. The only structural addition is `src/platform/`:

```
src/platform/
├── brand.ts        # BRAND constants
├── environment.ts  # NEXUM_* > DEVAGENT_* resolution + deprecation warnings
├── paths.ts        # config-dir names, workspace-root discovery
└── workspace.ts    # WorkspaceManager: detect / migrate / initialize / resolve
```

## 7. Release sequence

| Release | Package | Contents |
|---|---|---|
| A — preparation | `devagent-ts@1.0.1` | migration framework, legacy env support, deprecation warnings, no breaking changes |
| B — rename | `nexum@2.0.0` | new package, `nexum` CLI, `.nexum/`, `NEXUM_*`, Nexum branding |
| C — deprecation | `devagent-ts@1.0.2` | `npm deprecate` pointing to `@nemesis-oss/nexum` |
| D — sunset | — | stop developing `devagent-ts`; keep historical package metadata intact |

GitHub sequence (UI/API operations, not file changes):
rename branch → merge → release → rename GitHub repository to
`nemesis-oss/nexum` → verify old-URL redirects → update remaining links.
GitHub automatically redirects the old repository URL after a rename, so
in-repo links pointing at the target activate the moment the rename lands.

## 8. Verification matrix

Before declaring the rename complete, every row must pass:

| Check | Expected |
|---|---|
| `npm install @nemesis-oss/nexum` | installs |
| `nexum` | runs |
| `devagent` / `devagent-ts` alias | runs during transition |
| local Ollama | works |
| cloud Ollama + multi-key failover | works |
| MCP / LSP / browser tools | work |
| memory, session resume, checkpoint resume | work |
| docs database | works |
| Docker sandbox (`nexum-sandbox:latest`) | works |
| old `.devagent` workspace | migrates automatically + via `nexum migrate` |
| new `.nexum` workspace | normal startup |
| old env variables | work, warn deprecation |
| new env variables | canonical |
| new env beats legacy env | precedence holds |
| package exports + TypeScript declarations | intact |
| npm tarball contents | correct (`files` allowlist) |

## 9. Compatibility search list

When auditing completeness, search for (excluding historical docs and
migration code):

```
DevAgent  devagent  DEVAGENT  .devagent  devagent-ts  devagent-sandbox
```

Legitimate surviving occurrences are only in:
`src/platform/` (compat/migration code), `docs/REBRANDING.md`, CHANGELOG
history, and dated historical documents.
