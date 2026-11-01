# ci-healer (Ruby, reference implementation)

> The primary implementation is now the TypeScript port in
> `src/domains/ci-healer/` (`nexum ci-healer`), with SQLite state. This Ruby tool is
> kept as a reference. Both read the same config keys and enforce the same safety rules.
> See `src/domains/ci-healer/README.md`.

A local poller that heals failing GitHub Actions runs. For each failure it extracts
a log digest, drives `nexum rpc` in an isolated git worktree, **verifies the patch
locally**, and opens a **draft** PR. On its own PRs it iterates in place, within a
fixed attempt budget, until checks are green.

It runs from cron on the machine that already has your `gh` auth, git clones, and
Ollama. Nothing is hosted.

## Design decisions (where this departs from the blueprint, and why)

| Blueprint | Implementation | Reason |
|---|---|---|
| `nexum run --prompt "…"` | `nexum rpc --workspace <dir>`, JSON-RPC `agent.execute` | `nexum run` does not exist. `nexum "<task>"` opens the Ink TUI and always exits 0. `rpc` is the scriptable surface (`src/cli/rpc.ts`). |
| "exit 0 when resolved" | Healer runs `verify_commands` itself before any push | `agent.execute` returns `completed` whenever the agent returns without throwing. That does not mean the failure is fixed. |
| `$BRANCH` read, `$HEAL_BRANCH` written | Ledger keyed by heal branch, plus a per-`base@sha` handled marker | The blueprint's cap was never enforced for default-branch failures, and `git worktree add -b` on an existing branch aborted the script under `set -e`. |
| No lock | `flock` on `state.json.lock`; an overlapping tick exits 0 | Cron ticks overlap when nexum takes minutes. |
| Any `fix/ci-*` branch iterates | Only branches the ledger owns iterate; unknown `fix/ci-*` branches are skipped | A human branch named `fix/ci-*` would otherwise get an uncapped loop. |
| Every failing run | Only runs whose SHA is the current branch head, on the default branch or a branch with an open same-repo non-draft PR | Stale runs and fork PRs would otherwise generate PRs that cannot land. |
| `tail -n 300` of logs | Deterministic digest (error lines + context, capped), then optional Ollama condense | The root cause is often far from the tail. The model should never see install noise. |
| Fresh worktree runs verify | `setup_commands` (e.g. `npm ci`) runs first | A new worktree has no `node_modules` or bundle, so verification would fail for the wrong reason. |
| Corrupt state → start fresh | Corrupt ledger → exit 2, refuse to run | An empty ledger would re-open PRs for failures already handled. |

## Invariants

1. **Nothing is pushed unverified.** `verify_commands` must be non-empty (config
   validation enforces this), and every command must pass in the worktree after the
   agent's edit.
2. **Protected paths are never changed by the agent.** Patches touching
   `forbidden_paths` (CI workflows, `.env`, key material) are dropped. Patches over
   `max_changed_files` are dropped.
3. **Bounded retries.** A lineage gets at most `max_heal_attempts_per_lineage` heal
   attempts in total, counting the initial one (default 3). A head that already had
   an attempt is never retried. Each failing `base@sha` is acted on once.
4. **Bounded PR fan-out.** At most `max_open_prs_per_base` open agent lineages per
   base branch (default 1).
5. **Only current heads are healed.** A run whose `headSha` is not the branch head
   is skipped as stale.
6. **Human-visible and reversible.** PRs are opened as drafts and never merged or
   commented on by the daemon. Pushes are fast-forward only, and in-place pushes
   use `HEAD:refs/heads/<branch>` with no force flag.
7. **Kill switch.** If `kill_switch_file` exists, the tick exits before any work.
8. **Fail closed on state.** Corrupt or unknown-version ledger → exit 2, nothing
   runs.

## Lineage state machine

```
  (new failure, fix pushed + draft PR opened)  ──►  PR_OPEN
  PR_OPEN   ── CI failing on head, attempts left ──► HEALING ──(push or no-patch)──► PR_OPEN
  PR_OPEN   ── CI green on head                  ──► GREEN
  PR_OPEN   ── CI failing, attempts spent        ──► EXHAUSTED
  GREEN     ── CI failing, attempts left         ──► HEALING
  GREEN     ── CI failing, attempts spent        ──► EXHAUSTED
  EXHAUSTED ── CI green on head                  ──► GREEN
  PR_OPEN | GREEN | EXHAUSTED ── PR merged/closed ──► CLOSED   (terminal)
  HEALING is set before the side effect. Crash recovery resumes it as PR_OPEN,
  with the attempt already counted, so no extra attempt is spent.
```

Per-head outcomes in `handled_heads`: `HEALING`, `PR_OPEN`, `NO_PATCH`, `ERRORED`.
`ERRORED` is terminal on purpose. Clear it manually (see Operations).

## Requirements

- Ruby 3.x with RSpec for tests (`gem install rspec`).
- `git`, `gh` (authenticated for the cron user: `gh auth status`).
- nexum built from this repo: `cd /path/to/nexum && npm ci && npm run build`.
  `nexum rpc` runs from `dist/`.
- Optional: Ollama with the condenser model pulled, e.g. `ollama pull qwen2.5-coder:7b`.

## Setup

```bash
mkdir -p ~/.config/ci-healer ~/.local/share/ci-healer
cp config/config.example.json ~/.config/ci-healer/config.json   # edit repo, nexum_command, verify_commands

# 1. Confirm GitHub access as the user cron will run as
gh auth status && gh run list -R owner/your-repo --status failure --limit 3

# 2. Read-only plan: writes nothing, pushes nothing, creates no PRs
ruby bin/ci-healer --config ~/.config/ci-healer/config.json --dry-run

# 3. One real tick, watched
ruby bin/ci-healer --config ~/.config/ci-healer/config.json
```

Cron (`crontab -e`). Use absolute paths, because cron's `PATH` is minimal:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * /usr/bin/env ruby /home/you/src/nexum/tools/ci-healer/bin/ci-healer --config /home/you/.config/ci-healer/config.json >> /home/you/.local/share/ci-healer/healer.log 2>&1
```

Overlapping ticks are already prevented by the ledger lock. Overlap just logs
`skipping tick`.

## Verification

Unit and integration suite (real git against a bare origin; nexum replaced by a
protocol-compatible double; GitHub replaced by an in-memory fake):

```bash
cd tools/ci-healer && rspec
# expected: "... examples, 0 failures"
```

The integration suite proves, by mutation as well as by passing:
- removing the verify gate fails "pushes nothing when the agent changed files but verification still fails";
- removing the attempt cap, the same-head guard, the handled-head dedupe, the forbidden-path gate, the per-base cap, or the stale-SHA guard each fails at least one test.

Expected healthy log lines for one heal:

```
INFO  verify command="npm test" status=0
INFO  opened draft fix PR pr=42 heal_branch="fix/ci-main-111" base="main"
```

Expected lines for the guards:

```
WARN  no patch: verification failed
WARN  no patch: patch touches forbidden paths paths=[".github/workflows/ci.yml"]
INFO  already spent an attempt on this head; waiting for a new commit
WARN  heal attempts exhausted; human review needed heal_branch="fix/ci-main-111" attempts=3
```

## Operations

- **Stop everything:** `touch ~/.local/share/ci-healer/DISABLED` (remove to resume).
- **Inspect:** `jq . ~/.local/share/ci-healer/state.json`.
- **Retry an `ERRORED` head:** delete its key from `handled_heads`. Check first that
  no orphan branch `fix/ci-…` is left on origin from the failed attempt.
- **Exit codes:** 0 = ok, lock held, or kill switch. 1 = tick failed, retry next run.
  2 = configuration or ledger problem, needs an operator.

## Known limits

- **Live GitHub was not exercised in the build environment.** The `gh` token there
  was invalid, so every GitHub call is covered by fakes. Field names were checked
  against `gh <cmd> --help` (gh 2.89). Run `--dry-run` on a real repo before
  enabling cron.
- **Provider routing for free-tier LLM APIs is not in this tool.** The healer
  itself only uses Ollama, and only for log condensation. Provider selection for
  the agent belongs to nexum's model gateway, so configure it in nexum's own
  settings.
- **nexum's rpc mode does not apply repo-level `.nexum/` config** (workspace trust
  applies only to interactive runs). Model and provider config must come from the
  user environment or global config.
- **Approvals default to deny.** With no approval listener, nexum denies destructive
  tool calls. Do not set `NEXUM_AUTO_APPROVE` for this daemon.
- **CI logs are untrusted input.** A branch author controls them and can attempt
  prompt injection. Mitigations: the nonce-delimited data block, the forbidden-path
  gate, the verify gate, and draft-only PRs. Review each draft diff before marking
  it ready.
- **A crash after `git push` but before PR creation** leaves an orphan branch. The
  head is left `HEALING`, which blocks retry. Clean up by hand.
- **Fork PRs and draft PRs are never healed.** This is deliberate: the daemon cannot
  push to forks, and healing a draft would race its author.
- **One repo per config file.** Run one config per repo.
