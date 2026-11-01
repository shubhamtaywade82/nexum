# CI Healer: technical design

Status: implemented in `src/domains/ci-healer/` (TypeScript, primary) and
`tools/ci-healer/` (Ruby, reference only). Items that could not be verified in the
build environment are marked **unverified** and listed in `BACKLOG.md`.

## 1. Goal and scope

Heal failing GitHub Actions runs on a repository the operator controls, from a local
machine that holds the operator's `gh` auth, git clones, and local models.

In scope: detect failing runs on the default branch and on open same-repo PR branches;
repair in an isolated worktree; verify; open a draft PR; iterate in place on the
healer's own PRs within a fixed attempt budget.

Out of scope: auto-merge, commenting on PRs, changes to protected branches, fork PRs,
and triage of non-code failures (runner outages, missing secrets). Failure
classification is a future item (BACKLOG O-1).

## 2. Architecture

```
cli.ts  ──wires──►  Healer (application)          depends on ports only
                      │
        ┌─────────────┼──────────────────┬──────────────────┐
   GitHubPort     GitPort           AgentPort          RepoCommandPort
   (gh CLI)       (git CLI)         (AgentRouter)      (Docker | host)
                                       │
                    ┌──────────────────┼──────────────────┐
                 nexum rpc        opencode run       agy -p
                                                              
   LedgerStore (SQLite): lineages · head_outcomes · events · worker_leases ·
                         runtime_health · scan_cursors
   domain/ (pure): lineage state machine · branch policy · checks · digest · prompt
```

Rules: `domain/` performs no I/O. `application/` imports only ports and domain. Adapters
implement ports. The Ruby tool shares no code with the TypeScript one.

## 3. Lineage state machine (contract)

Keyed by heal branch (`fix/ci-<base>-<run>`). Transitions are validated by
`domain/lineage.ts` and enforced by `LedgerStore.transition`, which throws on an illegal
move.

```
PR_OPEN ──► HEALING ──► PR_OPEN                 in-place attempt (pushed or not)
PR_OPEN ──► GREEN                               checks passed on the current head
PR_OPEN ──► EXHAUSTED                           attempt budget spent, still failing
GREEN | EXHAUSTED ──► CLOSED                    PR merged or closed (terminal)
HEALING ──► PR_OPEN                             crash recovery (attempt already counted)
```

Head outcomes (`head_outcomes`, keyed `repository, base, sha`): `HEALING`, `PR_OPEN`,
`NO_PATCH`, `ERRORED`. A head with any outcome is never acted on again. `ERRORED` needs a
human reset.

## 4. Discovery (contract)

Discovery scans **branch heads**, not a run list.

1. Targets: the default branch, plus each open same-repo, non-draft PR head. `fix/ci-*`
   branches are excluded (the ledger owns them).
2. Window: the default branch is always scanned. The other branches rotate through a
   persisted cursor (`scan_cursors`), bounded by `max_branches_per_tick`.
3. For each target: fetch recent runs for that branch (`gh run list --branch`, limit
   `run_scan_limit`), keep runs whose `headSha` equals the remote branch head, and treat
   a completed run with conclusion `failure` or `timed_out` as a failure on the head.
4. Skips: head not failing; head already handled; base already has an open lineage.

Why a head scan and not a run window: a run window with a cutoff can miss a current
failure that sits behind newer runs. Starting from the head means only the current
commit is considered, at any age, with a cost proportional to the number of PRs.

Open question (**unverified**): whether GitHub reports the PR head SHA or a merge SHA in
`headSha` for `pull_request` runs. If it reports a merge SHA, no run matches the head and
nothing heals. That is the safe failure. The tick logs `no runs report the branch head`
with the SHAs it did see, and `plan` shows the same.

## 5. Attempt pipeline

Per candidate, in order. Nothing is pushed before step 6.

1. Digest the failed job logs (deterministic pass; optional local condenser). The log
   fetch happens before any state change, so a transient failure retries next tick.
2. Mark the head `HEALING`. Create the worktree (new branch from `origin/<base>`, or a
   detached checkout for in-place).
3. Run setup commands in the sandbox (`setup` phase).
4. Run the runtime chain (section 6) with a goal that wraps the log in a nonce-delimited
   block and marks it as data.
5. Verify: each `verify_commands` entry must exit 0 in the sandbox (`verify` phase, no
   network). A runtime's own exit status is not sufficient.
6. Stage and list changes. Reject: no changes, more than `max_changed_files`, or any path
   matching `forbidden_paths`. Commit with the configured author.
7. Push: fast-forward only, no force. Open a draft PR (new heal) or push the new commit
   to the same branch (in-place). Record the lineage and the outcome.
8. Cleanup: remove the worktree and the local branch in every case.

Errors: recoverable errors (command, timeout, protocol) end the attempt; a new heal marks
the head `ERRORED`, and an in-place attempt returns the lineage to `PR_OPEN` with the
attempt consumed. Anything else is a bug and propagates.

## 6. Runtime chain and circuit breakers

`agent_chain` is an ordered list of candidates: `nexum`, `opencode` (with a `model` of the
form `provider/model`), or `agy`. The router tries them in order.

- A candidate in cooldown is skipped.
- Success returns that candidate's outcome, labelled with `runtime`, and clears its
  failure count.
- Failure: if the error text matches a rate-limit pattern (`429`, `rate limit`, `quota`,
  `too many requests`), the candidate's cooldown is `runtime_rate_limit_cooldown_sec`.
  Otherwise its consecutive-failure count grows, and at `runtime_breaker_threshold` the
  cooldown is `runtime_breaker_cooldown_sec`.
- Between candidates the worktree is reset (`git reset --hard` and `git clean -fd`, which
  keeps ignored dependency installs).

Free-tier routing is configuration, not code: put a free hosted model first and a local
Ollama model after it (`opencode` with `ollama/<model>`). A rate limit on the first
moves the chain to the second for the cooldown window.

A CLI runtime's exit status 0 means `completed`. Its JSON output is not parsed, because
the schemas are not stable contracts. Verification decides.

## 7. Persistence (SQLite)

Single file, WAL mode, `busy_timeout` 5 s. Schema version in `PRAGMA user_version`.
Migrations run in order, each in its own transaction.

| Version | Tables added |
|---|---|
| 1 | `lineages`, `head_outcomes`, `events`, `worker_leases` |
| 2 | `runtime_health`, `scan_cursors` |

Policy: a database from a newer build is refused. A file that is not SQLite is refused.
Neither is replaced. Every state change writes an `events` row in the same transaction.

Leases: one row per repository in `worker_leases`, acquired with an IMMEDIATE
transaction. A tick that finds a live lease exits 0 without work. The lease TTL
(`lease_ttl_sec`, default 7200) must exceed the longest tick.

## 8. GitHub behaviour (what the code relies on)

| Operation | Command | Notes |
|---|---|---|
| Default branch | `gh repo view --json defaultBranchRef` | |
| Runs on a branch | `gh run list -R <slug> --branch <b> --limit N --json …` | Fields checked against `gh run list --help` (gh 2.89) |
| Open PRs | `gh pr list --state open --json …` | Includes `isCrossRepository`, `isDraft` |
| PR state | `gh pr view <n> --json number,state,headRefOid` | |
| Failed logs | `gh run view <id> --log-failed` | |
| Draft PR | `gh pr create --draft --base … --head … --body-file -` | Body on stdin |

Every response is validated against a zod schema. A changed shape fails as a
`ProtocolError`, not a guess.

**Unverified:** all live calls. The build environment's `gh` token was invalid, so every
GitHub interaction is covered by fakes and by field names checked against `--help`.

## 9. Security boundaries

| Component | GitHub / SSH credentials | Model credentials | Network | Filesystem |
|---|---|---|---|---|
| Daemon (gh, git, ledger) | Yes (its own) | No | Yes | Repo clone, state dir |
| Repair runtime (nexum, opencode, agy) | **No** (allowlist + hard deny) | Yes (`NEXUM_*`, `OLLAMA_*`, names in `agent_env_allow`) | Runtime's own | Worktree; host HOME is reachable for `agy` only |
| Setup commands (sandbox) | No | No | Bridge (dependency install) | Worktree only (bind mount) |
| Verify commands (sandbox) | No | No | **None** | Worktree only (bind mount) |

Environment policy: `adapters/agent-env.ts`. Hard deny applies last and covers `GH_`,
`GITHUB_`, `GITLAB_`, `SSH_`, `GPG_`, `GIT_ASKPASS` and similar, `*_AUTH_SOCK`, and any
name containing `GITHUB`. No allowlist entry can re-admit those.

Residual exposure, stated plainly:
- `agy` reads cached sign-in from HOME by design. It is opt-in for that reason.
- The nexum agent runs on the host. Its file tools are confined to the worktree
  (`WorkspaceGuard`), and its own shell runs in nexum's Docker sandbox when
  `NEXUM_SANDBOX` is true, which the healer forces to match `sandbox.mode`.
- Repo commands in host mode can read HOME. That is why host mode requires
  `acknowledge_host_execution`.

## 10. Sandbox for repo commands

`sandbox.mode` defaults to `docker`. The `docker run` argument vector
(`buildDockerRunArgs`) matches nexum's `ShellTool` hardening:

- `--network=none` for verify; `setup_network` (default `bridge`) for setup, because
  dependency installation needs the network. This is a real trade-off: setup code can
  reach the network. Set `setup_network` to `none` if your dependencies are vendored.
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, writable tmpfs
  `/tmp` with `nosuid`.
- `--user <host uid>:<host gid>`, never root.
- `--memory`, `--cpus`, `--pids-limit`, and an in-container `timeout`.
- One bind mount: the worktree. No host home, no SSH, no gh config.
- Environment: `-e` only for `LANG`, `LC_*`, `TZ`, `TERM`, plus `HOME=/tmp`.

Preflight (`preflightSandbox`) runs before every tick. Docker mode with no reachable
daemon, or with a missing image, exits 2. It never falls back to the host.

Limit: the worktree's `.git` file points at the host repository, so `git` inside the
container cannot resolve it. Verify commands that need git history will fail. Most test
commands do not need it (BACKLOG L-1).

## 11. Acceptance criteria (TDD)

Each criterion has a test. Mutation checks were run on the gates marked (M).

| Area | Criterion | Test |
|---|---|---|
| State | Illegal transitions throw and change nothing | ledger-store |
| State | A crash mid-heal does not grant a second attempt on the same head | healer (M) |
| State | Attempts never exceed `max_heal_attempts_per_lineage` | healer (M) |
| Gates | Nothing is pushed unless verify passes | healer (M) |
| Gates | Protected paths and oversized patches are rejected | healer (M) |
| Gates | At most one open lineage per base | healer |
| Discovery | A run not on the current head is ignored | healer (M) |
| Discovery | Rotation reaches every PR across ticks | selectScanWindow, cursor |
| Sandbox | Verify has no network; only the worktree is mounted; no credentials | sandbox-runtimes (M) |
| Sandbox | Docker mode without a daemon or image is a configuration error | preflight |
| Sandbox | Host mode requires the acknowledgement | config (M) |
| Credentials | The agent never receives `GH_TOKEN`, even when allowed | agent-env, healer |
| Runtimes | A rate-limited runtime is skipped during its cooldown | router (M) |
| Runtimes | The breaker opens at the threshold and closes after the cooldown | router |
| Runtimes | A runtime's failure never publishes unverified changes | healer |
| Persistence | Version 1 ledgers upgrade in place | migration test |
| Concurrency | A second tick while a lease is held does nothing | ledger-store, healer |

## 12. Verification status

- Unit and integration: 93 TypeScript tests (Jest, nexum's ESM mode), 85 Ruby RSpec
  examples. Real git against a bare origin in the integration tests.
- Live, checked here: the TypeScript RPC client against the built `bin/cli.js`; the
  `status` command against a version 1 ledger (upgrade path); preflight refusal.
- Not checked here: live GitHub (token invalid), a Docker daemon, the `opencode` and
  `agy` binaries (not installed). The Docker path is covered by argument-level tests,
  plus a real-daemon test gated on `CI_HEALER_DOCKER_TESTS=1`.
