/**
 * RagService — the agentic-RAG facade.
 *
 * One call runs the whole pipeline:
 *
 *   query → retrieve (registry / hybrid) → fuse (RRF) → rerank
 *         → ground (claims → evidence → citations) → context
 *
 * and `ingest` is the write path: chunk → embed → vector store + keyword
 * index, so a product's knowledge corpus stays searchable by every signal.
 */

import type { EmbeddingProvider } from "../memory/semantic/embedding.js";
import type { VectorStore } from "../memory/semantic/vector-store.js";
import { RetrieverRegistry, type RetrievalQuery, type RetrievedChunk, type RetrievalFailure } from "./types.js";
import { fuseByRrf } from "./hybrid-retriever.js";
import type { Reranker } from "./reranker.js";
import { GroundingReport, GroundingService } from "./grounding.js";
import type { KeywordIndex } from "./retrievers.js";
import { newChunkId } from "./types.js";

export interface RagSearchOptions extends Omit<RetrievalQuery, "text"> {
  /** Second-stage reranking (service-level reranker by default). */
  rerank?: boolean;
  /** Ground this generated answer against the retrieved evidence. */
  answer?: string;
  /** How many fused chunks to keep as evidence (default 5). */
  evidenceCount?: number;
}

export interface RagAnswer {
  query: string;
  chunks: RetrievedChunk[];
  failures: RetrievalFailure[];
  grounding?: GroundingReport;
  /** Prompt-ready context block with numbered citations (undefined when empty). */
  context: string | undefined;
}

export interface RagIngestInput {
  text: string;
  /** Where this knowledge came from (file, url, doc slug...). */
  source: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
  /** Stable id (defaults to a fresh chunk id). */
  id?: string;
}

export interface RagServiceOptions {
  registry: RetrieverRegistry;
  reranker?: Reranker;
  grounding?: GroundingService;
  /** Write path: required for ingest(). */
  ingest?: { store: VectorStore; embedder: EmbeddingProvider; index?: KeywordIndex };
  /** RRF fusion constant (default 60). */
  rrfK?: number;
}

export class RagService {
  readonly registry: RetrieverRegistry;
  private readonly reranker?: Reranker;
  private readonly grounding: GroundingService;
  private readonly ingestTarget?: { store: VectorStore; embedder: EmbeddingProvider; index?: KeywordIndex };
  private readonly rrfK: number;

  constructor(opts: RagServiceOptions) {
    this.registry = opts.registry;
    this.reranker = opts.reranker;
    this.grounding = opts.grounding ?? new GroundingService();
    this.ingestTarget = opts.ingest;
    this.rrfK = opts.rrfK ?? 60;
  }

  /** Full pipeline: retrieve → fuse → rerank → ground → context. */
  async search(query: string, opts: RagSearchOptions = {}): Promise<RagAnswer> {
    const retrievalQuery: RetrievalQuery = {
      text: query,
      k: opts.k ?? 5,
      ...(opts.namespaces ? { namespaces: opts.namespaces } : {}),
      ...(opts.filter ? { filter: opts.filter } : {}),
    };

    const retrieverNames = this.registry.names();
    if (retrieverNames.length === 0) {
      return { query, chunks: [], failures: [], context: undefined };
    }

    const { chunks, failures } = await this.registry.retrieveAll(retrievalQuery);
    let fused = fuseByRrf({ chunks, failures }, { rrfK: this.rrfK, k: (opts.k ?? 5) * 3 });

    if (opts.rerank !== false && this.reranker) {
      fused = await this.reranker.rerank(query, fused, (opts.k ?? 5) * 2);
    }

    const evidenceCount = opts.evidenceCount ?? 5;
    const top = fused.slice(0, opts.k ?? 5);
    const evidence = fused.slice(0, evidenceCount);

    let grounding: GroundingReport | undefined;
    if (opts.answer !== undefined && evidence.length > 0) {
      grounding = this.grounding.ground(opts.answer, evidence);
    }

    return {
      query,
      chunks: top,
      failures,
      ...(grounding ? { grounding } : {}),
      context: buildContextBlock(top),
    };
  }

  /** Ground a generated answer against evidence chunks (product seam). */
  groundAnswer(answer: string, chunks: RetrievedChunk[]): GroundingReport {
    return this.grounding.ground(answer, chunks);
  }

  /** Write path: chunk → embed → vector store (+ keyword index). */
  async ingest(input: RagIngestInput): Promise<string> {
    if (!this.ingestTarget) throw new Error("RagService has no ingest target (pass opts.ingest)");
    const text = input.text.trim();
    if (!text) throw new Error("ingest text must be non-empty");
    const id = input.id ?? newChunkId();
    const namespace = input.namespace ?? "knowledge";
    const now = Date.now();
    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      id,
      namespace,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    const vector = await this.ingestTarget.embedder.embed(text);
    this.ingestTarget.store.upsert({ id, vector, text, metadata });
    this.ingestTarget.index?.upsert({ id, content: text, metadata });
    return id;
  }
}

/** Numbered, citation-ready context block for prompt injection. */
export function buildContextBlock(chunks: RetrievedChunk[], maxChars = 6000): string | undefined {
  if (chunks.length === 0) return undefined;
  const lines: string[] = ["Sources (cite as [n]):"];
  for (const chunk of chunks) {
    const line = `[${lines.length}] ${chunk.content} (source: ${chunk.source.ref})`;
    lines.push(line.length > 500 ? `${line.slice(0, 497)}...` : line);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 3)}...`;
  return text;
}
