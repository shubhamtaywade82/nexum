# Nexum Quickstart

> **Status:** Developer Preview. This guide covers the **stable** path
> (using Nexum as a CLI coding agent). For the experimental SDK / runtime
> embedding path, see [STABILITY.md](./STABILITY.md).

This guide covers the four ways to use Nexum, in order of maturity:

| Path | What you want | Stability |
| ---- | -------------- | --------- |
| **A. CLI coding agent** | "Just give me a local coding agent" | Stable |
| **B. Local-first LLM playground** | "I want to use local Ollama models" | Stable |
| **C. SDK embedding** | "I want to build my own agent product on Nexum" | Experimental |
| **D. Plugin authoring** | "I want to extend Nexum with tools/skills/plugins" | Experimental |

## Path A: CLI Coding Agent (Stable)

### Prerequisites

- Node.js >= 22
- Docker (recommended for sandboxed shell execution)
- Ollama (for local-first model routing) OR a cloud provider API key

### Install

```bash
npm install -g @nemesis-oss/nexum@2.0.0-alpha.1
```

Verify the install:

```bash
nexum --version
nexum doctor
```

`nexum doctor` checks Node version, Docker availability, Ollama connectivity,
and workspace state.

### Configure

Nexum reads config from `<workspace>/.nexum/config.json` and environment
variables (prefix `NEXUM_`).

Minimum config for a local-only setup:

```json
{
  "workspaceRoot": "/path/to/my/project",
  "sandbox": true,
  "shellImage": "nexum-sandbox:latest",
  "primaryModel": "qwen2.5-coder:7b",
  "quickModel": "minicpm5-1b",
  "provider": "ollama"
}
```

For cloud models, set `NEXUM_OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`) and switch `provider` to `"openai"` (or `"anthropic"`,
`"gemini"`).

### Run

```bash
cd my-project
nexum                              # interactive TUI
nexum "Fix the failing auth tests" # one-shot mission
nexum fix "auth token refresh"     # investigate→plan→implement→verify
nexum issue 42                     # resolve a GitHub issue end-to-end
```

That's it. The CLI mounts the standard plugin profile on startup, wires
all P0-P2 services, and exposes them via the TUI.

### What works today

- ReAct / Plan-Execute / Graph execution strategies
- Filesystem, git, GitHub, shell (Docker-sandboxed), LSP (14 languages),
  browser, MCP, docs search, trading (paper)
- Local-first model routing with self-escalation
- Checkpoint/resume across process restarts
- Concurrency gating, budget limits, loop detection
- Approval gates for destructive actions

### What's experimental

- Plugin host / profiles / marketplace (architecture in place; trust
  model incomplete — see [SECURITY.md](./SECURITY.md))
- Subagent service (in-process works; process/ACP/SDK/external providers
  have simulated execution)
- Compaction, session query, context providers, workflows, webhooks,
  web service, RPC server (functional but contracts may change)

## Path B: Local-First LLM Playground (Stable)

If you just want to chat with local Ollama models in a TUI:

```bash
# Pull the default models
ollama pull qwen2.5-coder:7b
ollama pull minicpm5-1b

# Start Nexum in any directory
nexum
```

The TUI lets you switch models, inspect tool calls, view execution DAGs,
and resume previous sessions.

## Path C: SDK Embedding (Experimental)

> **Warning:** The SDK API is **experimental**. Expect breaking changes
> between minor versions until 2.0.0 stable. Pin the exact version.

```typescript
import { Agent } from "@nemesis-oss/nexum";

const agent = new Agent({ config: { workspaceRoot: "/path/to/project" } });
await agent.startHost(); // mount plugin profile + start services

const reply = await agent.runUserMessage("Add a null check to the parser");
console.log(reply);

await agent.stopHost(); // drain services on shutdown
```

For the JSON-RPC server (drive Nexum from another process):

```bash
nexum rpc                              # stdio JSON-RPC server
nexum rpc --workspace /path/to/repo    # explicit workspace
```

Methods: `agent.execute`, `agent.list`, `plugins.list`, `jobs.*`,
`subagents.*`, `workflows.*`, `webhooks.*`, `control.*`. See
[src/rpc/index.ts](./src/rpc/index.ts) for the full list.

## Path D: Plugin Authoring (Experimental)

> **Warning:** The plugin API is **experimental**. The trust model
> (capability enforcement, sandboxing, signatures) is incomplete — see
> [SECURITY.md](./SECURITY.md#plugin-runtime--incomplete).

```typescript
import { definePlugin, DefaultPluginHost } from "@nemesis-oss/nexum";

const myPlugin = definePlugin({
  manifest: {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    provides: ["my-capability"],
  },
  setup(ctx) {
    ctx.provide("my-service", { hello: () => "world" });
    ctx.declareCapability("my-capability");
  },
});

const host = new DefaultPluginHost();
host.register(myPlugin);
await host.start();
// Other plugins can now lookup("my-service") and use it.
await host.stop();
```

For skill authoring (prompt-injected expertise, not code):

```markdown
---
name: my-skill
description: Use when the user mentions my-domain
tags: [my-domain, examples]
version: 1.0.0
---

# My Skill

Detailed expertise the model can apply...
```

Place in `.nexum/skills/my-skill/SKILL.md`. The SkillSystem discovers it
automatically and injects it when relevant.

## Troubleshooting

| Problem | Fix |
| ------- | --- |
| `nexum doctor` says Docker unavailable | Install Docker, or set `sandbox: false` (less safe) |
| `nexum doctor` says Ollama unreachable | `ollama serve` in another terminal |
| Model not found | `ollama pull <model-name>` |
| Slow first response | Local model cold-start; subsequent turns are fast |
| `nexum rpc` child exits immediately | Ensure the workspace is valid + `nexum doctor` passes |
| Approval dialog blocks everything | Set `autoApprove: true` in config (less safe) |

## Next Steps

- [Architecture guide](./docs/guide/architecture.md)
- [Configuration reference](./docs/guide/configuration.md)
- [Tool gateway + policy](./docs/guide/tools.md)
- [Capability routing](./docs/guide/capability-routing.md)
- [Sandboxing](./docs/guide/sandboxing.md)
- [STABILITY.md](./STABILITY.md) — public API stability tiers
- [SECURITY.md](./SECURITY.md) — trust model + threat matrix
