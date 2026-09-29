# Nexum Security & Trust Model

> **Status:** Developer Preview. This document describes what the code on
> this branch actually enforces. Surfaces marked **INCOMPLETE** are not safe
> to rely on for security guarantees. Known gaps are listed in §9 — read
> them before running Nexum on anything you cannot afford to lose.

Nexum runs an LLM that chooses tool calls. Assume the model can be steered
by anything it reads (prompt injection via files, web pages, issues, tool
output). The boundaries below are designed so that a steered model is
contained by **isolation** (what code can physically reach), not merely by
**policy** (what the model is asked or allowed to request).

## 1. Trust Surfaces

| Surface                                | Runs where               | Network              | Sees secrets              | Can mutate                       |
| -------------------------------------- | ------------------------ | -------------------- | ------------------------- | -------------------------------- |
| `run_shell` (sandbox, default)         | Docker container         | none                 | no (masked)               | workspace (or write scope) only  |
| Project/Ruby script runners            | same sandbox             | none                 | no (masked)               | workspace (or write scope) only  |
| `run_shell` / runners, sandbox **off** | **host**                 | yes                  | **yes**                   | **anything your user can**       |
| Filesystem tools                       | host, via WorkspaceGuard | no                   | no                        | workspace (or write scope) only  |
| `search_code`, `sqlite_query`, LSP     | host, via WorkspaceGuard | no                   | no                        | no                               |
| `git`                                  | host                     | configured remotes   | uses your git credentials | repo + configured remotes        |
| `github` (`gh`)                        | host                     | GitHub               | uses your `gh` token      | GitHub (see §9)                  |
| `docker` (**opt-in**)                  | host daemon              | none by default      | no                        | agent-labelled containers/images |
| Browser (Playwright)                   | host Chromium            | yes                  | no                        | remote sites                     |
| Web fetch                              | host                     | public internet only | no                        | no                               |
| Webhook ingress                        | host                     | inbound              | HMAC secrets              | triggers agent handlers          |
| MCP servers                            | host subprocesses        | depends              | depends                   | depends (trusted code)           |
| External-agent subagents               | host subprocesses        | yes                  | API key passed via env    | anything the agent CLI can       |
| Trading tools                          | host                     | exchanges            | exchange keys             | **financial** (orders)           |
| Plugin marketplace                     | host                     | yes                  | no                        | **INCOMPLETE**                   |
| Plugin runtime                         | host (opt. worker)       | depends              | depends                   | **INCOMPLETE**                   |

## 2. Filesystem boundary (WorkspaceGuard)

Every agent file tool — read, write, list, delete, mkdir, copy, move,
patch, append, apply_patch/edit_file_lines, backup, watch — plus
`search_code`, `sqlite_query` and LSP file access resolves paths through
**one** `WorkspaceGuard` (`src/core/fs/workspace-guard.ts`), shared across
packs by `registerBaseTools`. Per operation it enforces:

1. **Containment** — the real path (symlinks resolved) stays inside the
   workspace; symlinked directories pointing outside are rejected.
2. **Write scope** — when `writeScope` is set (config `writeScope` or
   `NEXUM_WRITE_SCOPE`, relative to the workspace root), every mutation
   must land inside it.
3. **Secrets** — one list (`src/safety/path-policy.ts`): `.env*`,
   `credentials.json`, `id_rsa`/`id_ed25519`/`id_ecdsa`, `*.pem`/`*.key`/
   `*.p12`/`*.pfx`, `secret(s)/`, `.ssh/`, `.aws/`, `.gnupg/`. Mutations are
   always refused; for agent tools, content-revealing operations (read,
   copy source, search) are refused too. Judged on the requested **and**
   the resolved path, so a symlink alias of a secret is the secret.
4. **Hardlinks** — a multi-link file sharing a device+inode with a
   workspace secret or with a file in `~/.ssh`, `~/.aws`, `~/.gnupg`,
   `~/.kube`, `~/.docker`, `~/.azure`, gcloud, `.netrc`,
   `.git-credentials`, `.npmrc`, `.pypirc` is treated as that secret. If the
   workspace is too large to scan, any multi-link file is treated as a
   possible secret (fail closed).
5. **Git internals** — file tools never write under `.git/` (a planted
   hook or `core.fsmonitor` would run on the host at the next git command).
6. **Destructive shapes** — the workspace root cannot be deleted or moved;
   a directory holding protected files cannot be deleted.
7. **Races** — reads open the file then re-resolve through the guard and
   require the same inode; writes go through an exclusively created temp
   file proven to sit at the approved location before any content is
   written. Delete/move/mkdir re-validate immediately before the syscall
   (narrowed, not closed — see §9).

`search_code` also passes ripgrep exclusion globs for secrets _after_ any
caller glob (ripgrep lets later globs win) and drops matches from
hardlink aliases.

## 3. Shell sandbox (`run_shell`, script runners)

Default (`sandbox: true`). Each call runs `docker run` with:

- `--network=none`, `--memory`, `--cpus`, `--pids-limit=128`, hard timeout;
- `--user <host uid>:<host gid>`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, `--read-only` root filesystem with a
  tmpfs `/tmp` and `HOME=/tmp`;
- the workspace mounted read-write — or read-only with only the write scope
  read-write when one is set;
- `.git/hooks` and `.git/config` mounted read-only;
- every secret file masked with `/dev/null` and every secret directory with
  an empty tmpfs (same list as §2, including hardlink aliases); the shell
  refuses to start if the secret scan exceeds 100k entries.

`run_tests` / `run_lint` / `run_format` / `run_build` and `run_rubocop` /
`run_rspec` execute through the same sandbox (package scripts and Gemfiles
are code the agent can edit). Paths starting with `-` are rejected (option
injection).

Verified against a real Docker 29 daemon, as root and as an unprivileged
user, by `npm run test:docker` (§8).

### Sandbox disabled (`NEXUM_SANDBOX=0` / `sandbox: false`)

Commands run on the host with your privileges; nothing can be isolated.
Nexum then: requires human confirmation for **every** `run_shell` and
script-runner call (argument-based "benign command" allowances do not
apply to host execution), and strips credential-looking variables
(`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE*`)
from the child environment. An operator who also enables auto-approve
has removed the last check.

## 4. `docker` tool (opt-in)

Access to the Docker daemon is root-equivalent on the host, so the tool is
**not mounted** unless `dockerTool: true` / `NEXUM_DOCKER_TOOL=1`. When on:

- **Ownership:** everything it creates carries `nexum.agent=true`;
  `stop`/`rm`/`logs`/`inspect`/`exec` accept only labelled targets;
  `ps`/`images` are filtered to them.
- **run/exec:** flag allowlist — named volumes or tmpfs only (no bind
  mounts), no host/container network modes, devices, capabilities,
  security-opt, `--env-file`, `--volumes-from`, or bare `-e NAME` (host env
  pass-through).
- **Egress:** containers join `nexum-agent`, an `--internal` network the
  tool creates (agent containers reach each other by name; nothing reaches
  out); an existing non-internal network of that name is refused. Builds
  run with `--network=none`. `-p` is unavailable. `dockerEgress: true` /
  `NEXUM_DOCKER_EGRESS=1` opts back into bridge networking with
  loopback-only `-p`.
- **build:** one local context inside the workspace containing no secrets
  or secret aliases; Dockerfile inside the workspace; no `-o`, `--secret`,
  `--ssh`, `--iidfile`, cache import/export; `--build-arg NAME=VALUE` only.
- **Not offered:** `compose` (compose files can declare anything), `cp`.

## 5. `git` tool (host)

Allowlisted subcommands; force/hard flags blocked; pushes to
`main`/`master`/`develop`/`prod(uction)`/`release/*` blocked, including
refspec destinations (`HEAD:main`). Options that turn git into a host
escape are blocked, including git's unique-prefix abbreviations (`--out=`):
`--upload-pack`, `--receive-pack`, `--exec` (run commands), `--output`
(write anywhere), `--no-index`, `blame --contents`/`-S`/
`--ignore-revs-file`, `commit -F`/`--file`/`-t`/`--template`,
`--pathspec-from-file`, `-O`/`--orderfile` (read host files), `--repo`.
`push`/`pull` only target remotes already configured (`git remote`). The
parity posture asks before every push.

## 6. Other surfaces

- **Web fetch** (`NodeFetchProvider`): destinations are validated at
  connect time (no DNS-rebinding window); loopback, private, link-local
  (incl. cloud metadata), CGNAT, multicast, reserved and IPv4-mapped ranges
  are refused unless `allowPrivateNetwork`; http/https only; every redirect
  hop re-validated; credentials dropped on cross-origin redirects;
  decompressed body capped (default 10 MiB).
- **Webhooks:** HMAC-SHA256 over `timestamp.rawBody`, freshness window
  (default 5 min), replays of an accepted signature rejected per endpoint,
  and handlers receive only the **signed** body. The event `type` is
  caller-asserted and unsigned. The replay cache is in memory: a restart
  re-opens the current window.
- **Credentials:** env/file/OS keychain/Vault providers; scoped views
  enforce names **and** tags (`declare(spec)`), `defaultScope` applies to
  unscoped access. Linux keychain writes pass the secret on stdin.
- **Browser:** a real Chromium on the host network. Treat as networked and
  able to reach anything the host can.
- **MCP servers, external-agent subagents, trading:** trusted host code.
  External agents (`claude -p`, `codex exec`, configured binaries) run as
  host processes with your account. The order-placing trading tool
  (`paper_trade`) is marked financial and always requires confirmation;
  market-data tools are read-only.

## 7. Policy engine

`RulePolicyEngine` evaluates rules in order and the **first decision
wins**. The CLI agent uses the `parity` posture: `DestructiveShellRule`,
`GitPublishRule`, `DeleteFileRule`, then (when configured) deny lists /
risk ceilings / execution profile, `ModeRestrictionRule`,
`BudgetGuardRule`, `ConfirmationRule`. Financial side effects always
require confirmation. `standard` and `restricted` postures confirm every
high / medium-risk call. Policy is a UX and intent layer; the isolation in
§2–§4 is what holds when the model is adversarial.

## 8. Verification

```bash
npm test                     # unit + contract suites (Docker not required)
docker build -t nexum-sandbox:latest docker/nexum-sandbox/
npm run test:docker          # real daemon: masking, git RO, write scope, no network,
                             # caps/no-new-privs, host uid, docker-tool egress & ownership
```

## 9. Known gaps

| Gap                                                                                                                                                                                                                                                     | Impact                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Plugin marketplace — INCOMPLETE.** `install()` verifies and caches the artifact but never extracts or activates it; signature mode defaults to `warn` (unsigned plugins install with a warning).                                                      | Not an activation path yet; do not treat it as a trust boundary.                              |
| **Plugin runtime — INCOMPLETE.** `PluginHost.register()` runs plugins in-process with full host trust; `sandboxPlugin` (policy mediation) and `IsolatedPluginSandbox` (`worker_threads` resource limits) are opt-in and are **not** OS-level isolation. | Only install plugins you would run as your own code.                                          |
| `github` tool blocks `merge`/`delete`/`close` verbs, but `gh api` can issue arbitrary API calls.                                                                                                                                                        | Scope the `gh` token (fine-grained, single repo).                                             |
| Parity posture: `DestructiveShellRule` allows non-destructive sandboxed shell commands before `ModeRestrictionRule`, so read-only agent modes can still write via the shell inside the sandbox.                                                         | Use `standard`/`restricted` postures when read-only modes must be strict.                     |
| Delete/move/mkdir symlink race is narrowed, not closed (Node has no `openat2(RESOLVE_BENEATH)`).                                                                                                                                                        | Requires a concurrent writer inside the workspace.                                            |
| Sandbox masks secrets present when the command starts; the webhook replay cache and hardlink inode cache (10 s) are in memory.                                                                                                                          | Restart re-opens the webhook window; a secret created mid-command is visible to that command. |
| Browser has host network access.                                                                                                                                                                                                                        | Do not browse untrusted sites with sensitive local services reachable.                        |
| Not a formal audit; no guarantee against prompt injection or malicious MCP servers/plugins.                                                                                                                                                             | Run untrusted workloads on a disposable machine or VM.                                        |

## 10. Reporting security issues

1. **Do not** open a public GitHub issue.
2. Email `shubhamtaywade82@gmail.com` with details and a repro.
3. Expect a response within 72 hours.
4. Do not publish until a fix is released.

See [STABILITY.md](./STABILITY.md) for API stability tiers.

---

**Last updated:** 2026-09-29 · **Nexum version:** 2.0.0-alpha.2 (plus unreleased changes on this branch)
