# Semantic Memory

Nexum's shipped memory was session-scoped (conversation store, episodes, lessons, compaction). **Semantic memory** adds the missing generic layer: an embedding-backed, durable, workspace-scoped long-term memory with ranking and context injection.

```
experience / knowledge
      ↓  remember()
  embedding           HashEmbedder (offline default) · OllamaEmbedder · FallbackEmbedder
      ↓
  vector index        SqliteVectorStore (.nexum/memory.db) · InMemoryVectorStore
      ↓  recall(query)
  semantic retrieval  cosine similarity over the collection
      ↓
  memory ranking      relevance + recency + importance + usage
      ↓  buildContext(query)
  context injection   compact system-prompt fragment
```

## Default-on

Every product agent gets semantic memory automatically: `AgentToolManager.registerBaseTools()` mounts the `memory` tool pack (tools `memory_save` / `memory_recall`) backed by a `SqliteVectorStore` inside `<workspace>/.nexum/memory.db` — the same database file as the conversation memory store.

Opt out per environment:

```bash
NEXUM_SEMANTIC_MEMORY=0   # disables auto-mounting entirely
```

## Embedding providers

| Provider | Use case |
|---|---|
| `HashEmbedder` | Deterministic offline default. Hashed n-grams → 256-dim L2-normalized vectors. No model, no network, identical output in every process. |
| `OllamaEmbedder` | Real embeddings via Ollama `/api/embed` (legacy `/api/embeddings` fallback). |
| `FallbackEmbedder` | Primary with secondary fallback; the secondary's vectors are adapted (padded/truncated) to the primary's dimensionality so a collection keeps one shape. |

> Vectors from different providers/dimensions must never mix in one collection — `FallbackEmbedder` exists precisely to keep one shape during provider outages.

```ts
import { SemanticMemory, HashEmbedder, OllamaEmbedder, FallbackEmbedder } from "@nemisis-oss/nexum";

const embedder = new FallbackEmbedder(
  new OllamaEmbedder({ model: "nomic-embed-text" }),
  new HashEmbedder(),
  { onFallback: (reason) => console.warn(`embedding degraded: ${reason}`) },
);

const memory = new SemanticMemory({ embedder });
```

## API

```ts
await memory.remember({
  text: "The user prefers tabs over spaces",
  kind: "preference",     // fact | lesson | episode | note | preference | skill
  importance: 0.9,        // 0..1, feeds ranking
  tags: ["style"],
});

const hits = await memory.recall("what indentation does the user like?", { k: 5, kinds: ["preference"] });
// hits[0].score = { relevance, recency, importance, usage, final }

const fragment = await memory.buildContext("indentation", { k: 3, maxChars: 2000 });
// → "Relevant memory (from long-term semantic memory):\n- [preference·2026-09-26] ..."
// → undefined when nothing is relevant (never injects an empty block)
```

### Ranking

`MemoryRanker` blends four signals (weights tunable per product):

| Signal | Meaning | Default weight |
|---|---|---|
| relevance | cosine(query, memory) | 0.60 |
| recency | `2^(-age / halfLife)` (default half-life 30d) | 0.15 |
| importance | writer-declared 0..1 | 0.15 |
| usage | saturating use-count boost | 0.10 |

### Learning-subsystem adapters

The existing learning plane feeds straight in:

```ts
await memory.recordLesson({ category, context, lesson });     // lesson-store shape
await memory.recordEpisode({ goal, summary, outcome });       // episode-recorder shape
```

## Storage

`SqliteVectorStore` stores vectors as Float32 BLOBs in a `semantic_vectors` table (WAL journal), pre-filters namespace/kind/time in SQL and cosine-scans in JS. That is the right shape for workspace-scale collections; larger deployments implement the same `VectorStore` interface against an external ANN store (Qdrant/Chroma/pgvector) and swap it in — nothing above the interface changes.

## Agent tools

| Tool | Risk | Description |
|---|---|---|
| `memory_save` | low | Persist a fact/lesson/preference/note for future sessions. |
| `memory_recall` | read | Semantic recall of memories relevant to a query. |
