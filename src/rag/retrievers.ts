/**
 * Concrete retrievers: vector, keyword (FTS5), graph, metadata.
 *
 * Each wraps one index technology behind the Retriever interface. Products
 * register the ones they have; HybridRetriever fuses whatever is registered.
 */

import type { EmbeddingProvider } from "../memory/semantic/embedding.js";
import type { VectorStore } from "../memory/semantic/vector-store.js";
import type { Retriever, RetrievalQuery, RetrievalSourceKind, RetrievedChunk } from "./types.js";
import { newChunkId } from "./types.js";
import type Database from "better-sqlite3";

// ── Vector retriever ────────────────────────────────────────────────────────

export interface VectorRetrieverOptions {
  store: VectorStore;
  embedder: EmbeddingProvider;
  /** Namespace this retriever reads (default "knowledge"). */
  namespace?: string;
  /** Source ref reported on chunks (default "vector-store"). */
  sourceRef?: string;
  name?: string;
}

/** Semantic retrieval: embed the query, cosine-scan the vector store. */
export class VectorRetriever implements Retriever {
  readonly name: string;
  private readonly store: VectorStore;
  private readonly embedder: EmbeddingProvider;
  private readonly namespace: string;
  private readonly sourceRef: string;

  constructor(opts: VectorRetrieverOptions) {
    this.name = opts.name ?? "vector";
    this.store = opts.store;
    this.embedder = opts.embedder;
    this.namespace = opts.namespace ?? "knowledge";
    this.sourceRef = opts.sourceRef ?? "vector-store";
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const k = query.k ?? 5;
    const vector = await this.embedder.embed(query.text);
    const namespaces = query.namespaces ?? [this.namespace];
    const hits = namespaces.flatMap((ns) =>
      this.store.query(vector, {
        k,
        filter: { namespace: ns, ...(query.filter?.kinds ? { kinds: [String(query.filter.kinds)] } : {}) },
      }),
    );
    return hits.map((hit) => ({
      id: hit.id,
      content: hit.text,
      source: {
        kind: "vector" as RetrievalSourceKind,
        ref: String(hit.metadata.source ?? this.sourceRef),
        retriever: this.name,
      },
      score: hit.similarity,
      metadata: hit.metadata,
    }));
  }
}

// ── Keyword index (the FTS seam) ────────────────────────────────────────────

export interface CorpusDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

/** A searchable lexical index over corpus documents. */
export interface KeywordIndex {
  upsert(doc: CorpusDoc): void;
  search(text: string, k: number, namespaces?: string[]): CorpusDoc[];
  list(namespaces?: string[]): CorpusDoc[];
  delete(id: string): boolean;
  count(namespaces?: string[]): number;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "to",
  "in",
  "is",
  "are",
  "for",
  "on",
  "with",
  "how",
  "what",
  "does",
]);

/** In-memory lexical index: Jaccard-style token overlap scoring. */
export class InMemoryKeywordIndex implements KeywordIndex {
  private readonly docs = new Map<string, CorpusDoc>();

  upsert(doc: CorpusDoc): void {
    this.docs.set(doc.id, doc);
  }

  search(text: string, k: number, namespaces?: string[]): CorpusDoc[] {
    const queryTokens = tokenize(text);
    if (queryTokens.length === 0) return [];
    const querySet = new Set(queryTokens);
    return this.list(namespaces)
      .map((doc) => {
        const docTokens = new Set(tokenize(doc.content));
        let overlap = 0;
        for (const t of querySet) if (docTokens.has(t)) overlap++;
        return { doc, score: overlap / Math.sqrt(querySet.size * Math.max(1, docTokens.size)) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.doc);
  }

  list(namespaces?: string[]): CorpusDoc[] {
    return [...this.docs.values()].filter(
      (d) => !namespaces || namespaces.includes(String(d.metadata.namespace ?? "default")),
    );
  }

  delete(id: string): boolean {
    return this.docs.delete(id);
  }

  count(namespaces?: string[]): number {
    return this.list(namespaces).length;
  }
}

export interface SqliteKeywordIndexOptions {
  /** Table name for the FTS5 virtual table (default "rag_chunks"). */
  table?: string;
}

/** FTS5-backed keyword index (bm25 ranking), sanitized MATCH queries. */
export class SqliteKeywordIndex implements KeywordIndex {
  private readonly table: string;

  constructor(
    private readonly db: Database.Database,
    opts: SqliteKeywordIndexOptions = {},
  ) {
    this.table = opts.table ?? "rag_chunks";
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING fts5(
        id UNINDEXED,
        namespace UNINDEXED,
        metadata UNINDEXED,
        content
      );
    `);
  }

  upsert(doc: CorpusDoc): void {
    // FTS5 has no upsert; delete-then-insert inside one statement pair.
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(doc.id);
    this.db
      .prepare(`INSERT INTO ${this.table} (id, namespace, metadata, content) VALUES (?, ?, ?, ?)`)
      .run(doc.id, String(doc.metadata.namespace ?? "default"), JSON.stringify(doc.metadata), doc.content);
  }

  search(text: string, k: number, namespaces?: string[]): CorpusDoc[] {
    const match = this.buildMatchQuery(text);
    if (match === '""') return [];
    const rows = this.db
      .prepare(
        `SELECT id, metadata, content FROM ${this.table} WHERE ${this.table} MATCH ? ORDER BY bm25(${this.table}) LIMIT ?`,
      )
      .all(match, k * 4) as Array<{ id: string; metadata: string; content: string }>;
    return rows
      .map((row) => ({
        id: row.id,
        content: row.content,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      }))
      .filter((doc) => !namespaces || namespaces.includes(String(doc.metadata.namespace ?? "default")))
      .slice(0, k);
  }

  list(namespaces?: string[]): CorpusDoc[] {
    const rows = this.db.prepare(`SELECT id, metadata, content FROM ${this.table}`).all() as Array<{
      id: string;
      metadata: string;
      content: string;
    }>;
    return rows
      .map((row) => ({
        id: row.id,
        content: row.content,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      }))
      .filter((doc) => !namespaces || namespaces.includes(String(doc.metadata.namespace ?? "default")));
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }

  count(namespaces?: string[]): number {
    return this.list(namespaces).length;
  }

  /** Wrap tokens in phrases (OR-joined) so user input can never break MATCH. */
  private buildMatchQuery(query: string): string {
    const raw = query.trim().split(/\s+/).filter(Boolean);
    if (raw.length === 0) return '""';
    const content = raw.filter((t) => !STOPWORDS.has(t.toLowerCase()));
    const tokens = content.length > 0 ? content : raw;
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  }
}

/** Lexical retrieval over any KeywordIndex. */
export class KeywordRetriever implements Retriever {
  readonly name: string;
  constructor(
    private readonly index: KeywordIndex,
    name = "keyword",
    private readonly defaultNamespaces: string[] = ["knowledge"],
  ) {
    this.name = name;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const k = query.k ?? 5;
    const namespaces = query.namespaces ?? this.defaultNamespaces;
    const docs = this.index.search(query.text, k, namespaces);
    return docs.map((doc, rank) => ({
      id: doc.id,
      content: doc.content,
      source: {
        kind: "keyword" as RetrievalSourceKind,
        ref: String(doc.metadata.source ?? "keyword-index"),
        retriever: this.name,
      },
      // bm25-adjacent scores are not normalized; rank-based score keeps order
      // without pretending to be a probability.
      score: 1 / (rank + 1),
      metadata: doc.metadata,
    }));
  }
}

// ── Graph retriever ─────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  kind?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
}

/** A graph/adjacency index (the Rails semantic graph is one implementation). */
export interface GraphIndex {
  searchNodes(text: string, k: number): GraphNode[];
  neighbors(nodeId: string, depth?: number): { node: GraphNode; via: GraphEdge }[];
}

/** Trivial in-memory graph index for tests and small corpora. */
export class InMemoryGraphIndex implements GraphIndex {
  constructor(
    private readonly nodes: GraphNode[] = [],
    private readonly edges: GraphEdge[] = [],
  ) {}

  addNode(node: GraphNode): void {
    this.nodes.push(node);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
  }

  searchNodes(text: string, k: number): GraphNode[] {
    const tokens = new Set(tokenize(text));
    if (tokens.size === 0) return [];
    return this.nodes
      .map((node) => {
        const haystack = tokenize(`${node.label} ${node.summary ?? ""} ${node.kind ?? ""}`);
        let overlap = 0;
        for (const t of tokens) if (haystack.includes(t)) overlap++;
        return { node, score: tokens.size > 0 ? overlap / tokens.size : 0 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.node);
  }

  neighbors(nodeId: string, depth = 1): { node: GraphNode; via: GraphEdge }[] {
    const out: { node: GraphNode; via: GraphEdge }[] = [];
    const seen = new Set<string>([nodeId]);
    let frontier = [nodeId];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.edges) {
          const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;
          if (!other || seen.has(other)) continue;
          seen.add(other);
          const node = this.nodes.find((n) => n.id === other);
          if (node) {
            out.push({ node, via: edge });
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return out;
  }
}

/** Neighborhood retrieval: match nodes, expand one hop, emit chunk summaries. */
export class GraphRetriever implements Retriever {
  readonly name: string;
  constructor(
    private readonly index: GraphIndex,
    name = "graph",
    private readonly neighborDepth = 1,
  ) {
    this.name = name;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const k = query.k ?? 5;
    const matched = this.index.searchNodes(query.text, k);
    const chunks: RetrievedChunk[] = [];
    const seen = new Set<string>();
    matched.forEach((node, rank) => {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        chunks.push({
          id: node.id,
          content: this.describe(node),
          source: { kind: "graph", ref: node.id, retriever: this.name },
          score: 1 / (rank + 1),
          metadata: { graphKind: node.kind, ...node.metadata },
        });
      }
      for (const { node: neighbor, via } of this.index.neighbors(node.id, this.neighborDepth)) {
        if (seen.has(neighbor.id)) continue;
        seen.add(neighbor.id);
        chunks.push({
          id: neighbor.id,
          content: `${this.describe(neighbor)} (via ${via.relation} from ${node.label})`,
          source: { kind: "graph", ref: neighbor.id, retriever: this.name },
          score: 1 / (rank + 2),
          metadata: { graphKind: neighbor.kind, via: via.relation, ...neighbor.metadata },
        });
      }
    });
    return chunks.slice(0, k * 2);
  }

  private describe(node: GraphNode): string {
    return node.summary
      ? `${node.label} (${node.kind ?? "node"}): ${node.summary}`
      : `${node.label} (${node.kind ?? "node"})`;
  }
}

// ── Metadata retriever ──────────────────────────────────────────────────────

/**
 * Structured retrieval: no text scoring — filter the corpus by metadata and
 * return most-recent first. Useful for "the last 5 incident reports" style
 * queries and as a recall backstop when lexical/semantic both miss.
 */
export class MetadataRetriever implements Retriever {
  readonly name: string;
  constructor(
    private readonly index: KeywordIndex,
    name = "metadata",
    private readonly defaultNamespaces: string[] = ["knowledge"],
  ) {
    this.name = name;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const k = query.k ?? 5;
    const namespaces = query.namespaces ?? this.defaultNamespaces;
    const filter = query.filter ?? {};
    const docs = this.index
      .list(namespaces)
      .filter((doc) => Object.entries(filter).every(([key, value]) => doc.metadata[key] === value))
      .sort((a, b) => Number(b.metadata.createdAt ?? 0) - Number(a.metadata.createdAt ?? 0))
      .slice(0, k);
    return docs.map((doc) => ({
      id: doc.id,
      content: doc.content,
      source: {
        kind: "metadata" as RetrievalSourceKind,
        ref: String(doc.metadata.source ?? "corpus"),
        retriever: this.name,
      },
      score: 1,
      metadata: doc.metadata,
    }));
  }
}

/** Shared tokenizer (lowercase alphanumerics, stopwords kept — scoring only). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\-.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

export { newChunkId };
