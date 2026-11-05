# Artifacts

Agent outputs — reports, patches, diffs, data, screenshots, logs, benchmark results — become **first-class artifacts** with identity, versioning, and provenance, instead of giant strings passed through messages.

```
ResearchAgent → "findings" (research, v1)
                    ↓ deriveArtifact()
AnalysisAgent → "findings" (analysis, v1)   provenance.sources → [research v1]
                    ↓ deriveArtifact()
WriterAgent   → "findings" (report,  v1)    provenance.sources → [analysis v1]
```

## Stores

| Store | Use |
|---|---|
| `InMemoryArtifactStore` | tests, ephemeral sessions |
| `SqliteArtifactStore` | durable (WAL, `artifacts` table, json_extract filters) |

## API

```ts
import { InMemoryArtifactStore, deriveArtifact } from "@nemesis-oss/nexum";

const store = new InMemoryArtifactStore();

const research = store.save({
  name: "findings",
  kind: "research",            // report | patch | diff | code | data | screenshot | log | benchmark | research | analysis | custom
  content: "The tool gateway validates every call...",
  tags: ["phase-1"],
  provenance: { agentId: "researcher", runId, traceId },
});

store.latest("findings", "research");   // newest version
store.versions("findings", "research"); // full history, oldest first
store.query({ agentId: "researcher", tags: ["phase-1"], since: Date.now() - 86_400_000 });

const analysis = deriveArtifact(store, { artifactId: research.id }, {
  kind: "analysis",
  content: "…",
  provenance: { agentId: "analyst" },
});
// analysis.provenance.sources → [{ artifactId, name }] — the derivation graph is walkable
```

- Every artifact's `contentHash` is a sha256 of its content (content-addressed identity).
- Versions are monotonic **per (name, kind)** — deriving with a new kind starts a new chain while inheriting the chain's name.
- Provenance carries `runId`/`agentId`/`sessionId`/`traceId`, `sources` (parent artifacts), and contributing `toolCalls` — "where did this number come from" is answerable without re-running anything.

## Multi-agent handoff

Agents exchange `ArtifactReference`s (id + version), not payloads — the supervisor pattern (see [Multi-Agent Coordination](./multiagent.md)) uses the store as its shared workspace, and consumers resolve references lazily through whatever store backs the session.
