# Nexum Security & Trust Model

> **Status:** Developer Preview — this document describes the *intended* trust
> model. Some surfaces are fully implemented; others are explicitly marked as
> **incomplete** below. Treat any surface marked **INCOMPLETE** as not yet
> safe to rely on for security guarantees.

This document explains which execution surfaces in Nexum are trusted,
sandboxed, networked, credential-bearing, or externally mutating — and what
guarantees each surface provides (and does not).

## 1. Trust Surfaces

Nexum exposes several execution surfaces. Each has a distinct trust profile:

| Surface                | Trust Level      | Network | Credentials | Mutates Host FS | Mutates External |
| ---------------------- | ---------------- | ------- | ----------- | --------------- | ---------------- |
| Host shell (no Docker) | **trusted host** | yes     | yes         | yes             | yes              |
| Docker sandbox shell   | **sandboxed**    | no *    | no          | container only  | no *             |
| Filesystem tools       | **trusted host** | no      | no          | yes             | no               |
| Git tools              | **trusted host** | yes     | yes         | yes             | yes              |
| GitHub tools           | **trusted host** | yes     | yes         | no              | yes              |
| Browser (Playwright)    | **networked**    | yes     | no          | no              | yes              |
| MCP servers            | **trusted host** | yes     | yes         | yes             | depends          |
| Trading tools          | **trusted host** | yes     | yes         | no              | financial risk   |
| Webhook ingress        | **trusted host** | no      | yes (HMAC)  | no              | no               |
| Web service (fetch)    | **networked**    | yes     | no          | no              | no               |
| Plugin marketplace     | **INCOMPLETE**   | yes     | no          | yes             | yes              |
| Plugin runtime         | **INCOMPLETE**   | depends | depends     | depends         | depends          |

\* Docker sandbox uses `--network=none` by default and blocks host mounts.

## 2. What Each Surface Provides

### 2.1 Host Shell (no Docker)

- **Who:** The user's own account on the host machine.
- **What it can do:** Anything the user can do — read/write files, run
  processes, make network calls, push git commits, place trades.
- **Safety net:** `PolicyEngine` confirmation gates for destructive actions
  (force-push, `rm -rf`, privileged docker, delete file). These are **UX
  safety nets, not security boundaries**.
- **Recommendation:** Run with Docker sandbox enabled (`sandbox: true` in
  config) for any agent operating on code you don't fully trust.

### 2.2 Docker Sandbox Shell

- **Who:** A containerized subprocess with no host network access.
- **What it can do:** Read/write inside the container, run processes inside
  the container, use CPU/memory up to the configured limits.
- **What it cannot do:** Reach the host network, mount host paths, gain
  privileges, persist beyond the run.
- **Enforced by:** `--network=none`, `--pids-limit`, `--memory`, `--cpus`,
  `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and a hard wall-clock
  timeout. `DestructiveShellRule` blocks `--privileged` and other escape
  vectors at the policy layer.
- **Recommendation:** This is the **default** sandbox for `run_shell` calls.

### 2.3 Filesystem Tools

- **Who:** The host user.
- **What it can do:** Read and write files inside the workspace root.
- **What it cannot do:** Write outside the workspace root (path containment
  via `WorkspaceGuard`); read sensitive files (`.env`, `id_rsa`, `*.pem`,
  `*.key`, `secrets/` directories — blocked by `isSensitivePath()`).
- **Recommendation:** Workspace containment is enforced; sensitive files
  are redacted. Treat this as a workspace-scoped trusted surface.

### 2.4 Git / GitHub Tools

- **Who:** The host user, with whatever GitHub credentials are configured.
- **What it can do:** Run `git` commands in the workspace; call the GitHub
  API (push, PR, issue) using the configured token.
- **Safety net:** `GitPublishRule` blocks `git push --force` to `main`/`master`
  by default. Force-push to other branches requires explicit confirmation.
- **Recommendation:** Use a GitHub fine-grained PAT scoped to the specific
  repo. Never use a global PAT for an autonomous agent.

### 2.5 Browser (Playwright)

- **Who:** A Chromium instance under Nexum's control.
- **What it can do:** Navigate, click, type, screenshot, evaluate JS, make
  any network request from inside the browser.
- **Safety net:** Browser tools are gated by the PolicyEngine like any other
  tool. Confirmation is required for high-risk actions.
- **Recommendation:** Run in a separate Docker profile when browsing
  untrusted URLs.

### 2.6 MCP (Model Context Protocol) Servers

- **Who:** External processes spawned and controlled by Nexum.
- **What they can do:** Whatever their tools do — read/write files, make
  HTTP calls, run shell commands. MCP servers run as **trusted host**
  subprocesses.
- **Safety net:** `McpToolAdapter` extracts security metadata from each
  MCP tool (risk, side effects, network requirements) and routes them
  through the same `ToolGateway` policy pipeline as built-in tools.
- **Recommendation:** Only configure MCP servers you trust. MCP servers
  inherit host-level trust.

### 2.7 Trading Tools

- **Who:** The host user, with whatever exchange API credentials are
  configured.
- **What it can do:** Place real market orders if credentials permit;
  stream real-time market data; run backtests.
- **Safety net:** Trading tools have `risk: "critical"` and
  `externalMutation: true` metadata. Paper trading is supported and is
  the default.
- **Recommendation:** **Never** configure live trading credentials for an
  autonomous agent without explicit human-in-the-loop approval for every
  order.

### 2.8 Webhook Ingress

- **Who:** External systems (e.g. Binance WebSocket, GitHub webhooks).
- **What it can do:** Receive events; route them through trusted rules to
  agent sessions.
- **Safety net:** Every incoming webhook is **HMAC-SHA256 verified** against
  the endpoint's shared secret. Unverified events are recorded but never
  reach handlers. Timestamp freshness window (5 min default) prevents replay
  attacks.
- **Recommendation:** Treat webhook endpoints as semi-public. Rotate
  secrets regularly.

### 2.9 Web Service (fetch)

- **Who:** Nexum itself, making outbound HTTP requests.
- **What it can do:** Fetch arbitrary URLs, extract content from HTML.
- **Safety net:** None at the network layer. Fetch is gated by the
  PolicyEngine like any other tool.
- **Recommendation:** Use with workspace guard + policy posture
  `restricted` when running on untrusted prompts.

### 2.10 Plugin Marketplace — INCOMPLETE

- **Status:** **INCOMPLETE.** The marketplace architecture is in place
  (MarketplaceService, HttpMarketplaceSource, NpmMarketplaceSource,
  GitMarketplaceSource, sha256 integrity verification) but the **trust
  model is not yet fully implemented**.
- **What's missing:**
  - Publisher authenticity (no signature verification)
  - Capability scoping (plugins can declare capabilities but they are
    not enforced at install time)
  - Sandbox isolation (installed plugins run with full host trust)
  - Revocation (no mechanism to revoke a published plugin)
  - Dependency trust (no analysis of plugin's transitive deps)
- **Recommendation:** **Do not enable the marketplace in production
  until the trust model is complete.** The marketplace is currently
  suitable for development and trusted-internal use only.

### 2.11 Plugin Runtime — INCOMPLETE

- **Status:** **INCOMPLETE.** Plugins registered via `PluginHost.register()`
  run with full host trust. There is no sandboxing layer between a plugin
  and the host runtime.
- **What's missing:**
  - Plugin capability enforcement (plugins declare `provides` but the host
    does not yet enforce that they only call capabilities they declared)
  - Plugin resource quotas (CPU, memory, wall-clock)
  - Plugin isolation (plugins share the host's event loop, filesystem,
    and process)
- **Recommendation:** Treat plugins as trusted code (like npm dependencies).
  Only install plugins from publishers you trust.

## 3. Policy Engine

The `PolicyEngine` is the central authority for "may this agent run this
tool?". It applies rules in order:

1. **`DenyToolsRule`** — blocklist specific tool ids.
2. **`DenyRiskAboveRule`** — block tools above a risk threshold.
3. **`ModeRestrictionRule`** — restrict tools by execution mode.
4. **`BudgetGuardRule`** — block tools when budget is exhausted.
5. **`ConfirmationRule`** — require human approval for high-risk actions.
6. **`ExecutionProfileRule`** — apply posture-specific restrictions.

The policy engine narrows capabilities; it never widens them. Children
inherit the parent's policy posture (with possible further narrowing).

## 4. Capability Tags

Every tool declares:

- `risk`: `"read" | "low" | "medium" | "high" | "critical"`
- `sideEffects`: filesystem, process, network, external mutations
- `networkRequirements`: egress needed?
- `idempotency`: safe to retry?
- `reversibility`: can the effect be undone?

These tags drive policy decisions and UI surfacing (confirmation dialogs).

## 5. Confirmation Gates

`ApprovalBroker` classifies destructive actions and routes them through
human-in-the-loop confirmation when listeners are attached. Without
listeners, destructive actions are **blocked** by default (fail-safe).

## 6. What This Is Not

This trust model is **not**:

- A formal security audit.
- A guarantee against prompt injection.
- A guarantee against malicious tool implementations.
- A guarantee against supply-chain attacks via plugins or MCP servers.
- A replacement for OS-level sandboxing (Docker, VMs) when running
  untrusted code.

## 7. Reporting Security Issues

If you discover a security vulnerability in Nexum:

1. **Do not** open a public GitHub issue.
2. Email `shubhamtaywade82@gmail.com` with details and a repro.
3. Expect a response within 72 hours.
4. Do not publish the vulnerability until a fix is released.

## 8. Threat Model Summary

| Threat                        | Mitigation                              | Status       |
| ----------------------------- | --------------------------------------- | ------------ |
| Prompt injection              | PolicyEngine + confirmation gates        | Partial      |
| Malicious tool implementation | Tool risk tags + policy + sandbox       | Partial      |
| Host filesystem escape        | WorkspaceGuard + path containment       | Implemented  |
| Sensitive file read           | `isSensitivePath()` redaction            | Implemented  |
| Privilege escalation (Docker) | `--cap-drop=ALL` + `no-new-privileges`   | Implemented  |
| Network egress (sandbox)      | `--network=none`                        | Implemented  |
| Resource exhaustion (sandbox) | `--pids-limit`, `--memory`, `--cpus`    | Implemented  |
| Replay attack (webhooks)      | HMAC-SHA256 + timestamp window           | Implemented  |
| Plugin supply chain           | sha256 integrity + (future: signatures)  | **INCOMPLETE** |
| Plugin capability escalation  | (future: capability enforcement)        | **INCOMPLETE** |
| Long-running runaway agent   | LoopDetector + budget limits            | Implemented  |
| Crash recovery                | CheckpointStore + atomic writes         | Implemented  |

## 9. Stability Tiers

See [STABILITY.md](./STABILITY.md) for the public API stability tiers
(stable, experimental, internal).

---

**Last updated:** 2026-09-16
**Nexum version:** 2.0.0-alpha.1
**Review cycle:** This document is reviewed with every minor release.
