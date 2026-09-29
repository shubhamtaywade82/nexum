/**
 * Workspace composition for the RAG plane.
 *
 * Builds the default RagService over the workspace's `.nexum/memory.db`
 * (the same file as semantic memory — one WAL database, several tables):
 *
 *   semantic_vectors   vector store (shared with SemanticMemory)
 *   rag_chunks         FTS5 keyword index
 *
 * Default retrievers: vector (namespace "knowledge") + keyword, fused with
 * RRF and reranked heuristically. Products with more sources (Rails graph,
 * docs FTS) register additional retrievers onto the same registry.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultEmbedder } from "../memory/semantic/semantic-memory.js";
import { SqliteVectorStore } from "../memory/semantic/vector-store.js";
import { RetrieverRegistry } from "./types.js";
import { KeywordRetriever, SqliteKeywordIndex, VectorRetriever } from "./retrievers.js";
import { HeuristicReranker } from "./reranker.js";
import { RagService } from "./rag-service.js";

export interface WorkspaceRagOptions {
  /** SQLite file path (default `<workspaceRoot>/.nexum/memory.db`). */
  dbPath?: string;
  /** Knowledge namespace (default "knowledge"). */
  namespace?: string;
}

/** Open (or create) the workspace-scoped RagService. */
export function createWorkspaceRagService(opts: WorkspaceRagOptions = {}): RagService {
  const namespace = opts.namespace ?? "knowledge";
  let dbPath = opts.dbPath;
  if (dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath ?? ":memory:");
  db.pragma("journal_mode = WAL");

  const store = new SqliteVectorStore(db);
  const index = new SqliteKeywordIndex(db);
  const embedder = defaultEmbedder();

  const registry = new RetrieverRegistry()
    .register(new VectorRetriever({ store, embedder, namespace, sourceRef: "knowledge-corpus" }))
    .register(new KeywordRetriever(index, "keyword", [namespace]));

  return new RagService({
    registry,
    reranker: new HeuristicReranker(),
    ingest: { store, embedder, index },
  });
}
