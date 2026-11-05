/**
 * SemanticMemory — generic embedding-backed memory over the VectorStore.
 *
 * This closes the biggest memory gap in the runtime: Nexum had session
 * state, episodic learning, lessons and compaction, but no generic
 *
 *     experience/knowledge → embedding → vector index → semantic
 *     retrieval → memory ranking → context injection
 *
 * pipeline. SemanticMemory is that pipeline. It is deliberately decoupled
 * from the learning subsystem (episodes/lessons simply feed it through thin
 * adapters) so any product can use it for facts, notes, preferences and
 * skills as well.
 *
 * Ranking (MemoryRanker): a hit's final score blends
 *   relevance   cosine(query, record)          — what is this about?
 *   recency     exponential decay by age       — is it still current?
 *   importance  writer-declared 0..1           — how much does it matter?
 *   usage       use-count boost (capped)       — has it proven useful?
 *
 * Context injection (buildContext) renders the top hits as a compact
 * system-prompt fragment so strategies can ground new turns in remembered
 * experience without hand-rolling prompt plumbing.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspaceStateDir } from "../../platform/paths.js";
import { HashEmbedder, type EmbeddingProvider } from "./embedding.js";
import { InMemoryVectorStore, newMemoryId, SqliteVectorStore, VectorHit, VectorStore } from "./vector-store.js";

/** The kinds of things semantic memory stores. */
export type MemoryKind = "fact" | "lesson" | "episode" | "note" | "preference" | "skill";

export interface MemoryEntryInput {
  text: string;
  kind?: MemoryKind;
  /** Writer-declared 0..1 importance (default 0.5). */
  importance?: number;
  tags?: string[];
  /** Logical collection (default "default"; products use per-workspace ids). */
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryScore {
  relevance: number;
  recency: number;
  importance: number;
  usage: number;
  final: number;
}

export interface MemoryHit {
  id: string;
  text: string;
  kind: MemoryKind;
  tags: string[];
  namespace: string;
  createdAt: number;
  score: MemoryScore;
  metadata: Record<string, unknown>;
}

export interface MemoryRecallOptions {
  k?: number;
  kinds?: MemoryKind[];
  namespace?: string;
  tags?: string[];
  /** Drop hits whose final (blended) score is below this (default 0). */
  minScore?: number;
  /** Bump useCount/lastUsedAt on returned hits (default false). */
  touch?: boolean;
}

export interface RankerWeights {
  relevance: number;
  recency: number;
  importance: number;
  usage: number;
}

export const DEFAULT_RANKER_WEIGHTS: RankerWeights = {
  relevance: 0.6,
  recency: 0.15,
  importance: 0.15,
  usage: 0.1,
};

/**
 * Pure ranking math, isolated so it is trivially unit-testable and tunable
 * per product. recency = 2^(-age / halfLifeMs); usage boost saturates at
 * 8 uses.
 */
export class MemoryRanker {
  constructor(
    readonly weights: RankerWeights = DEFAULT_RANKER_WEIGHTS,
    private readonly halfLifeMs: number = 30 * 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  score(hit: { similarity: number; metadata: Record<string, unknown> }): MemoryScore {
    const relevance = clamp01(hit.similarity);
    const createdAt = Number(hit.metadata.createdAt ?? this.now());
    const age = Math.max(0, this.now() - createdAt);
    const recency = Math.pow(2, -age / this.halfLifeMs);
    const importance = clamp01(Number(hit.metadata.importance ?? 0.5));
    const uses = Number(hit.metadata.useCount ?? 0);
    const usage = uses / (uses + 4); // saturating: 0, .2, .33, .43, .5 …
    const w = this.weights;
    const totalWeight = w.relevance + w.recency + w.importance + w.usage;
    const final =
      totalWeight > 0
        ? (w.relevance * relevance + w.recency * recency + w.importance * importance + w.usage * usage) / totalWeight
        : 0;
    return {
      relevance: round4(relevance),
      recency: round4(recency),
      importance: round4(importance),
      usage: round4(usage),
      final: round4(final),
    };
  }
}

export interface SemanticMemoryOptions {
  store?: VectorStore;
  embedder: EmbeddingProvider;
  ranker?: MemoryRanker;
  namespace?: string;
  /** How many extra candidates to fetch before ranking (default 4×k). */
  overfetch?: number;
}

export class SemanticMemory {
  readonly store: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly ranker: MemoryRanker;
  readonly namespace: string;
  private readonly overfetch: number;

  constructor(opts: SemanticMemoryOptions) {
    this.store = opts.store ?? new InMemoryVectorStore();
    this.embedder = opts.embedder;
    this.ranker = opts.ranker ?? new MemoryRanker();
    this.namespace = opts.namespace ?? "default";
    this.overfetch = opts.overfetch ?? 4;
  }

  /** Embed + persist one memory entry. Returns the record id. */
  async remember(input: MemoryEntryInput): Promise<string> {
    const text = input.text.trim();
    if (!text) throw new Error("memory text must be non-empty");
    const kind = input.kind ?? "note";
    const importance = clamp01(input.importance ?? 0.5);
    const namespace = input.namespace ?? this.namespace;
    const now = Date.now();
    const id = newMemoryId();
    const vector = await this.embedder.embed(text);
    this.store.upsert({
      id,
      vector,
      text,
      metadata: {
        ...(input.metadata ?? {}),
        id,
        kind,
        importance,
        tags: input.tags ?? [],
        namespace,
        createdAt: now,
        updatedAt: now,
        useCount: 0,
        embedder: this.embedder.id,
      },
    });
    return id;
  }

  /** Semantic recall: embed the query, overfetch, blend-rank, cut to k. */
  async recall(query: string, opts: MemoryRecallOptions = {}): Promise<MemoryHit[]> {
    const k = opts.k ?? 5;
    const minScore = opts.minScore ?? 0;
    const queryVector = await this.embedder.embed(query);
    const candidates = this.store.query(queryVector, {
      k: Math.max(k * this.overfetch, k),
      filter: {
        namespace: opts.namespace ?? this.namespace,
        ...(opts.kinds ? { kinds: opts.kinds } : {}),
        ...(opts.tags ? { tags: opts.tags } : {}),
      },
    });

    const hits: MemoryHit[] = candidates
      .map((hit: VectorHit) => ({ hit, score: this.ranker.score(hit) }))
      .filter(({ score }) => score.final >= minScore)
      .sort((a, b) => b.score.final - a.score.final)
      .slice(0, k)
      .map(({ hit, score }) => toMemoryHit(hit, score));

    if (opts.touch && hits.length > 0) this.touchAll(hits);
    return hits;
  }

  get(id: string): Omit<VectorRecordLike, "vector"> | undefined {
    return this.store.get(id);
  }

  forget(id: string): boolean {
    return this.store.delete(id);
  }

  count(opts: { namespace?: string; kinds?: MemoryKind[] } = {}): number {
    return this.store.count({
      namespace: opts.namespace ?? this.namespace,
      ...(opts.kinds ? { kinds: opts.kinds } : {}),
    });
  }

  /**
   * Context injection: render the top-k memories for `query` as a compact
   * fragment suitable for a system prompt. Returns undefined when nothing
   * scored above `minScore` so callers never inject an empty block.
   */
  async buildContext(
    query: string,
    opts: MemoryRecallOptions & { maxChars?: number; header?: string } = {},
  ): Promise<string | undefined> {
    const hits = await this.recall(query, opts);
    if (hits.length === 0) return undefined;
    const header = opts.header ?? "Relevant memory (from long-term semantic memory):";
    const lines = [header];
    for (const hit of hits) {
      const date = new Date(hit.createdAt).toISOString().slice(0, 10);
      const line = `- [${hit.kind}·${date}] ${hit.text}`;
      lines.push(line.length > 240 ? `${line.slice(0, 237)}...` : line);
    }
    let text = lines.join("\n");
    const maxChars = opts.maxChars ?? 2000;
    if (text.length > maxChars) text = `${text.slice(0, maxChars - 3)}...`;
    return text;
  }

  // ── Learning-subsystem adapters ─────────────────────────────────────────

  /** Feed a graded lesson (src/learning lesson-store shape) into memory. */
  async recordLesson(lesson: {
    category: string;
    context: string;
    lesson: string;
    importance?: number;
  }): Promise<string> {
    return this.remember({
      text: `Lesson (${lesson.category}): ${lesson.lesson}\nContext: ${lesson.context}`,
      kind: "lesson",
      importance: lesson.importance ?? 0.6,
      tags: ["lesson", lesson.category],
      metadata: { source: "learning" },
    });
  }

  /** Feed an episode summary (post-run learning) into memory. */
  async recordEpisode(episode: {
    goal: string;
    summary: string;
    outcome: string;
    importance?: number;
  }): Promise<string> {
    return this.remember({
      text: `Episode (${episode.outcome}) — goal: ${episode.goal}\nSummary: ${episode.summary}`,
      kind: "episode",
      importance: episode.importance ?? (episode.outcome === "success" ? 0.6 : 0.7),
      tags: ["episode", episode.outcome],
      metadata: { source: "learning" },
    });
  }

  private touchAll(hits: MemoryHit[]): void {
    for (const hit of hits) {
      const existing = this.store.get(hit.id);
      const vector = this.store.vector(hit.id);
      if (!existing || !vector) continue;
      const useCount = Number(existing.metadata.useCount ?? 0) + 1;
      this.store.upsert({
        id: hit.id,
        vector,
        text: existing.text,
        metadata: { ...existing.metadata, useCount, lastUsedAt: Date.now() },
      });
    }
  }
}

/** get() returns records without vectors — that shape, named. */
type VectorRecordLike = { id: string; text: string; metadata: Record<string, unknown> };

function toMemoryHit(hit: VectorHit, score: MemoryScore): MemoryHit {
  const metadata = hit.metadata ?? {};
  return {
    id: hit.id,
    text: hit.text,
    kind: (metadata.kind as MemoryKind) ?? "note",
    tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
    namespace: String(metadata.namespace ?? "default"),
    createdAt: Number(metadata.createdAt ?? 0),
    score,
    metadata,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ── Composition helper ──────────────────────────────────────────────────────

export interface CreateSemanticMemoryOptions {
  /** SQLite file path; defaults to an in-memory store when omitted. */
  dbPath?: string;
  embedder?: EmbeddingProvider;
  namespace?: string;
  ranker?: MemoryRanker;
}

/**
 * Factory used by composition roots (AgentToolManager mounts this by
 * default — see src/tools/packs/memory-pack.ts). The default embedder is
 * the offline HashEmbedder; an Ollama embedding model plugs in via
 * `embedder` when available.
 */
export function createSemanticMemory(opts: CreateSemanticMemoryOptions = {}): SemanticMemory {
  const store = opts.dbPath ? new SqliteVectorStore(opts.dbPath) : new InMemoryVectorStore();
  return new SemanticMemory({
    store,
    embedder: opts.embedder ?? defaultEmbedder(),
    namespace: opts.namespace,
    ranker: opts.ranker,
  });
}

let cachedDefaultEmbedder: EmbeddingProvider | undefined;

/** Process-wide default embedder (deterministic, offline, 256-dim). */
export function defaultEmbedder(): EmbeddingProvider {
  cachedDefaultEmbedder ??= new HashEmbedder();
  return cachedDefaultEmbedder;
}

// ── Workspace composition ───────────────────────────────────────────────────

/**
 * Open (or create) the workspace-scoped semantic memory: a SqliteVectorStore
 * inside `<workspaceRoot>/.nexum/memory.db` — the same database file the
 * conversation MemoryStore uses, so all durable memory lives in one place.
 *
 * This is what AgentToolManager mounts by default (default-on integration).
 */
export function createWorkspaceSemanticMemory(
  workspaceRoot: string,
  opts: { embedder?: EmbeddingProvider; namespace?: string } = {},
): SemanticMemory {
  const dbPath = join(workspaceStateDir(workspaceRoot), "memory.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  return createSemanticMemory({ dbPath, embedder: opts.embedder, namespace: opts.namespace });
}
