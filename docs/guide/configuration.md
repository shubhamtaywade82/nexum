# Configuration & Diagnostics

Nexum supports hierarchical configuration through environment variables, workspace `.nexum/config.json`, and global `~/.nexum/config.json`.

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

| Variable                    | Description                                                                                      | Default                  |
| :-------------------------- | :----------------------------------------------------------------------------------------------- | :----------------------- |
| `NEXUM_MODEL`               | Default Ollama model                                                                             | `qwen2.5-coder:14b`      |
| `NEXUM_HOST`                | Ollama host endpoint                                                                             | `http://localhost:11434` |
| `NEXUM_TIER`                | Execution tier (`local` or `cloud`)                                                              | `local`                  |
| `OLLAMA_API_KEY`            | Ollama Cloud API Key                                                                             | `undefined`              |
| `OLLAMA_API_KEYS`           | Comma-separated API Key rotation pool                                                            | `undefined`              |
| `NEXUM_SHELL_IMAGE`         | Sandbox Docker image                                                                             | `nexum-sandbox:latest`   |
| `NEXUM_TIMEOUT_MS`          | LLM turn timeout in milliseconds                                                                 | `120000`                 |
| `NEXUM_TOOL_SELECTION_MODE` | Dynamic tool pruning mode (`heuristic`, `hybrid`, `all`)                                         | `hybrid`                 |
| `NEXUM_AUTO_PLAN`           | Route multi-step requests to the plan orchestrator (`ask`, `always`, `off`)                      | `ask`                    |
| `NEXUM_DECISION`            | Enable the bounded Decision Plane (System One). `true` / `false`. Auto-disabled in a cloud tier. | `false`                  |
| `NEXUM_DECISION_MODEL`      | Dedicated decision model (independent of the primary generation model).                          | `tev1`                   |

---

## Workspace Configuration (`.nexum/config.json`)

Created automatically in your project root via `/init`:

```json
{
  "model": "qwen2.5-coder:32b",
  "tier": "local",
  "host": "http://localhost:11434",
  "skills": ["refactoring", "clean-code"],
  "enableDecision": false,
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

The Decision Plane is **off by default**; setting `enableDecision: true` enables the bounded System One subsystem (local-only — auto-disabled in a cloud tier). The `decisionModel` is independent of the primary generation `model`. See `docs/guide/decision-plane.md` for the full guide.

---

## System Health Diagnostics (`/doctor`)

Run `/doctor` in the TUI or `npm run doctor` from the terminal to verify:

1. Local Ollama host connectivity and installed models.
2. Ollama Cloud API key pool availability.
3. Docker daemon connectivity and sandbox image status.
4. Installed Language Servers for your workspace languages.
5. Workspace root resolution and `.git` boundaries.
