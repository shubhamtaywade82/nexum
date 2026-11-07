# Configuration & Diagnostics

Nexum supports hierarchical configuration through environment variables, workspace `.nexum/config.json`, and global `~/.nexum/config.json`.

Two annotated templates ship with the repo — copy one and edit:

| File                   | Covers                                                                                                                                            |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.env.example`         | every environment variable, tagged `[required]` / `[optional]` plus its default                                                                   |
| `config.example.jsonc` | every `config.json` key, tagged `[required]` / `[optional]` plus its default, and `[until trust]` when a workspace copy needs `nexum trust` first |

Config files may carry `//` and `/* */` comments (JSONC). A strict `JSON.parse` is tried first, so an ordinary comment-free JSON file behaves exactly as before; any other syntax error skips the file entirely and the built-in defaults apply.

## Workspace trust

A workspace's own `.nexum/config.json`, `.env` files, MCP approvals and publisher keys are repository content — anyone who can commit can write them — so they configure Nexum only after you trust them:

```bash
nexum trust status   # what the workspace ships, and whether it is trusted
nexum trust          # trust the current contents
nexum trust revoke   # forget the decision
```

The interactive UI asks the first time it meets an untrusted workspace; other commands (`rpc`, `doctor`, CI) never prompt and run without those settings. Until trusted, only `model`, `theme`, `quickModel`, tool selection, timeouts, `writeScope` and the model-routing flags apply from the workspace config; `sandbox`, `dockerTool`, `dockerEgress`, `autoApprove`, `mcpServers`, `host`, `tier`, API keys, `systemPrompt` and `shellImage` are ignored, and the workspace `.env` is not loaded. Trust is stored in `~/.nexum/trusted-workspaces.json` and bound to the files' exact contents: any change (for example a `git pull`) asks again. Settings you save through Nexum keep a trusted workspace trusted. Global `~/.nexum/config.json`, `~/.nexum/.env` and your shell environment always apply.

---

## Environment Variables

| Variable                            | Description                                                                                                                | Default                                       |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------- |
| `NEXUM_MODEL`                       | Default Ollama model                                                                                                       | `qwen3.5:4b`                                  |
| `NEXUM_HOST`                        | Ollama host endpoint                                                                                                       | `http://localhost:11434`                      |
| `NEXUM_TIER`                        | Execution tier (`local` or `cloud`)                                                                                        | `local`                                       |
| `OLLAMA_API_KEY`                    | Ollama Cloud API Key                                                                                                       | `undefined`                                   |
| `OLLAMA_API_KEYS`                   | Comma-separated API Key rotation pool                                                                                      | `undefined`                                   |
| `NEXUM_SHELL_IMAGE`                 | Shell sandbox Docker image                                                                                                 | `nexum-sandbox:latest`                        |
| `NEXUM_DOCKER_TOOL`                 | Docker daemon tool (root-equivalent); enabled by default in trusted workspaces                                              | `true` in trusted workspaces                 |
| `NEXUM_DOCKER_EGRESS`               | Docker-tool container bridge egress (loopback publishing only); enabled by default in trusted workspaces                    | `true` in trusted workspaces                 |
| `NEXUM_TIMEOUT_MS`                  | Per-request timeout in milliseconds (cloud tier only — local never times out mid-generation)                               | unset (60s on cloud)                          |
| `NEXUM_TOOL_SELECTION_MODE`         | Dynamic tool pruning mode (`heuristic`, `llm`, `hybrid`)                                                                   | `hybrid`                                      |
| `NEXUM_AUTO_PLAN`                   | Route multi-step requests through the checkpointed plan orchestrator (`ask`, `always`, `off`)                            | `always`                                      |
| `NEXUM_AUTO_APPROVE`                | Approve confirmation-required tool calls without prompting; includes destructive workspace operations                     | `true`                                        |
| `NEXUM_DECISION`                    | Bounded Decision Plane (System One). On by default; `false` disables it. Auto-disabled in a cloud tier.                    | `true`                                        |
| `NEXUM_DECISION_MODEL`              | Dedicated decision model (independent of the primary generation model).                                                    | `tev1`                                        |
| `NEXUM_PROFILE`                     | Plugin/settings profile mounted on the agent host (`nexum-cli`, `nexum-server`, `nexum-crypto-bot`, or a user profile id). | `nexum-cli`                                   |
| `NEXUM_TOKEN_BUDGET`                | Session token budget (prompt + completion). Each run is capped at the remainder; `0` = unlimited.                          | `0`                                           |
| `NEXUM_VERIFIER`                    | Critic pass on final answers; uses `quickModel` when set, otherwise the local primary model.                               | `true`                                        |
| `NEXUM_TELEMETRY_ENABLED`           | Process-wide spans + metrics (`0` disables). The host serves Prometheus text at `GET /metrics`.                            | enabled                                       |
| `NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP traces endpoint for span export.                                                                                 | unset                                         |

---

## Workspace Configuration (`.nexum/config.json`)

Created automatically in your project root via `/init`:

```json
{
  "model": "qwen2.5-coder:32b",
  "tier": "local",
  "host": "http://localhost:11434",
  "enableDecision": true,
  "decisionModel": "tev1",
  "mcpServers": [
    {
      "name": "sqlite",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "app.db"]
    }
  ]
}
```

The annotated template with every key, its default and its trust requirement is `config.example.jsonc` at the repo root.

The Decision Plane, critic pass, self-consistency, local worker, heuristic gate, and availability checks are enabled by default when their required local/cloud resources are available. The Decision Plane remains local-tier only. Multi-step requests use the checkpointed planner automatically. GitHub evolution delivery and runtime activation are also automatic when a GitHub destination is configured; CI, same-head human approval, merge confirmation, and merged-content verification remain mandatory.

**Approval warning:** `autoApprove` defaults to `true` for unattended execution. This bypasses confirmation prompts for confirmation-required tool calls, including destructive workspace operations. Keep the sandbox enabled, use a trusted workspace with a narrow write scope, and set `NEXUM_AUTO_APPROVE=false` when interactive confirmation is required. The sandbox remains independently configurable with `NEXUM_SANDBOX`.

---

## System Health Diagnostics (`/doctor`)

Run `/doctor` in the TUI or `npm run doctor` from the terminal to verify:

1. Local Ollama host connectivity and installed models.
2. Ollama Cloud API key pool availability.
3. Docker daemon connectivity and sandbox image status.
4. Installed Language Servers for your workspace languages.
5. Workspace root resolution and `.git` boundaries.

### MCP server credentials

`mcpServers[].env` passes environment variables to a server process. A value
of the form `credential:NAME` is resolved through the credential service (process
env, then `.nexum/credentials.json` in a **trusted** workspace) at connect time,
so tokens never need to be written into `config.json`:

```json
{
  "mcpServers": [{ "name": "github", "command": "github-mcp", "env": { "GITHUB_TOKEN": "credential:GITHUB_TOKEN" } }]
}
```
