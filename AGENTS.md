# AGENTS.md – Nexum Project Overview

## 1. Project Purpose

**Nexum** (formerly DevAgent‑TS) is a TypeScript‑based agent runtime and harness that enables LLM‑driven coding assistants. It provides:
- A **capability-based model router** (`src/models/`) — a `ModelCatalog` discovers installed local + Ollama Cloud models, tags them by capability (coding/vision/reasoning/quick/tools), and a `Router` picks a local-first candidate per request, falling back through the rest on rate-limit/timeout/network errors.
- **Checkpoint/resume** (`src/runtime/checkpoint.ts`) — the orchestrator persists plan state after every step transition; a crashed multi-step task resumes instead of restarting, without re-running completed steps. Separately, `src/runtime/session.ts`'s `SessionStore` persists the LLM conversation transcript after every turn; `Agent.resumeSession()` / the `/resume` slash command restore it in a new process.
- **Browser automation** (`src/browser/manager.ts`) — a lazily-launched headless Chromium (Playwright), one reused page, exposed as `browser_navigate`/`click`/`fill`/`get_text`/`screenshot`/`evaluate`/`close` tools.
- **Parallel step execution** — independent plan steps run concurrently (`Promise.all` per round); dependents still wait for their dependency's batch.
- **Docker‑sandboxed shell execution** – every `run_shell` call and every project/Ruby script runner (`run_tests`, `run_lint`, `run_format`, `run_build`, `run_rubocop`, `run_rspec`) runs inside an isolated container: no network, host uid, no capabilities, read-only root filesystem, secrets masked, `.git` hooks/config and `.nexum/` read-only, bounded memory/CPU/PIDs and hard time‑outs (see §7.4 and `SECURITY.md`).
- **LSP‑backed code intelligence** (`src/lsp/`, `src/intelligence/`) — 14 languages configured, degrading to a text fallback when a server isn't installed instead of failing.
- **Rails semantic index** (`src/domains/rails/`) — 13 scanners (controller/model/job/mailer/policy/concern/migration/schema/view/rspec/routes/gem/service) feeding a graph store and query engine.
- A **benchmark harness** (`src/benchmark/`) — scores installed models on JSON validity and tool-calling correctness, with latency/tokens-per-sec.
- A **centralised, immutable state store** (`src/runtime/store.ts`) that receives events from all actors, reduces them, and feeds the TUI renderer.
- An **orchestrator** (`src/orchestration/`) that models plan steps, detects loops, performs topological dependency ordering with parallel execution, retries, checkpoints, and roll‑backs.
- A **plugin‑style tool registry** (`src/tools/`, 35+ tools) for exposing filesystem, git, github, sqlite, shell, LSP, and Rails capabilities to the LLM (plus an opt-in `docker` tool), with `DynamicToolSelector` (`src/tools/discovery.ts`) pruning which tools are exposed per turn. All file access goes through one `WorkspaceGuard` (§7.17).
- **Learning + memory** (`src/learning/`, `src/memory/`) — episode recording, grading, reflection, skill synthesis, and a SQLite conversation store.
- An **MCP client** (`src/mcp/`) for registering external MCP servers' tools into the same registry.
- **Documentation index** (`src/docs/`) — `npm run docs:ingest -- <id...>` fetches DevDocs' pre-built per-library JSON bundles (no live scraping) and indexes them into a local SQLite FTS5 store (`.nexum/docs.db`); `search_docs`/`get_doc`/`list_doc_sources` tools expose it, auto-scoped to doc sources relevant to the current workspace (`src/docs/workspace-detect.ts` — reuses the Rails module's `discoverWorkspace` for Ruby/Rails, plus `package.json`/`tsconfig.json`/`go.mod`/`Cargo.toml`/Python markers for the rest). Missing sources are fetched on demand, query-driven (`src/docs/lazy.ts`): cached workspace sources are searched first, a source is downloaded only when the query names it or nothing cached matches, at most 2 per call; failures cool down for 10 minutes and concurrent requests share one download.
- **Capability report** (`src/cli/capabilities.ts`) — an offline snapshot of what is active, lazily available, degraded (with a fix) or off, limited to what the workspace needs (LSP servers only for detected languages, `gh` only for GitHub remotes). Startup logs each degraded feature; `npm run doctor` lists the rest. `Agent.getCapabilities()` exposes it.
- **Multi-step hint** (`src/orchestration/complexity.ts`) — a top-level request that looks like several dependent steps gets a status line suggesting `/plan`; it never starts a plan itself, is silent inside a running plan, and `NEXUM_PLAN_HINT=0` disables it.

The repository contains the full runtime, CLI, TUI, provider, and a large suite of unit tests that validate core behaviour.

---

## 2. Tech Stack

| Layer | Technology |
|------|--------------|
| **Language** | TypeScript (target ES2022) |
| **Runtime** | Node.js ≥ 22 |
| **Package manager** | npm (lockfile `package-lock.json`) |
| **Testing** | Jest with `ts-jest` preset |
| **Linting** | ESLint (flat config, `eslint.config.js`) with `@typescript-eslint` plugin |
| **Formatting** | Prettier (`.prettierrc.json`) |
| **CLI / UI** | Ink (React‑style terminal UI) |
| **Docker sandbox** | Custom Docker image `nexum-sandbox:latest` used by `ShellTool` and the script runners |
| **LLM provider** | Ollama REST API – local (`http://localhost:11434`) or cloud (`OLLAMA_API_KEY`); both speak the same native `/api/chat` shape |
| **Local database** | `better-sqlite3` — agent memory (`.nexum/memory.db`) and the `sqlite_query` tool |
| **Build** | TypeScript compiler (`tsc`) producing `dist/` |
| **Version control** | Git (runtime tracks branch, ahead/behind, file list) |

---

## 3. Testing Framework & How to Run Tests

The project uses **Jest** with the `ts-jest` preset.
- Configuration lives in `jest.config.js` (roots: `<rootDir>/tests`).
- Tests are located under the `tests/` directory mirroring the source layout (e.g. `tests/tools`, `tests/orchestration`, `tests/models`, `tests/benchmark`).

### Run the test suite

```bash
npm test          # unit + contract suites (~2,300 tests); Docker not required
SKIP_NETWORK_TESTS=true npm test   # skip suites that call real external APIs (Binance etc.)
npm run test:docker                # opt-in: sandbox boundary against a REAL Docker daemon
```

`npm run test:docker` (`tests/integration/`, gated by `NEXUM_DOCKER_TESTS=1`) needs the sandbox image (`docker build -t nexum-sandbox:latest docker/nexum-sandbox/`). It verifies secret masking, read-only `.git` internals and `.nexum/`, write scope, no network, dropped capabilities, host-uid writes, and the docker tool's egress/ownership rules. Run it after touching `src/tools/shell.ts`, `src/tools/docker-tools.ts`, `src/core/fs/`, or `docker/`.

You can also watch tests during development with the standard Jest `--watch` flag (e.g. `npx jest --watch`).

---

## 4. Linting & Formatting Conventions

- **ESLint** (`npm run lint`, flat config in `eslint.config.js`) covers `src` and `tests` and respects the TypeScript project `tsconfig.eslint.json`.  Notable rule overrides:
  - `@typescript-eslint/no-explicit-any` is turned **off** (allowed).
  - Unused‑variable warnings ignore identifiers starting with `_`.
- **Prettier** (`npm run format:check`) enforces a 120‑character line width, trailing commas, and semicolons.  The formatter runs on the same source files as ESLint.
- `npm run release:check` runs lint, format check, build, tests and the package check in one go.

---

## 5. Build System & Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compiles TypeScript (`src/ → dist/`) using `tsc` and the `tsconfig.json` configuration. |
| `npm start` | Starts the production TUI (`node dist/ui/index.js`). |
| `npm run dev` | Runs the TUI directly from source via `tsx src/ui/index.ts` (no build step). |
| `npm run dev:legacy` | Runs the older CLI entry point (`src/cli/tui.ts`). |
| `npm run benchmark` | Scores installed local + cloud models on JSON validity + tool-calling (`src/benchmark/cli.ts`). |
| `npm run lint` | Executes ESLint over source and test files. |
| `npm run format:check` | Runs Prettier in check mode. |
| `npm run doctor` / `npm run migrate` | Environment diagnostics / migrate legacy `.devagent` state. |
| `npm run docs:ingest -- <id...>` | Index DevDocs bundles into `.nexum/docs.db`. |
| `npm run package:check` | Packs, installs and smoke-tests the npm tarball. |
| `npm run test:docker` | Real-daemon sandbox suite (see §3). |
| `docker build -t nexum-sandbox:latest docker/nexum-sandbox/` | Builds the sandbox image used by `ShellTool` and the script runners. |

---

## 6. Key Directory Structure

```
.
├── .nexum/                  # runtime state (memory.db, checkpoint.json, config.json, backups/); legacy .devagent/ migrated on first run
├── bin/                     # CLI entry point
├── docker/nexum-sandbox/    # Dockerfile for the sandbox image
├── docs/                    # VitePress site + design docs (SPEC.md predates the src/ui/ layout — check code first)
├── scripts/                 # package check, termcn vendoring
├── src/
│   ├── agents/              # product agents (DevAgent, CryptoAgent)
│   ├── benchmark/           # model scoring harness
│   ├── cli/                 # Agent class, config, agent-tools wiring (registerBaseTools), rpc, doctor
│   ├── core/                # kernel contracts: tools, policy (engine, postures, rules), fs (WorkspaceGuard, secret scan)
│   ├── credentials/         # env/file/keychain/vault credential providers + scoping
│   ├── docs/                # DevDocs-backed documentation index
│   ├── domains/             # rails (semantic index + scanners), ruby (rubocop/rspec), trading
│   ├── evaluation/, evolution/   # evaluation framework, self-development loop
│   ├── intelligence/, lsp/  # LSP intelligence router, language server pool (14 languages)
│   ├── marketplace/         # plugin marketplace: signed install, strict tar extraction, sandboxed activation
│   ├── mcp/                 # MCP client + tool adapter
│   ├── models/              # provider adapters, model catalog, capability router
│   ├── orchestration/       # orchestrator, planner, loop detector, delegation
│   ├── platform/            # paths, environment, brand, plugin host/sandbox
│   ├── runtime/             # agent runtime, checkpoint, store, sessions, events
│   ├── safety/              # the single sensitive-path list
│   ├── subagents/           # SubagentService + providers
│   ├── tools/               # tools, packs, gateway/catalog, path-utils, verified-fs, command-runner
│   ├── ui/                  # Ink TUI (entry: src/ui/index.ts)
│   ├── web-service/, webhooks/   # outbound fetch (SSRF-guarded), verified webhook ingress
│   └── …                    # memory, rag, skills, jobs, observability, settings, …
├── tests/                   # Jest suites mirroring src/; tests/integration/ = opt-in real-Docker suite
├── AGENTS.md, SECURITY.md, STABILITY.md, CHANGELOG.md
├── eslint.config.js, .prettierrc.json, jest.config.js, tsconfig*.json
└── package.json
```

---

## 7. Notable Architecture Decisions & Conventions

1. **Single Source of Truth – the Store**
   - All UI components read from `src/runtime/store.ts`.  Events flow from actors → `EventBus` → `reduce` → new immutable state.  This guarantees deterministic rendering and makes time‑travel debugging possible.
2. **Bounded Buffers**
   - Conversation, logs, tool‑calls, and notifications have hard caps (`MAX_CONVERSATION = 500`, etc., `src/runtime/config.ts`, overridable via `NEXUM_MAX_*` env vars) to keep long sessions bounded in memory.
3. **Sanitisation of Text**
   - `sanitizeText` strips ANSI escape sequences and control characters before they enter the store, protecting the TUI from malicious output.
4. **Docker‑Sandboxed Shell Tool**
   - `ShellTool` (`src/tools/shell.ts`) runs each command via `docker run` with `--network=none`, `--user <host uid>`, `--cap-drop=ALL`, `no-new-privileges`, `--read-only` + tmpfs `/tmp`, memory/CPU/PID limits, a hard timeout and a 32 KiB output ceiling; it escalates kills if the container is stubborn. Mounts: the workspace (read-only except the write scope when one is set), `.git/hooks` + `.git/config` and `.nexum/`/`.devagent/` read-only (`.nexum` is created first so the container cannot plant one), every secret file masked with the empty `.nexum/sandbox-empty` file and secret directory with an empty tmpfs (including hardlink aliases). The project/Ruby script runners execute through the same `ShellTool` — never spawn them on the host directly. With `sandbox: false` commands run on the host: every call then requires confirmation and credential env vars are stripped (`hostEnv()` in `src/tools/command-runner.ts`).
5. **Loop Detection**
   - `src/orchestration/loop-detector.ts` tracks repeated tool‑call signatures to avoid infinite retries, a common failure mode for LLM‑driven agents.
6. **Capability-Based Model Router**
   - `src/models/catalog.ts` discovers installed local + cloud models and tags each by name heuristic (coding/vision/reasoning/quick/tools — deliberately a heuristic, not real metadata; upgrade path is local `/api/show` capability flags). `src/models/router/router.ts` picks a local-first candidate per capability and falls back through the rest on `RateLimitError`/`TimeoutError`/network `TypeError`. `Agent.classifyCapability` (`src/cli/agent.ts`) routes non-critical turns to `quick`, screenshot/image mentions to `vision`, and architecture/trade-off questions to `reasoning` — silently falling back to the primary model when no matching model is installed, never breaking the turn.
7. **Checkpoint/Resume**
   - `src/runtime/checkpoint.ts`'s `CheckpointStore` does an atomic (`tmp` + `rename`) JSON save after every orchestrator step transition and replan; `Orchestrator.run()` clears it on full completion. `sanitizeResumedSteps` resets any non-terminal step status to `pending` on resume — a crashed process's in-flight step outcome is unknown, so it's safely retried rather than trusted.
8. **Parallel-Ready Orchestrator**
   - `Orchestrator.run()` fans out every currently-ready step (dependencies satisfied) via `Promise.all` each round, instead of one at a time — independent coder/reviewer/tester-style steps overlap in-flight.
9. **Planner with Dependency Graph**
   - Steps (`PlanStep`) declare `dependencies` and optional `rollbackCommand`.  The orchestrator resolves a topological order, marks blocked/skipped steps on cascade failure, and can re‑plan on failures.
10. **Extensible Tool Registry**
    - `src/tools/registry.ts` registers tools with name, description and JSON‑schema parameters, enabling the LLM to discover capabilities programmatically. `src/tools/discovery.ts`'s `DynamicToolSelector` prunes which tool schemas are actually sent to the model each turn (heuristic/llm/hybrid modes) instead of exposing the full registry every time.
11. **Host-Side Infra Tools Are Allowlists**
    - `GitTool` (host): allowlisted subcommands; blocks force/hard flags, pushes to protected branches (incl. `HEAD:main` refspecs), options that run commands/write or read host files (`--upload-pack`, `--receive-pack`, `--exec`, `--output`, `--no-index`, `commit -F`, `blame --contents`, `--pathspec-from-file`, …, matched by unique prefix too), and push/pull to anything but a configured remote.
    - `DockerTool` is **opt-in** (`dockerTool` / `NEXUM_DOCKER_TOOL=1`): flag allowlists for `run`/`exec`/`build`, no bind mounts or host namespaces, everything labelled `nexum.agent=true` and only labelled objects touched, containers on the internal `nexum-agent` network with no egress unless `dockerEgress` / `NEXUM_DOCKER_EGRESS=1`.
    - `GitHubTool` is a per-subcommand verb allowlist (no merge/close/delete/approve/release publishing/repo changes); `gh api` is GET/HEAD-only with no fields, `--input`, `graphql` or other hosts; body/template files go through the guard (`SECURITY.md` §6). `SqliteQueryTool` is read-only (SELECT/PRAGMA/EXPLAIN only).
    - The guard refuses every mutation under `.nexum/` and `.devagent/` (config, plugin installs, trust stores): configuration and trust are changed by the user, never by agent tools.
    - Workspace trust (`src/cli/workspace-trust.ts`, `src/cli/trust.ts`): workspace `.nexum/config.json`, `.env`, `mcp-trust.json` and `publisher-trust.json` apply only once the user trusts their exact contents (record in `~/.nexum/trusted-workspaces.json`, bound to a digest). Untrusted, `loadConfig` applies only `WORKSPACE_SAFE_KEYS` and skips workspace `.env` files. Add new config keys to `WORKSPACE_SAFE_KEYS` only if they cannot run code, loosen isolation or redirect data. Code that writes a trust-bearing file on the user's behalf must go through `preservingTrust`. Never reintroduce an unconditional `dotenv/config` import.
    - Marketplace (`src/marketplace/`): `install()` requires, by default, a signature from a key in the publisher trust store plus a signed `sha256`, then unpacks with the strict extractor in `tar.ts` and validates `package.json`. `activate()` re-checks signature and hash and runs the plugin via `IsolatedPluginSandbox` with `transport: "process"` (Node `--permission`, read-only access to its own package, empty env, network entry points disabled before the plugin loads). Nothing activates plugins automatically. Never load marketplace code in-process or with the `worker` transport.
12. **Environment‑Driven Configuration**
    - Runtime values such as `NEXUM_MODEL`, `NEXUM_TIMEOUT_MS`, `NEXUM_SHELL_IMAGE`, `NEXUM_TOOL_SELECTION_MODE` are read from `process.env` (via `dotenv`, with deprecated `DEVAGENT_*` fallbacks — see `src/platform/environment.ts`), see `src/cli/config.ts` and the README's environment variable table.
13. **Multiple API Keys — Ollama Cloud Key Pool, Not Multi-Vendor Routing**
    - `CliConfig.apiKeys: string[]` (`src/cli/config.ts`, from `OLLAMA_API_KEY` + comma-separated `OLLAMA_API_KEYS` + config-file `apiKeys`, deduped) is a pool of Ollama Cloud keys for one provider — e.g. separate accounts for availability. `Provider` (`src/models/adapters/provider.ts`) tracks a rotation index; on a cloud-tier 429 it rotates to the next key and retries before throwing `RateLimitError`. It does not route by model vendor and does not reach non-Ollama endpoints — `Provider.chat` always POSTs to Ollama's native `/api/chat` shape.
14. **Workspace Root Resolution — Git Root First, Like Most Editor Tooling**
    - `findWorkspaceRoot` (`src/platform/paths.ts`) walks up from `cwd` to the nearest `.git` (dir or file — worktrees work), then falls back to the nearest existing `.nexum/` (or legacy `.devagent/`), then `cwd`. Git-first avoids the old chicken-and-egg bug where a first-ever run in a project, or a run from a subdirectory that hadn't had a state dir created yet, silently fell back to `cwd` and started a disconnected state dir (fragmented history/memory/config per launch directory). All workspace-scoped state hangs off this resolution — `NEXUM_WORKSPACE` overrides it outright (deprecated `DEVAGENT_WORKSPACE` also honored).
15. **Testing Philosophy**
    - Unit tests assert the generated `docker run` arguments and mock provider responses (`fetch`); `tests/integration/` checks the same boundary against a real Docker daemon (`npm run test:docker`). `git` tests run the real binary (including escape attempts against a local bare remote); docker-tool rejections are pure argument validation and need no daemon. Browser tools (`src/browser/`) are tested against a real headless Chromium (`data:` URLs, offline/deterministic), not a Playwright mock. Tests assert state transitions and tool outputs rather than UI output, making them fast and deterministic.
16. **ESM Migration — Jest Runs in Real ESM Mode, Pinned to Jest 30**
    - The project is `"type": "module"`; `package.json`'s `test` script runs `node --experimental-vm-modules .../jest`, and `jest.config.js` uses `ts-jest/presets/default-esm`. `tests/jest.setup.js` restores `jest.fn()`/`spyOn()`/`mock()` as a global (not auto-injected in real ESM mode). `jest.mock()` doesn't auto-hoist under ESM — the files that need it (6 today) use `jest.unstable_mockModule()` + dynamic `await import()` instead (see `tests/tools/shell.test.ts` for the pattern). Jest was bumped from 29 to 30 specifically to fix a real, recurring `signal-exit` dual-package-hazard crash (`Export '__signal_exit_emitter__' is not defined`) that only showed up under `--experimental-vm-modules` — confirmed via multiple full-suite reruns before and after the bump. Don't downgrade Jest without re-verifying that issue doesn't come back.
17. **One Filesystem Boundary — `WorkspaceGuard`**
    - Every file-touching tool resolves paths through the single guard built in `registerBaseTools` (`src/core/fs/workspace-guard.ts`): containment (symlinks resolved), optional write scope (`writeScope` / `NEXUM_WRITE_SCOPE`), secrets (list in `src/safety/path-policy.ts`, checked on requested **and** resolved path, plus hardlink aliases of workspace secrets and `~/.ssh`, `~/.aws`, …), no writes under `.git/`, no deleting the root or directories holding secrets. Tools call `guardPath()` and do I/O through `readVerified`/`writeVerified` (`src/tools/verified-fs.ts`), which re-check the target around the syscall. Never add a tool that touches the filesystem with raw paths; take a `WorkspaceBoundary` and go through the guard. Tool-facing errors stay `PathEscapeError` / `SensitivePathError` (the agent loop and grader key on those names).
18. **Policy: First Decision Wins**
    - `RulePolicyEngine` returns the first rule decision. Denial rules (deny lists, risk ceiling, execution profile, `ModeRestrictionRule`, `BudgetGuardRule`) always run first, then the posture's rules, then `ConfirmationRule`. The CLI agent uses the `parity` posture, whose arg rules (`DestructiveShellRule`, `GitPublishRule`, `DeleteFileRule`) run before the confirmation ladder — a rule that returns `allow` bypasses confirmation, but never a denial. Tools that must always ask declare it structurally (`policy.confirmation: "required"`, `execution.isolation: "host"`), and arg rules must not grant benign allows to host execution.

---

## 8. Getting Started (quick checklist)

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Build the sandbox image** (required for any `shell`/`docker` tool usage)
   ```bash
   docker build -t nexum-sandbox:latest docker/nexum-sandbox/
   ```
3. **Run the test suite** to ensure everything works
   ```bash
   npm test
   ```
4. **Start the development UI**
   ```bash
   npm run dev
   ```
5. **Score installed models** (optional — needs a reachable local Ollama and/or `OLLAMA_API_KEY`)
   ```bash
   npm run benchmark
   ```
6. **Build for production**
   ```bash
   npm run build && npm start
   ```

---

*This file is intended for future Nexum sessions to quickly understand the repository layout, tooling, and architectural conventions.*
