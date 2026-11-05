# CLI Reference

Every `nexum` subcommand, with a pointer to the page that covers it in depth. The
authoritative list is `nexum --help`.

## Interactive and missions

| Command                | What it does                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `nexum`                | Launch the interactive terminal workspace. See [Terminal UI](/guide/tui). |
| `nexum "<task>"`       | Start a mission for the task.                                             |
| `nexum fix "<issue>"`  | Investigate, plan, implement, and verify a fix.                           |
| `nexum issue <number>` | Resolve a GitHub issue end to end and prepare a PR.                       |
| `nexum --yolo …`       | Auto-approve confirmation prompts. Policy denial rules still apply.       |

## Servers and clients

| Command                              | What it does                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `nexum rpc [--workspace <dir>]`      | JSON-RPC 2.0 agent server over stdio. Used by the CI healer and other hosts.  |
| `nexum serve`                        | Local HTTP and SSE host. See [Server](/guide/server).                         |
| `nexum session <list\|show\|attach>` | Client commands against a running `nexum serve`. See [Server](/guide/server). |

## CI healer

| Command                                  | What it does                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `nexum ci-healer plan --config <path>`   | Read-only. Shows which branch heads would be healed. Writes nothing.                 |
| `nexum ci-healer tick --config <path>`   | One healing pass. Repairs in a worktree, verifies in a sandbox, and opens draft PRs. |
| `nexum ci-healer status --config <path>` | Shows lineages, the scan cursor, and recent events from the ledger.                  |

See [CI Healer guide](/guide/ci-healer), [design](/ci-healer/DESIGN), and [backlog](/ci-healer/BACKLOG).

## Configuration and diagnostics

| Command                        | What it does                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `nexum doctor`                 | System, workspace, and model diagnostics. See [Configuration](/guide/configuration).                    |
| `nexum migrate`                | Migrate legacy `.devagent` state to `.nexum`.                                                           |
| `nexum trust [status\|revoke]` | Review and trust this workspace's settings and `.env`. See [Trust & Security CLI](/guide/security-cli). |
| `nexum asl [validate\|graph]`  | Architecture definition commands. `validate` checks the definition. `graph` renders it.                 |

## Evaluation and self-development

| Command                     | What it does                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `nexum eval <dataset.json>` | Score real agent runs against an evaluation dataset. See [Evaluation](/guide/evaluation).           |
| `nexum evolve [options]`    | Harness evolution and self-development commands. See `docs/HARNESS_EVOLUTION.md` in the repository. |

## Plugins, marketplace, MCP, credentials, capabilities

| Command                        | What it does                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `nexum plugins sandbox <file>` | Trial-run a plugin in the worker sandbox. See [Plugin Sandbox](/guide/plugin-sandbox).          |
| `nexum plugins verify [id…]`   | Re-verify installed marketplace plugins. See [Marketplace](/guide/marketplace).                 |
| `nexum marketplace keys …`     | Publisher trust store management. See [Marketplace](/guide/marketplace).                        |
| `nexum mcp trust …`            | MCP server trust approvals and policy preview. See [MCP](/guide/mcp).                           |
| `nexum credentials …`          | Credential resolution preview, redacted. See [Credentials](/guide/credentials).                 |
| `nexum capabilities …`         | Capability attestation authority and ledger. See [Capability Attestation](/guide/attestations). |

## Global options

| Option            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `-h`, `--help`    | Show the help message.                                    |
| `-v`, `--version` | Show the version.                                         |
| `--yolo`          | Auto-approve confirmation prompts (`NEXUM_AUTO_APPROVE`). |
