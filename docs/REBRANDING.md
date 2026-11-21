# REBRANDING.md — Brand Contract

This document is the authoritative brand contract. Every code, docs, package
and CLI change must conform to it.

> **Final decision: Nexum** (brand audit dated 2026-11-21, see `docs/BRAND-AUDIT.md`).
> The brand is isolated in `src/platform/brand.ts` (single source of truth).

## 1. Target state

| Layer              | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Organization       | Nemesis OSS                                                       |
| Product            | **Nexum**                                                         |
| Technical identity | Nexum Agent Runtime / Agent Harness                               |
| CLI                | `nexum` (the only executable)                                     |
| npm package        | `@nemesis-oss/nexum`                                              |
| Env prefix         | `NEXUM_*`                                                         |
| State directories  | `.nexum/` (workspace), `~/.nexum/` (global)                       |
| Sandbox image      | `nexum-sandbox:latest`                                            |
| Agent files        | `AGENTS.md` (primary), `NEXUM.md`                                 |
| GitHub             | `shubhamtaywade82/nexum` until transferred to `Nemesis-oss/nexum` |

No legacy names are read, written or aliased. The 2.0.0 line never shipped
`devagent` bin aliases or a `devagent-ts` package, and the `DEVAGENT_*` env
fallbacks and `.devagent/` migration were removed in the pre-stable cleanup

## 2. Naming rules

- The built-in coding agent keeps its class `DevAgent` and id `devagent`
  (`src/agents/devagent/`). It is a product component, not the old brand.
- Generic architecture terms (`Agent`, `Tool`, `Provider`, `Router`,
  `ModelCatalog`, `Orchestrator`, `Planner`) stay generic. Do not prefix them
  with `Nexum`.
- DevDocs (`.nexum/docs.db` ingests DevDocs bundles) and Ollama are external
  products. Ollama is one provider, not the product.
- Historical documents (`docs/superpowers/plans/`, `docs/deep-research-report.md`,
  `docs/requirements/`, and CHANGELOG history) keep their original naming.

## 3. Enforcement

- `src/platform/brand.ts` holds every brand constant. Outside `src/platform/`,
  code must not hardcode `.nexum` path literals; `tests/platform/brand-isolation.test.ts`
  fails the build when it does.
- `src/platform/environment.ts` reads `NEXUM_*` only.

## 4. Package identity

```json
{
  "name": "@nemesis-oss/nexum",
  "bin": { "nexum": "bin/cli.js" }
}
```

## 5. GitHub transfer

`Nemesis-oss` is a maintainer-owned user account (not an organization), so the
repository is transferred to it: Settings → Transfer ownership → `Nemesis-oss`.
GitHub redirects the old URL. Then update `repository`, `homepage` and `bugs`
in `package.json` to `Nemesis-oss/nexum`.

## 6. Verification

Before declaring the brand complete, these must pass:

| Check                                     | Expected                    |
| ----------------------------------------- | --------------------------- |
| `npm install @nemesis-oss/nexum`          | installs                    |
| `nexum`                                   | runs                        |
| memory, session resume, checkpoint resume | work                        |
| Docker sandbox (`nexum-sandbox:latest`)   | works                       |
| new `.nexum` workspace                    | normal startup              |
| package exports + TypeScript declarations | intact                      |
| npm tarball contents                      | correct (`files` allowlist) |
