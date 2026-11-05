# CI Healer

`nexum ci-healer` heals failing GitHub Actions runs on a repository you control. For each
failing branch head it runs a repair agent in an isolated git worktree, verifies the change in
a sandbox, and opens a **draft** PR. On its own PRs it iterates in place, within a fixed
attempt budget, until checks are green.

It runs locally, from cron, with your own `gh` login and git clones. Nothing is hosted.

For the full design, see [Technical design](/ci-healer/DESIGN). For what is still unverified or
not built, see the [backlog](/ci-healer/BACKLOG).

## Commands

```bash
nexum ci-healer plan   --config ~/.config/ci-healer/config.json   # read-only: what would happen
nexum ci-healer tick   --config ~/.config/ci-healer/config.json   # one healing pass
nexum ci-healer status --config ~/.config/ci-healer/config.json   # lineages, cursor, events
```

Start with `plan`. It reads GitHub, writes nothing, and shows which failing heads a `tick`
would act on. Exit codes: `0` ok (including the kill switch and lease contention), `1` the tick
failed and should be retried, `2` a configuration, sandbox, or ledger problem that needs an
operator.

## Configuration

Create `~/.config/ci-healer/config.json`. The repository's example file is
`tools/ci-healer/config/config.example.json`. Required keys:

| Key                     | Meaning                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `repo.slug`, `repo.dir` | The repository (`owner/name`) and its local git checkout.                  |
| `verify_commands`       | Commands that must pass before anything is pushed. Required and non-empty. |

Keys with defaults:

| Key                                                         | Default                 | Meaning                                                                                                   |
| ----------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `sandbox.mode`                                              | `docker`                | Where setup and verify run. `host` also needs `sandbox.acknowledge_host_execution: true`.                 |
| `sandbox.image`                                             | `nexum-sandbox:latest`  | Image for setup and verify. Build it from `docker/nexum-sandbox/`.                                        |
| `sandbox.setup_network`                                     | `bridge`                | Network for dependency install. Verify always has no network.                                             |
| `agent_chain`                                               | `[{"runtime":"nexum"}]` | Ordered repair runtimes: `nexum`, `{"runtime":"opencode","model":"provider/model"}`, `{"runtime":"agy"}`. |
| `max_heal_attempts_per_lineage`                             | `3`                     | Total heal attempts per lineage, counting the first.                                                      |
| `max_heals_per_tick`                                        | `1`                     | New heals started per tick.                                                                               |
| `max_open_prs_per_base`                                     | `1`                     | Open agent PRs allowed per base branch.                                                                   |
| `max_branches_per_tick`                                     | `20`                    | Branch heads scanned per tick. The rest rotate through a persisted cursor.                                |
| `run_scan_limit`                                            | `30`                    | Recent runs fetched per branch head.                                                                      |
| `runtime_rate_limit_cooldown_sec`                           | `1800`                  | Cooldown for a runtime after a rate-limit error.                                                          |
| `runtime_breaker_threshold`, `runtime_breaker_cooldown_sec` | `3`, `900`              | Consecutive failures that open a runtime's breaker, and for how long.                                     |
| `agent_env_allow`                                           | `[]`                    | Extra environment variable names passed to the agent, such as provider API keys.                          |

## How a heal works

1. **Scan.** Discovery starts from each branch head: the default branch, plus every open PR
   from this repository that is not a draft. A run counts only when its SHA equals the current
   head, so a failure on an old commit cannot trigger a heal.
2. **Digest.** The failed job logs are reduced to error lines and their context, then passed to
   the agent as data inside a random delimiter.
3. **Repair.** The runtime chain runs in a worktree. A runtime that fails or is rate-limited is
   skipped, and the next one runs after the worktree is reset.
4. **Verify.** Every `verify_commands` entry must exit 0 in the sandbox, with no network for
   verify. The runtime's own exit status is not enough.
5. **Policy.** The change is rejected if it touches `.github/workflows/**`, `.env*`, or key
   files, or if it touches too many files.
6. **Publish.** The change is pushed fast-forward, and a draft PR is opened. The daemon never
   merges and never comments.

## Safety

- The repair runtime never receives GitHub or SSH credentials. Child processes get an
  allowlist of environment variables.
- Repository code runs in a container with no host home, no credentials, a read-only root, and
  one bind mount, the worktree.
- A failing head is acted on once. An attempt budget bounds each PR.
- A kill-switch file stops all activity. Create the file named by `kill_switch_file` to stop.
- A corrupt ledger, a newer ledger schema, or a missing sandbox exits 2 and does nothing else.

## Limits

- The sandbox image is Node-only. Other languages need their own image through `sandbox.image`.
- Setup has network access in Docker mode, because dependency install needs it.
- Inside the container, `git` cannot resolve the worktree's `.git`, so verify commands that need
  git history must run in host mode.
- Only the `nexum` runtime has been run end to end. `opencode` and `agy` are wired but have not
  been run against installed binaries.

The [backlog](/ci-healer/BACKLOG) lists each limit, its status, and how to verify it.
