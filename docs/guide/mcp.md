# Model Context Protocol (MCP)

Nexum supports connecting to external MCP servers to extend its capabilities.

---

## Configuration

Add MCP servers to `.nexum/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "sqlite",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "database.sqlite"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  ]
}
```

---

## Tool Dynamic Registration

All MCP tools are dynamically converted to native JSON schemas and registered with the agent's tool registry.

---

## Trust policy

Security metadata (risk, side effects, confirmation) classifies each discovered tool — the **trust policy** decides whether a server may connect at all and which of its tools may register. It is the gate in front of registration, and it composes with the ToolGateway's per-call enforcement rather than replacing it.

Listing a server in your own `config.json` is consent to connect it — plain entries keep the connect-freely behavior. Add the optional trust fields to tighten a specific server:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "trust": "ask",
      "tools": { "deny": ["delete_*"] },
      "maxRisk": "medium"
    }
  ]
}
```

| Field     | Values                                              | Meaning                                                                                                |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `trust`   | `trusted` \| `ask` \| `untrusted`                   | Server-level gate. `ask` = connect only with a recorded approval; `untrusted` = never connect          |
| `tools`   | `{ "allow": [...], "deny": [...] }`                 | Tool-name patterns (`*` and `?`). Deny always wins; an allow list alone acts as a whitelist            |
| `maxRisk` | `read` \| `low` \| `medium` \| `high` \| `critical` | Tools whose effective risk (inferred from MCP annotations + overrides) is above the ceiling are denied |

**`ask` and trust-on-first-use.** An `ask` server connects only after an approval. Approvals live in `.nexum/mcp-trust.json` and are **pinned to the server's fingerprint** (hash of its command+args or URL) — if the server binary or URL changes, the old approval no longer applies and the server asks again. Programmatically, an `approver` callback can resolve the prompt interactively; without an approver or recorded approval, an `ask` server is denied — it never silently connects.

Everything is also available as a library (`src/mcp/trust.ts`):

```ts
import { McpTrustPolicy, McpApprovalStore } from "@nemesis-oss/nexum";

const policy = new McpTrustPolicy({
  rules: [
    { match: "marketplace-*", trust: "untrusted" },
    { match: "github", trust: "ask", tools: { deny: ["delete_*"] }, maxRisk: "medium" },
  ],
  approvals: new McpApprovalStore(".nexum/mcp-trust.json"),
  defaultTrust: "trusted", // servers no rule matches (default; tighten explicitly)
});
// await policy.decideServer("github", fingerprint) → { allowed, reason, ... }
// policy.decideTool("github", "create_issue", "medium") → { allowed, ... }
```

`AgentToolManager.registerMcpServer(command, args, { serverName, trust, security })` applies the policy end-to-end: denied servers throw with the reason, denied tools are filtered before registration, and rule security overrides merge into each registered tool. The behavior is pinned by `tests/mcp/trust.test.ts` and `tests/cli/agent-tools-mcp-trust.test.ts`.
