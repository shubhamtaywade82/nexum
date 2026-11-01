# CI Healer: implementation backlog

Status key: **Done** (implemented and tested here), **Done, unverified live** (implemented
and tested with fakes; a live check is still needed), **Blocked** (needs something this
environment lacks), **Open** (not started).

## Gaps from the original review

| ID  | Gap                                                | Status                                         | What was done                                                                                                                                                                                                                                                                     | Remaining                                                                                                                                                        |
| --- | -------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1 | State was a JSON file                              | **Done**                                       | SQLite ledger (`persistence/ledger-store.ts`), schema v1 and v2, WAL, transactions                                                                                                                                                                                                | The Ruby reference still uses JSON, by design                                                                                                                    |
| G-2 | Standalone Ruby tool, not in `src/domains/`        | **Done**                                       | TypeScript port in `src/domains/ci-healer/`, command `nexum ci-healer`                                                                                                                                                                                                            | Ruby kept as reference                                                                                                                                           |
| G-3 | Setup and verify commands ran on the host          | **Done, unverified live**                      | Docker sandbox with the same hardening as nexum's `ShellTool`; verify has no network; preflight fails closed; host mode needs an explicit acknowledgement                                                                                                                         | Real-daemon test is gated (`CI_HEALER_DOCKER_TESTS=1`) and was not run here: no Docker daemon. Image: the default `nexum-sandbox:latest` is Node-only (see B-05) |
| G-4 | Agent inherited `GH_TOKEN` and other credentials   | **Done**                                       | Allowlisted environment for the agent and repo commands; GitHub, SSH, and GPG names are always denied                                                                                                                                                                             | File-based credentials under HOME are not covered (see B-06)                                                                                                     |
| G-5 | Run discovery was not paginated and kept no cursor | **Done, unverified live**, **replaced design** | Discovery scans branch heads instead of a run window, so no cutoff can hide a current failure. A persisted cursor rotates through branches beyond `max_branches_per_tick`. The REST runs endpoint, filtered by `branch`, returns runs for one branch. `per_page` bounds each page | This replaces the proposal's "pagination plus run cursor". The change is a judgement call: review it before merging                                              |
| G-6 | Only `nexum rpc` was wired                         | **Done, unverified live**                      | Ordered runtime chain (`nexum`, `opencode`, `agy`) with circuit breakers and rate-limit cooldowns, stored in SQLite. Free-tier routing is ordered `(runtime, model)` entries                                                                                                      | `opencode` and `agy` are not installed here. Their argument vectors come from the documentation (see B-03 and B-04)                                              |
| G-7 | Stale-run check on `pull_request` runs unverified  | **Done, verified against the real repo**       | Discovery compares run SHAs to the branch head. A mismatch logs the reported SHAs, and `plan` shows the result                                                                                                                                                                    | Resolved by B-01: GitHub reports the PR head SHA                                                                                                                 |

## Items from the proposal's "not included" list

| ID  | Item                      | Status                    | Notes                                     |
| --- | ------------------------- | ------------------------- | ----------------------------------------- |
| N-1 | CI Healer design document | **Done**                  | `docs/ci-healer/DESIGN.md`                |
| N-2 | Implementation backlog    | **Done**                  | This file                                 |
| N-3 | Docker sandboxing         | **Done, unverified live** | See G-3                                   |
| N-4 | SQLite migration          | **Done**                  | Versioned migrations; upgrade path tested |
| N-5 | Credential scrubbing      | **Done**                  | See G-4                                   |

## Live verification (remaining)

| ID   | Check                                       | Blocker                        | Procedure                                                                                                                                                                                                  |
| ---- | ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-01 | `headSha` semantics for `pull_request` runs | **Resolved**                   | `plan` against shubhamtaywade82/nexum (REST API) found the PR head SHA reported for pull_request runs, and no mismatch was logged. The `no runs report the branch head` log would mean GitHub changed this |
| B-02 | Real-daemon sandbox behaviour               | No Docker daemon               | `docker build -t nexum-sandbox:latest docker/nexum-sandbox/`, then `CI_HEALER_DOCKER_TESTS=1 npx jest tests/domains/ci-healer/docker-sandbox.gated.test.ts`                                                |
| B-03 | `opencode` headless flags                   | Binary not installed           | Run `opencode run --help` on the installed version. Compare with `openCodeAgent` in `adapters/cli-agents.ts`. Check whether `--format json` and `--model provider/model` still match                       |
| B-04 | `agy` headless flags and auth               | Binary not installed           | Run `agy --help`. The documented print mode is `agy -p <prompt> --output-format json`. Sign in once interactively first; a headless run without cached credentials fails                                   |
| B-05 | Language toolchains in the sandbox image    | Image is Node-only             | Add toolchains to `docker/nexum-sandbox/Dockerfile` only when a target repo needs them, or set `sandbox.image` to a repo-specific image                                                                    |
| B-06 | File-based credentials under HOME           | Not in scope of the env policy | For Docker mode, verify commands see no host HOME, so this is covered. For host mode, it is not covered and needs the acknowledgement. For `agy`, the cached sign-in is reachable by design                |
| B-07 | Ollama condenser                            | No Ollama reachable            | Run with `condenser.type = ollama` against a running Ollama; confirm the fallback when it is stopped                                                                                                       |
| B-08 | Merge-SHA mapping                           | Not needed                     | B-01 found that GitHub reports the PR head SHA, so no mapping is required. Reopen only if GitHub starts reporting merge SHAs                                                                               |

## Known limitations (accepted, documented)

| ID  | Limitation                                                                                                | Why accepted                                                        | Mitigation                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| L-1 | The worktree's `.git` file points at the host repository, so `git` inside the container cannot resolve it | Mounting the host `.git` would expose hooks and config to repo code | Verify commands that need git history must run in host mode; most test commands do not need it |
| L-2 | Setup has network access in Docker mode                                                                   | Dependency installation needs it                                    | Set `setup_network` to `none` for vendored dependencies                                        |
| L-3 | Runtime CLIs' JSON output is not parsed                                                                   | Their schemas are not stable contracts                              | Exit status plus the verify gate decide                                                        |
| L-4 | One failing run per head is digested                                                                      | One lineage per head keeps attempts bounded                         | The digest is the newest failing run; other failing workflows are not merged into it           |
| L-5 | Windows and macOS paths are untested                                                                      | The build environment is Linux                                      | Docker bind mounts with commas are rejected explicitly                                         |

## Open items

| ID  | Item                                                                           | Phase |
| --- | ------------------------------------------------------------------------------ | ----- |
| O-1 | Failure classification (flaky, infrastructure, dependency, code) before repair | 2     |
| O-2 | Webhook-triggered ticks in place of polling                                    | 4     |
| O-3 | Multi-repository config and per-repository execution policy                    | 5     |
| O-4 | Repair history and runtime metrics (latency, tokens, cost)                     | 5     |
| O-5 | Notifications and human-approval controls                                      | 5     |
| O-6 | Interactive dashboard                                                          | 5     |

## Acceptance criteria

The criteria are in `DESIGN.md` section 11. Each gate that protects a push is covered
by a test that fails when the gate is removed.
