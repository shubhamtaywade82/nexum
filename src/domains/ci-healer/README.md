# CI Healer (`nexum ci-healer`)

A local daemon that heals failing GitHub Actions runs. For each failure it builds a
log digest, runs the nexum agent in an isolated git worktree, **verifies the patch
locally**, and opens a **draft** PR. On its own PRs it iterates in place, within a
fixed attempt budget, until checks are green.

This is the TypeScript implementation. `tools/ci-healer/` holds the earlier Ruby
implementation as a reference. Both read the same config keys and enforce the same
safety rules. Do not run both against one repository: they keep separate state.

## Usage

```bash
nexum ci-healer plan   --config ~/.config/ci-healer/config.json   # read-only: what would happen
nexum ci-healer tick   --config ~/.config/ci-healer/config.json   # one healing pass
nexum ci-healer status --config ~/.config/ci-healer/config.json   # lineages and recent events
```

Exit codes: `0` ok (including kill switch and lease contention), `1` tick failed
(retry on the next run), `2` configuration or ledger problem (operator action needed).

Cron, with absolute paths because cron's `PATH` is minimal:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * /usr/local/bin/node /home/you/src/nexum/bin/cli.js ci-healer tick --config /home/you/.config/ci-healer/config.json >> /home/you/.local/share/ci-healer/healer.log 2>&1
```

Set `CI_HEALER_LOG_LEVEL=debug` for skip reasons and agent stderr.

## Configuration

`config/config.example.json` in `tools/ci-healer/` is valid for both implementations.
Unknown or invalid values fail at startup. Required: `repo.slug`, `repo.dir` (must be a git
checkout), and a non-empty `verify_commands`. Without verify commands the daemon refuses to
start, because it must never push an unverified patch.

## Architecture

```
domain/       pure rules: lineage state machine, branch policy, check verdicts,
              log digester, prompt builder
application/  Healer (orchestration) and LogSource; depends only on ports
ports.ts      CommandPort, GitHubPort, GitPort, AgentPort, LogPort, Logger
adapters/     gh and git CLIs, nexum rpc client, Ollama condenser, process runner,
              environment policy
persistence/  LedgerStore: SQLite (better-sqlite3), the single source of truth
```

### Ledger (SQLite)

`state_file` (default `~/.local/share/ci-healer/ci-healer.db`) holds:

| Table | Purpose |
|---|---|
| `lineages` | One row per heal branch: state, attempts, PR number, last attempted and pushed SHAs |
| `head_outcomes` | Per `repository, base, sha`: the failing commit was acted on. Prevents retries of the same commit |
| `events` | Append-only audit log. Every state change is written in the same transaction |
| `worker_leases` | Per-repository lease, so overlapping ticks never run in parallel |

Schema version is `PRAGMA user_version`. A database from a newer build is refused.
A file that is not SQLite is refused. Neither is silently replaced.

### Lineage state machine

```
PR_OPEN ──► HEALING ──► PR_OPEN          (in-place attempt, pushed or not)
PR_OPEN ──► GREEN                        (checks passed on the current head)
PR_OPEN ──► EXHAUSTED                    (attempts spent, still failing)
GREEN | EXHAUSTED ──► CLOSED             (PR merged or closed; terminal)
```

Illegal transitions throw `IllegalTransitionError`, and the ledger never applies them.

## Safety rules

1. **Nothing is pushed without passing `verify_commands`** in the worktree.
2. **The agent never gets GitHub or SSH credentials.** The daemon keeps them for its own
   `gh` and `git` calls. Child processes get an allowlisted environment (`adapters/agent-env.ts`):
   the agent gets model configuration (`NEXUM_*`, `OLLAMA_*`), and repo-controlled
   commands get no model configuration. GitHub and SSH variables are always denied, even if
   `agent_env_allow` names them. Limit: file-based credentials under `HOME` (for example
   `~/.config/gh`) are not covered by this policy.
3. **Protected paths are refused:** `.github/workflows/**`, `.env*`, `*.pem`, `*.key` by
   default, and any patch over `max_changed_files`.
4. **Bounded retries.** A lineage gets `max_heal_attempts_per_lineage` attempts in total,
   including the initial one. A head that already had an attempt is never retried.
5. **Bounded fan-out.** At most `max_open_prs_per_base` open agent lineages per base branch.
6. **Only current heads are healed.** A run whose SHA is no longer the branch head is stale.
   Fork PRs and draft PRs are skipped. `fix/ci-*` branches are owned by the ledger and are
   never healed as ordinary branches.
7. **Human-visible and reversible.** PRs are drafts. Pushes are fast-forward only, and the
   daemon never merges, approves, or comments.
8. **Fail closed.** A corrupt or newer database exits 2 and does nothing else.

## Not implemented (see the PR for the decisions)

- Docker `--network=none` sandbox for verify and setup commands. They run on the host, with the restricted environment above.
- Run discovery pagination. It reads at most `run_scan_limit` failed runs.
- OpenCode and Antigravity runtimes, and a free-tier provider router. The only runtime is `nexum rpc`.
- Stale-run detection for `pull_request` runs is not verified against the live GitHub API.

## Tests

```bash
npx jest tests/domains/ci-healer     # with NEXUM_TEST_NO_GLOBAL=true and --experimental-vm-modules
```

The integration suite uses real git against a bare origin, the real `NexumRpcAgent`
client against a protocol-compatible fixture, and an in-memory GitHub. Mutation checks
confirmed that removing the verify gate, the attempt cap, the stale-SHA guard, or the
GitHub-credential deny rule each fails at least one test.
