# Nexum Security & Trust Model

> **Status:** Developer Preview. This document describes what the code on
> this branch actually enforces. Known gaps are listed in §12 — read
> them before running Nexum on anything you cannot afford to lose.

Nexum runs an LLM that chooses tool calls. Assume the model can be steered
by anything it reads (prompt injection via files, web pages, issues, tool
output). The boundaries below are designed so that a steered model is
contained by **isolation** (what code can physically reach), not merely by
**policy** (what the model is asked or allowed to request).

## 1. Trust Surfaces

| Surface                                | Runs where                   | Network              | Sees secrets              | Can mutate                       |
| -------------------------------------- | ---------------------------- | -------------------- | ------------------------- | -------------------------------- |
| `run_shell` (sandbox, default)         | Docker container             | none                 | no (masked)               | workspace (or write scope) only  |
| Project/Ruby script runners            | same sandbox                 | none                 | no (masked)               | workspace (or write scope) only  |
| `run_shell` / runners, sandbox **off** | **host**                     | yes                  | **yes**                   | **anything your user can**       |
| Filesystem tools                       | host, via WorkspaceGuard     | no                   | no                        | workspace (or write scope) only  |
| `search_code`, `sqlite_query`, LSP     | host, via WorkspaceGuard     | no                   | no                        | no                               |
| `git`                                  | host                         | configured remotes   | uses your git credentials | repo + configured remotes        |
| `github` (`gh`)                        | host                         | GitHub               | uses your `gh` token      | issues/PRs only (§6)             |
| `docker` (**opt-in**)                  | host daemon                  | none by default      | no                        | agent-labelled containers/images |
| Browser (Playwright)                   | host Chromium                | yes                  | no                        | remote sites                     |
| Web fetch                              | host                         | public internet only | no                        | no                               |
| Webhook ingress                        | host                         | inbound              | HMAC secrets              | triggers agent handlers          |
| MCP servers                            | host subprocesses            | depends              | depends                   | depends (trusted code)           |
| External-agent subagents               | host subprocesses            | yes                  | API key passed via env    | anything the agent CLI can       |
| Trading tools                          | host                         | exchanges            | exchange keys             | **financial** (orders)           |
| Workspace settings (`.nexum/`, `.env`) | configure Nexum itself       | —                    | —                         | apply only once trusted (§8)     |
| Marketplace plugins (`activate`)       | Node process, `--permission` | none (§7)            | no (own files, empty env) | nothing on disk; bridge only     |
| Plugins registered in code             | host process                 | yes                  | yes                       | anything (trusted code)          |

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
   **Nexum state** — nor under `.nexum/` or `.devagent/` (config, plugin
   installs, publisher trust store, MCP approvals): an agent that could
   write there could switch its own sandbox off or trust its own plugins.
   Reading is allowed; `credentials.json` and `*.pem` there are secrets
   (rule 3).
6. **Destructive shapes** — the workspace root cannot be deleted or moved;
   a directory holding protected files cannot be deleted.
7. **Races** — reads open the file then re-resolve through the guard and
   require the same inode; writes go through an exclusively created temp
   file proven to sit at the approved location before any content is
   written. Delete/move/mkdir re-validate immediately before the syscall
   (narrowed, not closed — see §12).

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
- `.nexum/` (created first if missing, so the container cannot create it)
  and `.devagent/` mounted read-only — where they really live, if symlinked;
- every secret file masked with an empty read-only file
  (`.nexum/sandbox-empty`, a workspace path Docker Desktop can always
  share; `/dev/null` only if no state directory is usable) and every secret
  directory with an empty tmpfs (same list as §2, including hardlink
  aliases); the shell refuses to start if the secret scan exceeds 100k
  entries.

`run_tests` / `run_lint` / `run_format` / `run_build` and `run_rubocop` /
`run_rspec` execute through the same sandbox (package scripts and Gemfiles
are code the agent can edit). Paths starting with `-` are rejected (option
injection).

Verified against a real Docker 29 daemon on Linux, as root and as an
unprivileged user, by `npm run test:docker` (§11). Not yet run on Docker
Desktop (macOS/Windows) — see §11.

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

## 6. `github` tool (host)

`gh` runs with your GitHub token, so the tool allowlists verbs per
subcommand instead of blocking a few:

- `pr` list/view/diff/checks/status/create/comment/edit/review/ready
  (`review --approve` blocked); `issue` list/view/status/create/comment/
  edit; `release` list/view; `repo` view; `run` list/view/rerun. Merge,
  close, reopen, delete, lock, transfer, release create/upload/download,
  repo create/fork/clone/edit/archive, secrets, variables, `auth`,
  `extension`, `alias` and anything else are refused.
- `gh api` is read-only: one endpoint path (no URL, no `graphql` — it is
  always a POST), `--method` GET/HEAD only, headers limited to `Accept` and
  `X-GitHub-Api-Version`, no `-f`/`-F`/`--field`/`--raw-field`/`--input`
  (any of them turns the request into a write), no `--hostname`.
- `--body-file`/`-F`/`--template`/`-T` must name a workspace file the guard
  lets the agent read (never a secret, never outside the workspace, never
  stdin).

## 7. Plugins and the marketplace

**Install** (`MarketplaceService.install`): the signature policy runs
before anything is downloaded. The default is `signatures: "require"`: the
entry must be signed by a key **in the publisher trust store** (a signature
that only verifies against a key embedded in the entry proves nothing about
who signed it) and must carry a `sha256`, which the signature covers.
`"require-verified"` additionally requires a `verified` publisher; `"warn"`
and `"off"` must be configured explicitly. A present-but-invalid signature
is refused in every mode except `"off"`. The artifact is then hashed and
unpacked by a strict extractor (`src/marketplace/tar.ts`: regular files and
directories only — symlinks, hardlinks, devices, absolute paths, `..`,
duplicates, bad checksums and oversized archives are rejected) and its
`package.json` validated: `nexum` object present, id and version equal to
the signed entry, entry module a `.js`/`.mjs`/`.cjs` file inside the
package, declared `nexum.permissions` well-formed. Catalog ids/versions
cannot escape the cache directory; git sources clone with `--` before the
URL and `protocol.ext.allow=never`, and pack the plugin directory into a
deterministic tar so its sha256 can be signed.

**Activation** (`MarketplaceService.activate`, never automatic): signature
re-checked against the **current** trust store (removing a key revokes its
plugins), artifact re-hashed against the record and the signed sha256,
unpacked into a fresh private temp directory, then run in a separate Node
process under the permission model: `--permission
--allow-fs-read=<package dir>` (no reads elsewhere, no writes, no child
processes, no workers, no native addons, no WASI), an empty environment,
a heap cap and lifecycle timeouts. Node's permission model does not cover
the network, so before the plugin module is imported the bootstrap
replaces every public network entry point — `net` connect/listen (which
`http`, `https`, `fetch` and `WebSocket` go through), `tls`, `http2`,
`dgram`, all `dns` lookups and `inspector` — with functions that throw
`ERR_ACCESS_DENIED`. The originals are not reachable from plugin code:
`process.binding` is denied by the permission model, and there are no
addons, child processes or workers to reach sockets any other way. The
host can opt a plugin back in with `sandbox: { allowNetwork: true }`.
The module's own manifest must match the
installed id/version. It reaches the host only through the capability
bridge, which enforces the plugin's `provide`/`lookup`/`declare` allowlist
(default: what the package declared, shown on the install record; the host
can pass a narrower policy) and only transfers structured-cloneable values.

`DefaultPluginHost.register(plugin)` with an in-process plugin object is
unchanged: that is your own code with full host trust. `IsolatedPluginSandbox`
with the default `worker` transport isolates memory only.

## 8. Workspace trust

A repository can ship files that configure Nexum itself: `.nexum/config.json`
(and legacy `.devagent/config.json`), `.nexum/mcp-trust.json`,
`.nexum/publisher-trust.json`, and the workspace/cwd `.env`, which Nexum
loads into its own process — where `PATH` or `NODE_OPTIONS` would decide
what the next `git`, `gh`, `docker` or Node child actually runs. None of it
applies until you trust that exact content (`src/cli/workspace-trust.ts`):

- **Trust record** lives outside every workspace, in
  `~/.nexum/trusted-workspaces.json` (mode 0600), keyed by the workspace's
  real path and bound to a sha256 over the presence, contents and symlink
  targets of those files. Any change — a `git pull`, a teammate's commit —
  makes the workspace untrusted again (`direnv allow` semantics).
- **Untrusted:** only settings that cannot run code, loosen isolation or
  send the workspace anywhere apply (`model`, `theme`, `quickModel`, tool
  selection, timeouts, `writeScope` — which can only narrow — and the
  model-routing heuristics). Everything else, including unknown future keys,
  is withheld: `sandbox`, `dockerTool`, `dockerEgress`, `autoApprove`,
  `mcpServers`, `host`, `tier`, `apiKey(s)`, `systemPrompt`, `shellImage`.
  Workspace `.env` files are not loaded, and workspace MCP approvals are
  ignored (servers that need approval ask again).
- **Deciding:** the interactive UI asks once, showing what would apply
  (MCP commands in full, `.env` variable names — never values — with
  `PATH`/`NODE_OPTIONS`/`LD_PRELOAD`/`NEXUM_*`-style names flagged). Every
  other entry point (`rpc`, `doctor`, CI, piped input) never prompts: it
  runs without the workspace settings and says so on stderr. `nexum trust`,
  `nexum trust status`, `nexum trust revoke` manage it explicitly.
- **Nexum's own writes** (saving config from the UI, `nexum mcp trust
approve`, `nexum marketplace keys add`, runtime MCP approvals) re-stamp
  trust only if the workspace was trusted, or had none of these files,
  immediately before the write — they never launder somebody else's change.
- The CLI no longer runs `dotenv/config` at startup; env files load through
  the same gate.

## 9. Other surfaces

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

## 10. Policy engine

`RulePolicyEngine` evaluates rules in order and the **first decision
wins**. Denials always run first — deny lists, risk ceilings, execution
profile, `ModeRestrictionRule` (read-only agent modes), `BudgetGuardRule`
— and only then a posture's own rules, so no product "allow" (such as
parity's benign-shell allowance) can pre-empt a denial. The CLI agent uses
the `parity` posture: `DestructiveShellRule`, `GitPublishRule`,
`DeleteFileRule`, then `ConfirmationRule`. Financial side effects always
require confirmation. `standard` and `restricted` postures confirm every
high / medium-risk call. Policy is a UX and intent layer; the isolation in
§2–§8 is what holds when the model is adversarial.

## 11. Verification

```bash
npm test                     # unit + contract suites (Docker not required)
docker build -t nexum-sandbox:latest docker/nexum-sandbox/
npm run test:docker          # real daemon: masking, git/.nexum RO, write scope, no network,
                             # caps/no-new-privs, host uid, docker-tool egress & ownership
```

`test:docker` has passed on Linux (native dockerd, root and non-root). It
has **not** been run on Docker Desktop. Differences that matter there:
Docker Desktop runs containers in a VM and shares host paths through its
file-sharing layer, which maps ownership to the host user (so the uid
assertion is skipped on hosts without POSIX uids); on Windows there is no
host uid, so no `--user` is passed and the container runs as the image's
user (root inside the container, all capabilities dropped,
`no-new-privileges`).

## 12. Known gaps

| Gap                                                                                                                                                                                                                                    | Impact                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Trusting a workspace trusts its settings completely, including its `.env` (`PATH`, `NODE_OPTIONS`) — that is what trust means. `AGENTS.md`/skills in the repo are always read as prompt content (prompt injection, not configuration). | Read the `nexum trust` summary before answering y.                                            |
| Plugin network blocking is enforced inside the plugin's Node process (the permission model has no network switch in Node 22). It relies on the permission model keeping internal bindings out of reach.                                | Only trust publisher keys you have verified; for hostile code use a VM.                       |
| `github` tool can still create/comment on/edit issues and PRs and re-run workflows with your token.                                                                                                                                    | Scope the `gh` token (fine-grained, single repo).                                             |
| Delete/move/mkdir symlink race is narrowed, not closed (Node has no `openat2(RESOLVE_BENEATH)`).                                                                                                                                       | Requires a concurrent writer inside the workspace.                                            |
| Sandbox masks secrets present when the command starts; the webhook replay cache and hardlink inode cache (10 s) are in memory.                                                                                                         | Restart re-opens the webhook window; a secret created mid-command is visible to that command. |
| Browser has host network access.                                                                                                                                                                                                       | Do not browse untrusted sites with sensitive local services reachable.                        |
| `test:docker` not yet run on Docker Desktop (macOS/Windows); see §11.                                                                                                                                                                  | Run it once there before relying on the sandbox on those hosts.                               |
| Not a formal audit; no guarantee against prompt injection or malicious MCP servers/plugins.                                                                                                                                            | Run untrusted workloads on a disposable machine or VM.                                        |

## 13. Reporting security issues

1. **Do not** open a public GitHub issue.
2. Email `shubhamtaywade82@gmail.com` with details and a repro.
3. Expect a response within 72 hours.
4. Do not publish until a fix is released.

See [STABILITY.md](./STABILITY.md) for API stability tiers.

---

**Last updated:** 2026-09-29 · **Nexum version:** 2.0.0-alpha.2 (plus unreleased changes on this branch)
