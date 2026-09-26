/**
 * Semantic memory plane — embedding-backed long-term memory.
 *
 *   EmbeddingProvider    HashEmbedder (offline default) · OllamaEmbedder · FallbackEmbedder
 *   VectorStore          InMemoryVectorStore · SqliteVectorStore (Float32 BLOBs)
 *   SemanticMemory       remember → recall → rank → buildContext
 *   MemoryRanker         relevance/recency/importance/usage blending
 *
 * See docs/guide/semantic-memory.md for the product-facing guide.
 */

export type {
  EmbeddingProvider,
  HashEmbedderOptions,
  OllamaEmbedderOptions,
  FallbackEmbedderOptions,
} from "./embedding.js";
export { HashEmbedder, OllamaEmbedder, FallbackEmbedder, l2Normalize, cosineSimilarity } from "./embedding.js";

export type { VectorRecord, VectorHit, VectorFilter, VectorQueryOptions, VectorStore } from "./vector-store.js";
export { InMemoryVectorStore, SqliteVectorStore, matchesFilter, newMemoryId } from "./vector-store.js";

export type {
  MemoryKind,
  MemoryEntryInput,
  MemoryHit,
  MemoryScore,
  MemoryRecallOptions,
  RankerWeights,
  SemanticMemoryOptions,
  CreateSemanticMemoryOptions,
} from "./semantic-memory.js";
export {
  SemanticMemory,
  MemoryRanker,
  DEFAULT_RANKER_WEIGHTS,
  createSemanticMemory,
  defaultEmbedder,
} from "./semantic-memory.js";
