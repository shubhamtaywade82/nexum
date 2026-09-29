/**
 * HybridRetriever — reciprocal-rank fusion over any set of retrievers.
 *
 * Retriever-local scores are NOT comparable (cosine ≠ bm25 ≠ rank heuristics),
 * so fusion uses only ranks: a chunk's fused score is
 *
 *     Σ over retrievers   1 / (k + rank_in_that_retriever)      (k = 60)
 *
 * RRF is robust, parameter-light, and the standard hybrid-search baseline.
 * Chunks surfaced by multiple retrievers (vector AND keyword) outrank chunks
 * any single source found — exactly the "both semantic and lexical agree"
 * signal hybrid retrieval exists for.
 */

import type { Retriever, RetrievalQuery, RetrievalOutcome, RetrievedChunk } from "./types.js";

export const DEFAULT_RRF_K = 60;

export interface HybridRetrieverOptions {
  retrievers: Retriever[];
  /** RRF constant (default 60). */
  rrfK?: number;
  name?: string;
}

export class HybridRetriever implements Retriever {
  readonly name: string;
  private readonly retrievers: Retriever[];
  private readonly rrfK: number;

  constructor(opts: HybridRetrieverOptions) {
    this.name = opts.name ?? "hybrid";
    this.retrievers = opts.retrievers;
    this.rrfK = opts.rrfK ?? DEFAULT_RRF_K;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const k = query.k ?? 5;
    const outcomes = await Promise.allSettled(this.retrievers.map((r) => r.retrieve(query)));
    // rank per retriever (per-source position), fused by RRF
    const fused = new Map<string, { chunk: RetrievedChunk; score: number; votes: number }>();
    outcomes.forEach((outcome) => {
      if (outcome.status !== "fulfilled") return;
      outcome.value.forEach((chunk, rank) => {
        const existing = fused.get(chunk.id);
        const contribution = 1 / (this.rrfK + rank + 1);
        if (existing) {
          existing.score += contribution;
          existing.votes += 1;
        } else {
          fused.set(chunk.id, { chunk, score: contribution, votes: 1 });
        }
      });
    });
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ chunk, score, votes }) => ({
        ...chunk,
        score: round5(score),
        metadata: { ...chunk.metadata, rrfVotes: votes },
      }));
  }
}

/** Fuse the outcome of an already-run retrieval (used by RagService). */
export function fuseByRrf(outcome: RetrievalOutcome, opts: { rrfK?: number; k?: number } = {}): RetrievedChunk[] {
  const rrfK = opts.rrfK ?? DEFAULT_RRF_K;
  const k = opts.k ?? outcome.chunks.length;
  const byRetriever = new Map<string, RetrievedChunk[]>();
  for (const chunk of outcome.chunks) {
    const key = chunk.source.retriever ?? "unknown";
    const list = byRetriever.get(key) ?? [];
    list.push(chunk);
    byRetriever.set(key, list);
  }
  const fused = new Map<string, { chunk: RetrievedChunk; score: number; votes: number }>();
  for (const list of byRetriever.values()) {
    list.forEach((chunk, rank) => {
      const contribution = 1 / (rrfK + rank + 1);
      const existing = fused.get(chunk.id);
      if (existing) {
        existing.score += contribution;
        existing.votes += 1;
      } else {
        fused.set(chunk.id, { chunk, score: contribution, votes: 1 });
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ chunk, score, votes }) => ({
      ...chunk,
      score: round5(score),
      metadata: { ...chunk.metadata, rrfVotes: votes },
    }));
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
