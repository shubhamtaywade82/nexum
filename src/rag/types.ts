/**
 * RAG core contracts — the retriever abstraction.
 *
 * Nexum has excellent *engineering* retrieval (Rails graph, LSP, docs FTS5,
 * workspace search). Agentic RAG needs those same signals behind ONE
 * generic interface so any retrievable source can be fused, reranked,
 * grounded and cited uniformly:
 *
 *   query → retrieve (many sources) → fuse/rerank → ground → cite → context
 *
 * A Retriever is anything that turns a RetrievalQuery into ranked chunks.
 * The RetrieverRegistry composes them; HybridRetriever fuses them.
 */

export type RetrievalSourceKind = "vector" | "keyword" | "graph" | "metadata" | "custom";

/** Where a chunk came from — the provenance backbone for citations. */
export interface RetrievalSource {
  kind: RetrievalSourceKind;
  /** Human-readable reference (file path, doc slug, node id, url, ...). */
  ref: string;
  retriever?: string;
}

export interface RetrievalQuery {
  text: string;
  /** Desired result count per retriever (default 5). */
  k?: number;
  /** Namespace scoping (collection ids, workspace ids). */
  namespaces?: string[];
  /** Arbitrary source-side filters (kind, tags, path prefix, ...). */
  filter?: Record<string, unknown>;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  source: RetrievalSource;
  /** Retriever-local score (not comparable across retrievers). */
  score: number;
  metadata: Record<string, unknown>;
}

export interface Retriever {
  readonly name: string;
  retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}

/** A retriever that failed — surfaced, never silently swallowed. */
export interface RetrievalFailure {
  retriever: string;
  error: string;
}

export interface RetrievalOutcome {
  chunks: RetrievedChunk[];
  failures: RetrievalFailure[];
}

import { randomUUID } from "node:crypto";

/** Stable chunk id for corpus documents. */
export function newChunkId(): string {
  return `chunk_${randomUUID()}`;
}

/**
 * Typed registry of retrievers (mirrors AgentRegistry / ToolCatalog).
 * retrieveAll runs every registered retriever in parallel and collects
 * per-retriever failures instead of failing the whole query.
 */
export class RetrieverRegistry {
  private readonly retrievers = new Map<string, Retriever>();

  register(retriever: Retriever): this {
    if (this.retrievers.has(retriever.name)) {
      throw new Error(`retriever "${retriever.name}" is already registered`);
    }
    this.retrievers.set(retriever.name, retriever);
    return this;
  }

  unregister(name: string): boolean {
    return this.retrievers.delete(name);
  }

  get(name: string): Retriever | undefined {
    return this.retrievers.get(name);
  }

  require(name: string): Retriever {
    const retriever = this.retrievers.get(name);
    if (!retriever) {
      throw new Error(`unknown retriever "${name}". Registered: ${this.names().join(", ") || "(none)"}`);
    }
    return retriever;
  }

  names(): string[] {
    return [...this.retrievers.keys()];
  }

  /** Retrieve from the named retrievers only. */
  async retrieveFrom(names: string[], query: RetrievalQuery): Promise<RetrievalOutcome> {
    const selected = names.map((n) => this.require(n));
    return runRetrievers(selected, query);
  }

  /** Retrieve from every registered retriever, tolerating individual failures. */
  async retrieveAll(query: RetrievalQuery): Promise<RetrievalOutcome> {
    return runRetrievers([...this.retrievers.values()], query);
  }
}

async function runRetrievers(retrievers: Retriever[], query: RetrievalQuery): Promise<RetrievalOutcome> {
  const settled = await Promise.allSettled(retrievers.map((r) => r.retrieve(query)));
  const chunks: RetrievedChunk[] = [];
  const failures: RetrievalFailure[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      for (const chunk of result.value) chunks.push(chunk);
    } else {
      failures.push({
        retriever: retrievers[i].name,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
  return { chunks, failures };
}
