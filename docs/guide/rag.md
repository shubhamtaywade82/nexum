# Agentic RAG (Hybrid Retrieval)

Nexum's retrieval was engineering-specific: the Rails semantic graph, LSP, DevDocs FTS5, and workspace search each had their own interfaces. **Agentic RAG** puts every retrievable source behind one generic pipeline:

```
query
  ↓ retrieve        RetrieverRegistry — vector · keyword · graph · metadata (parallel, failure-tolerant)
  ↓ fuse            reciprocal-rank fusion (RRF)
  ↓ rerank          heuristic (no model) or LLM-scored
  ↓ ground          claims → evidence → citations → verdicts
  ↓ cite            numbered sources block for prompt injection
```

## Default-on

`AgentToolManager.registerBaseTools()` auto-mounts the `rag` tool pack (`rag_search`) over the workspace's `.nexum/memory.db` (vector table + FTS5 table, namespace `knowledge`), alongside the memory pack. `NEXUM_SEMANTIC_MEMORY=0` disables both.

## Retrievers

| Retriever | Signal | Index |
|---|---|---|
| `VectorRetriever` | semantic | any `VectorStore` (shared with semantic memory) |
| `KeywordRetriever` | lexical | `KeywordIndex` — `SqliteKeywordIndex` (FTS5, bm25, sanitized MATCH) or `InMemoryKeywordIndex` |
| `GraphRetriever` | structural | any `GraphIndex` (node match → 1-hop neighborhood expansion) |
| `MetadataRetriever` | structured | metadata filters, recency-ordered |
| `HybridRetriever` | fused | RRF over any set of the above |

`RetrieverRegistry` runs every registered retriever in parallel and collects per-retriever failures — one broken source degrades the search, never kills it.

## Fusion + reranking

Retriever scores are not comparable across sources, so fusion uses **reciprocal rank fusion**: `score(d) = Σ 1/(60 + rank)`. Chunks found by both semantic and lexical search outrank anything a single source found.

Second-stage rerankers sharpen the top candidates: `HeuristicReranker` (query-coverage + phrase features, deterministic) or `LlmReranker` (model scores each passage 0..1 as JSON; **falls back to stage-1 order on any failure** — reranking never breaks retrieval).

## Grounding (hallucination prevention)

`GroundingService` grounds generated answers against retrieved evidence:

- `extractClaims` splits the answer into assertive sentences (questions/directives skipped)
- each claim's token support is measured against the best evidence chunk
- verdicts: `supported` (≥0.5), `partial` (≥0.25), `unsupported` (<0.25)
- `confidence` = (supported + ½·partial) / claims — strategies can gate on it
- `renderWithSources` appends a numbered `Sources:` block

```ts
const result = await rag.search("which git operations are denied?", {
  k: 3,
  answer: "The policy engine denies force push.",   // optional: ground a generated answer
});
result.grounding?.claims;      // per-claim verdicts + citations
result.context;                // "Sources (cite as [n]): [1] ... (source: docs/policy.md)"
```

## RagService

```ts
const rag = new RagService({
  registry,                       // RetrieverRegistry with your retrievers
  reranker: new HeuristicReranker(),
  ingest: { store, embedder, index },   // write path (optional)
});

await rag.ingest({ text: chunkText, source: "docs/policy.md", metadata: { kind: "doc" } });
const answer = await rag.search("policy for destructive git ops", { k: 5 });
```

`createWorkspaceRagService({ dbPath })` builds the default stack (vector + keyword over one SQLite file, heuristic reranker, ingest wired).

## Agent tool

| Tool | Risk | Description |
|---|---|---|
| `rag_search` | read | Hybrid search returning passages with numbered citations. |

## Extending

Register more sources onto the same registry — e.g. the Rails semantic graph behind `GraphRetriever`, DevDocs behind another `KeywordRetriever`, or an HTTP corpus behind a custom `Retriever`. Everything above (fusion, rerank, grounding, citations, tools) applies automatically.
