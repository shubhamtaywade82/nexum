/**
 * Rerankers — the second-stage precision layer of hybrid retrieval.
 *
 * Stage 1 (retrieval) is recall-oriented; stage 2 reorders a small candidate
 * set with a stronger signal. Two implementations:
 *
 *   HeuristicReranker   token-overlap + coverage features, no model
 *   LlmReranker         a model scores query-passage relevance 0..1
 *
 * Both degrade gracefully: LlmReranker falls back to the input order when
 * the model call or its JSON parse fails — reranking must never *break*
 * retrieval.
 */

import type { ModelGateway } from "../models/gateway/model-gateway.js";
import type { Capability } from "../models/catalog.js";
import type { RetrievedChunk } from "./types.js";
import { tokenize } from "./retrievers.js";

export interface Reranker {
  readonly name: string;
  rerank(query: string, chunks: RetrievedChunk[], topK?: number): Promise<RetrievedChunk[]>;
}

export interface HeuristicRerankerOptions {
  /** Weight of query-term coverage in the content (default 0.6). */
  coverageWeight?: number;
  /** Weight of exact phrase containment (default 0.3). */
  phraseWeight?: number;
  /** Weight carried over from the stage-1 score (default 0.1). */
  stage1Weight?: number;
}

/** Deterministic reranker: coverage, phrase hit, and stage-1 carryover. */
export class HeuristicReranker implements Reranker {
  readonly name = "heuristic";
  private readonly coverageWeight: number;
  private readonly phraseWeight: number;
  private readonly stage1Weight: number;

  constructor(opts: HeuristicRerankerOptions = {}) {
    this.coverageWeight = opts.coverageWeight ?? 0.6;
    this.phraseWeight = opts.phraseWeight ?? 0.3;
    this.stage1Weight = opts.stage1Weight ?? 0.1;
  }

  async rerank(query: string, chunks: RetrievedChunk[], topK?: number): Promise<RetrievedChunk[]> {
    const queryTokens = [...new Set(tokenize(query))];
    const phrase = query.trim().toLowerCase();
    const scored = chunks.map((chunk) => {
      const contentTokens = new Set(tokenize(chunk.content));
      const covered = queryTokens.filter((t) => contentTokens.has(t));
      const coverage = queryTokens.length > 0 ? covered.length / queryTokens.length : 0;
      const phraseHit = phrase.length > 3 && chunk.content.toLowerCase().includes(phrase) ? 1 : 0;
      const stage1 = Math.max(0, Math.min(1, chunk.score));
      const score = this.coverageWeight * coverage + this.phraseWeight * phraseHit + this.stage1Weight * stage1;
      return { chunk, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK ?? scored.length)
      .map(({ chunk, score }) => ({
        ...chunk,
        score: Math.round(score * 1e4) / 1e4,
        metadata: { ...chunk.metadata, reranker: this.name },
      }));
  }
}

export interface LlmRerankerOptions {
  modelGateway: ModelGateway;
  /** Capability used for routing the rerank model (default "quick"). */
  capability?: Capability;
  /** Per-call timeout guard: max chunks scored per call (default 16). */
  maxChunks?: number;
}

/** Model-based reranker: the model scores each passage 0..1 as JSON. */
export class LlmReranker implements Reranker {
  readonly name = "llm";
  private readonly gateway: ModelGateway;
  private readonly capability: Capability;
  private readonly maxChunks: number;

  constructor(opts: LlmRerankerOptions) {
    this.gateway = opts.modelGateway;
    this.capability = opts.capability ?? "quick";
    this.maxChunks = opts.maxChunks ?? 16;
  }

  async rerank(query: string, chunks: RetrievedChunk[], topK?: number): Promise<RetrievedChunk[]> {
    const limit = Math.min(chunks.length, this.maxChunks);
    if (limit === 0) return [];
    const passages = chunks.slice(0, limit);
    const prompt = [
      "You are a relevance reranker. Score each passage for how well it answers the query.",
      `Query: ${query}`,
      "",
      "Passages:",
      ...passages.map((c, i) => `[${i}] ${c.content.slice(0, 500)}`),
      "",
      'Respond with ONLY a JSON object: {"scores": [number, ...]} where scores[i] is the relevance',
      "of passage [i] from 0.0 (irrelevant) to 1.0 (directly answers the query).",
    ].join("\n");

    try {
      const response = await this.gateway.route(this.capability, [{ role: "user", content: prompt }]);
      const parsed = extractJson(String(response.message?.content ?? "")) as { scores?: unknown };
      const scores = Array.isArray(parsed.scores)
        ? parsed.scores.map((s) => (typeof s === "number" && Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0))
        : [];
      if (scores.length === 0) throw new Error("no scores in response");
      const scored = passages.map((chunk, i) => ({
        ...chunk,
        score: scores[i] ?? 0,
        metadata: { ...chunk.metadata, reranker: this.name },
      }));
      return scored.sort((a, b) => b.score - a.score).slice(0, topK ?? scored.length);
    } catch {
      // Reranking must never break retrieval — fall back to stage-1 order.
      return chunks.slice(0, topK ?? chunks.length);
    }
  }
}

/** Tolerant JSON extraction: first balanced {...} or [...] block in text. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.unshift(fence[1].trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the first balanced object
    }
  }
  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === open) depth++;
      else if (trimmed[i] === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("no JSON found in response");
}
