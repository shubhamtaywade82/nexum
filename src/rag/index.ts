/**
 * Agentic RAG plane — generic retrieval behind one interface.
 *
 *   RetrieverRegistry     typed registry; runs all retrievers, tolerates failures
 *   VectorRetriever       semantic (embedding + vector store)
 *   KeywordRetriever      lexical (FTS5 / in-memory token overlap)
 *   GraphRetriever        neighborhood expansion over a graph index
 *   MetadataRetriever     structured filters, recency-ordered
 *   HybridRetriever       reciprocal-rank fusion
 *   Rerankers             heuristic (no model) · LLM (model-scored)
 *   GroundingService      claims → evidence → citations → verdicts
 *   RagService            retrieve → fuse → rerank → ground → context + ingest
 *
 * See docs/guide/rag.md for the product-facing guide.
 */

export type {
  RetrievalSourceKind,
  RetrievalSource,
  RetrievalQuery,
  RetrievedChunk,
  Retriever,
  RetrievalFailure,
  RetrievalOutcome,
} from "./types.js";
export { RetrieverRegistry, newChunkId } from "./types.js";

export type {
  VectorRetrieverOptions,
  CorpusDoc,
  KeywordIndex,
  GraphNode,
  GraphEdge,
  GraphIndex,
  SqliteKeywordIndexOptions,
} from "./retrievers.js";
export {
  VectorRetriever,
  InMemoryKeywordIndex,
  SqliteKeywordIndex,
  KeywordRetriever,
  GraphRetriever,
  InMemoryGraphIndex,
  MetadataRetriever,
  tokenize,
} from "./retrievers.js";

export { HybridRetriever, fuseByRrf, DEFAULT_RRF_K } from "./hybrid-retriever.js";

export type { Reranker, HeuristicRerankerOptions, LlmRerankerOptions } from "./reranker.js";
export { HeuristicReranker, LlmReranker, extractJson } from "./reranker.js";

export type { ClaimVerdict, Evidence, GroundedClaim, GroundingReport, GroundingOptions } from "./grounding.js";
export { GroundingService, extractClaims } from "./grounding.js";

export type { RagSearchOptions, RagAnswer, RagIngestInput, RagServiceOptions } from "./rag-service.js";
export { RagService, buildContextBlock } from "./rag-service.js";
export { createWorkspaceRagService, type WorkspaceRagOptions } from "./workspace.js";
