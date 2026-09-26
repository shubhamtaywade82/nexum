/**
 * EmbeddingProvider — the pluggable text→vector seam for semantic memory
 * and hybrid RAG.
 *
 * Nexum's shipped retrieval is structural/lexical (SQLite FTS5, Rails graph,
 * LSP). Semantic retrieval needs vectors, and vectors need a provider. The
 * runtime must stay fully functional offline with zero new dependencies, so
 * the default provider is a deterministic hashed-n-gram embedder (no model,
 * no network, stable across processes). Real embedding models plug in behind
 * the same interface:
 *
 *   HashEmbedder        deterministic offline default (dim 256)
 *   OllamaEmbedder      real embeddings via Ollama's /api/embed endpoint
 *   FallbackEmbedder    primary → secondary with dimension adaptation
 *
 * IMPORTANT: vectors from different providers (or different dimensions)
 * must never be mixed inside one vector collection. FallbackEmbedder adapts
 * the secondary's output to the primary's dimensionality (zero-pad /
 * truncate) precisely so a collection keeps one shape even when the primary
 * provider is unreachable.
 */

/** A text → vector provider. Implementations MUST be deterministic per text. */
export interface EmbeddingProvider {
  /** Stable provider id (recorded alongside vectors for diagnostics). */
  readonly id: string;
  /** Vector dimensionality this provider emits. */
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** FNV-1a 32-bit hash — small, fast, stable across processes/runs. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Normalize an English-ish token for hashing. Lowercases and strips noise. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\-.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

export interface HashEmbedderOptions {
  /** Vector dimensionality (default 256 — plenty for hashed n-grams). */
  dimensions?: number;
  /** Include bigrams (default true) — cheap lexical composition signal. */
  bigrams?: boolean;
  /** Include trigrams (default false). */
  trigrams?: boolean;
}

/**
 * Deterministic offline embedder: unigrams (+ optional n-grams) are FNV-1a
 * hashed into `dimensions` buckets with sign alternation from a second hash,
 * then L2-normalized. Similar texts share n-grams → high cosine similarity;
 * unrelated texts average out near zero. No model, no network, same output
 * in every process — which is what a durable vector collection needs.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly useBigrams: boolean;
  private readonly useTrigrams: boolean;

  constructor(opts: HashEmbedderOptions = {}) {
    this.dimensions = opts.dimensions ?? 256;
    this.useBigrams = opts.bigrams ?? true;
    this.useTrigrams = opts.trigrams ?? false;
    this.id = `hash-${this.dimensions}d`;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t));
  }

  embedSync(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    const grams: string[] = [...tokens];
    if (this.useBigrams || this.useTrigrams) {
      for (let i = 0; i < tokens.length - 1; i++) {
        grams.push(`${tokens[i]} ${tokens[i + 1]}`);
      }
    }
    if (this.useTrigrams) {
      for (let i = 0; i < tokens.length - 2; i++) {
        grams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
      }
    }
    for (const gram of grams) {
      const bucket = fnv1a(gram) % this.dimensions;
      const sign = fnv1a(gram, 0x9e3779b9) & 1 ? 1 : -1;
      vec[bucket] += sign;
    }
    return l2Normalize(vec);
  }
}

export interface OllamaEmbedderOptions {
  /** Ollama base URL (default http://localhost:11434). */
  baseUrl?: string;
  /** Embedding model id (required, e.g. "nomic-embed-text"). */
  model: string;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Override dimensions (0 = trust the model's output length). */
  dimensions?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Real embeddings via Ollama's native embedding endpoints. Tries the modern
 * `/api/embed` (batch) shape first and falls back to the legacy
 * `/api/embeddings` shape, so it works across Ollama versions.
 */
export class OllamaEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(opts: OllamaEmbedderOptions) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.dimensions = opts.dimensions ?? 0;
    this.signal = opts.signal;
    this.id = `ollama:${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ollama /api/embed HTTP ${res.status}`);
      const body = (await res.json()) as { embeddings?: number[][] };
      if (!body.embeddings || body.embeddings.length !== texts.length) {
        throw new Error("ollama /api/embed returned unexpected payload");
      }
      return body.embeddings.map((v) => l2Normalize(v));
    } catch (err) {
      // Legacy single-text endpoint fallback (older Ollama versions).
      if (texts.length !== 1) throw err;
      try {
        return [await this.embedLegacy(texts[0])];
      } catch {
        throw err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedLegacy(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`ollama /api/embeddings HTTP ${res.status}`);
    const body = (await res.json()) as { embedding?: number[] };
    if (!body.embedding) throw new Error("ollama /api/embeddings returned no embedding");
    return l2Normalize(body.embedding);
  }
}

export interface FallbackEmbedderOptions {
  /** Called when the primary fails and the secondary is used. */
  onFallback?: (reason: string) => void;
}

/**
 * Primary embedder with a secondary fallback. The PRIMARY's dimensionality
 * wins: the secondary's vectors are zero-padded or truncated to match, so a
 * vector collection keeps a single shape across provider outages. (Cross-
 * provider similarity degrades while degraded — the onFallback hook lets
 * operators observe that state instead of silently trusting it.)
 */
export class FallbackEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly onFallback?: (reason: string) => void;

  constructor(
    private readonly primary: EmbeddingProvider,
    private readonly secondary: EmbeddingProvider,
    opts: FallbackEmbedderOptions = {},
  ) {
    this.id = `fallback(${primary.id}→${secondary.id})`;
    this.dimensions = primary.dimensions;
    this.onFallback = opts.onFallback;
  }

  async embed(text: string): Promise<number[]> {
    try {
      return await this.primary.embed(text);
    } catch (err) {
      this.onFallback?.(err instanceof Error ? err.message : String(err));
      return this.adapt(await this.secondary.embed(text));
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.primary.embedBatch(texts);
    } catch (err) {
      this.onFallback?.(err instanceof Error ? err.message : String(err));
      const vectors = await this.secondary.embedBatch(texts);
      return vectors.map((v) => this.adapt(v));
    }
  }

  private adapt(vector: number[]): number[] {
    if (vector.length === this.dimensions) return vector;
    if (vector.length > this.dimensions) return vector.slice(0, this.dimensions);
    return [...vector, ...new Array<number>(this.dimensions - vector.length).fill(0)];
  }
}

/** L2-normalize a vector; a zero vector is returned unchanged. */
export function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/** Cosine similarity in [-1, 1]; mismatched dimensions return 0. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
