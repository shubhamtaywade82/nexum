# CI Healer (`nexum ci-healer`)

A local daemon that heals failing GitHub Actions runs. For each failing branch head it
builds a log digest, runs a repair runtime in an isolated git worktree, **verifies the
change in a sandbox**, and opens a **draft** PR. On its own PRs it iterates in place,
within a fixed attempt budget, until checks are green.

This is the TypeScript implementation. `tools/ci-healer/` is the earlier Ruby version,
kept as a reference only: it has JSON state, host-only execution, and run-window
discovery, and it is not maintained. Design and backlog: `docs/ci-healer/`.

## Usage

```bash
nexum ci-healer plan   --config ~/.config/ci-healer/config.json   # read-only: what would happen
nexum ci-healer tick   --config ~/.config/ci-healer/config.json   # one healing pass
nexum ci-healer status --config ~/.config/ci-healer/config.json   # lineages, scan cursor, events
```

Exit codes: `0` ok (including the kill switch and lease contention), `1` tick failed
(retry on the next run), `2` configuration, sandbox, or ledger problem (operator action
needed).

`tick` runs a sandbox preflight first. In Docker mode it refuses to run without a
reachable daemon and the sandbox image, and it never falls back to the host.

Cron, with absolute paths because cron's `PATH` is minimal:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * /usr/local/bin/node /home/you/src/nexum/bin/cli.js ci-healer tick --config /home/you/.config/ci-healer/config.json >> /home/you/.local/share/ci-healer/healer.log 2>&1
```

Set `CI_HEALER_LOG_LEVEL=debug` for skip reasons and runtime stderr.

## Configuration

`tools/ci-healer/config/config.example.json` is valid for both implementations. The
TypeScript-specific keys are optional and have defaults:

| Key                                           | Default                 | Meaning                                                                                                     |
| --------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `sandbox.mode`                                | `docker`                | `docker` or `host`. `host` must set `sandbox.acknowledge_host_execution: true`                              |
| `sandbox.image`                               | `nexum-sandbox:latest`  | Image for setup and verify. Build from `docker/nexum-sandbox/`                                              |
| `sandbox.setup_network`                       | `bridge`                | Network for setup (dependency install). Verify always has none                                              |
| `agent_chain`                                 | `[{"runtime":"nexum"}]` | Ordered runtimes: `nexum`, `{"runtime":"opencode","model":"provider/model"}`, `{"runtime":"agy"}`           |
| `max_branches_per_tick`                       | `20`                    | Branch heads scanned per tick; the rest rotate through a persisted cursor                                   |
| `runtime_rate_limit_cooldown_sec`             | `1800`                  | Cooldown for a runtime after a rate-limit error                                                             |
| `runtime_breaker_threshold` / `_cooldown_sec` | `3` / `900`             | Consecutive failures that open a runtime's breaker, and for how long                                        |
| `agent_env_allow`                             | `[]`                    | Extra variable names passed to the agent, for example provider keys. GitHub and SSH names are always denied |

Required: `repo.slug`, `repo.dir` (a git checkout), and a non-empty `verify_commands`.
Without verify commands the daemon refuses to start, because it must never push an
unverified change.

## Architecture

```
domain/       pure rules: lineage state machine, branch policy, checks, digest, prompt
application/  Healer (orchestration) and LogSource; depends on ports only
adapters/     gh and git CLIs; nexum rpc client; opencode and agy CLIs; AgentRouter;
              Docker and host command runners; environment policy; Ollama condenser
persistence/  LedgerStore: SQLite, versioned migrations, leases, events
```

### Ledger (SQLite)

`state_file` (default `~/.local/share/ci-healer/ci-healer.db`).

| Table            | Purpose                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `lineages`       | One row per heal branch: state, attempts, PR number, last attempted and pushed SHAs     |
| `head_outcomes`  | Per `repository, base, sha`: the head was acted on. Prevents retries of the same commit |
| `events`         | Append-only audit log, written in the same transaction as each change                   |
| `worker_leases`  | Per-repository lease, so overlapping ticks never run in parallel                        |
| `runtime_health` | Per-runtime failure count and cooldown (circuit breaker)                                |
| `scan_cursors`   | Branch where the last tick's rotation stopped                                           |

Schema version is `PRAGMA user_version` (currently 2). A database from a newer build is
refused. A file that is not SQLite is refused. Neither is replaced.

## Safety rules

1. **Nothing is pushed without passing `verify_commands`**, run in the sandbox with no
   network.
2. **Repair runtimes never receive GitHub or SSH credentials.** Child processes get an
   allowlist. Repo commands get no model keys. Limit: `agy` reads its cached sign-in from
   HOME by design, so it is opt-in.
3. **Repo code runs in a container** (Docker mode, the default). The container gets one
   bind mount (the worktree), no host home, no credentials, a read-only root filesystem,
   no capabilities, a non-root user, and resource limits. Host mode is an explicit opt-in.
4. **Protected paths are refused:** `.github/workflows/**`, `.env*`, `*.pem`, `*.key` by
   default, and any patch over `max_changed_files`.
5. **Bounded retries.** A lineage gets `max_heal_attempts_per_lineage` attempts in total,
   counting the initial one. A head with an attempt is never retried.
6. **Only current heads are healed.** Discovery starts from each branch head, so a
   failure on an old commit cannot trigger a heal. Fork PRs and draft PRs are skipped.
7. **Human-visible and reversible.** PRs are drafts. Pushes are fast-forward only. The
   daemon never merges, approves, or comments.
8. **Fail closed.** A corrupt or newer database, or a missing sandbox, exits 2 and does
   nothing else.

## Still open

Live GitHub, a Docker daemon, and the `opencode` and `agy` binaries were not available
when this was built, so those paths are tested with fakes. The unverified items and how
to check them are in `docs/ci-healer/BACKLOG.md` (B-01 to B-08). The most important one is
whether GitHub reports the PR head SHA for `pull_request` runs. The tick logs it when runs
do not match the head.

## Tests

```bash
NEXUM_TEST_NO_GLOBAL=true node --experimental-vm-modules node_modules/jest/bin/jest.js tests/domains/ci-healer
# Real Docker daemon (needs nexum-sandbox:latest):
CI_HEALER_DOCKER_TESTS=1 node --experimental-vm-modules node_modules/jest/bin/jest.js tests/domains/ci-healer/docker-sandbox.gated.test.ts
```

The integration suite uses real git against a bare origin, the real `NexumRpcAgent` client
against a protocol-compatible fixture, and an in-memory GitHub. Mutation checks confirmed
that removing the verify gate, the attempt cap, the head filter, the credential deny rule,
the host-execution acknowledgement, the sandbox's network isolation, or the runtime cooldown
each fails at least one test.
