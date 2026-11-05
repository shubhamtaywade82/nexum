/**
 * VectorStore — the persistence seam for embedding-backed retrieval.
 *
 * The shipped design is deliberately SQLite-first (zero new dependencies,
 * one file, WAL, same stack as every other Nexum store): vectors are stored
 * as Float32 BLOBs and queries are a cosine scan in JS with SQL-side
 * pre-filtering (namespace/kind/time). That is the right shape for a
 * workspace-scoped agent memory of 10⁴–10⁶ rows; when a deployment outgrows
 * it, an external ANN store (Qdrant/Chroma/pgvector) implements the same
 * interface and swaps in without touching SemanticMemory or the RAG layer.
 *
 * The InMemoryVectorStore exists for tests and ephemeral sessions.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { cosineSimilarity } from "./embedding.js";

/** What gets written into a collection. */
export interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  metadata: Record<string, unknown>;
}

/** A query hit — the record without its vector (they stay in the store). */
export interface VectorHit {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity between the query vector and this record. */
  similarity: number;
}

/**
 * Structural pre-filters applied before the cosine scan. All conditions
 * AND together; `tags` is any-match.
 */
export interface VectorFilter {
  namespace?: string;
  kinds?: string[];
  tags?: string[];
  /** Only records with metadata.createdAt >= since (epoch ms). */
  since?: number;
  /** Only records with metadata.createdAt <= until (epoch ms). */
  until?: number;
  /** Restrict to explicit ids (used for dedupe and direct lookups). */
  ids?: string[];
}

export interface VectorQueryOptions {
  k?: number;
  filter?: VectorFilter;
  /** Drop hits below this cosine similarity (default 0 — keep all). */
  minSimilarity?: number;
}

export interface VectorStore {
  upsert(record: VectorRecord): void;
  upsertBatch(records: VectorRecord[]): void;
  get(id: string): Omit<VectorRecord, "vector"> | undefined;
  /** Raw vector access by id (used by rankers that re-score stored hits). */
  vector(id: string): number[] | undefined;
  query(vector: number[], opts?: VectorQueryOptions): VectorHit[];
  delete(id: string): boolean;
  count(filter?: VectorFilter): number;
  clear(): void;
}

export function newMemoryId(): string {
  return `mem_${randomUUID()}`;
}

/** Does a record's metadata pass the filter? (Shared by all stores.) */
export function matchesFilter(metadata: Record<string, unknown>, filter?: VectorFilter): boolean {
  if (!filter) return true;
  if (filter.namespace !== undefined && metadata.namespace !== filter.namespace) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(String(metadata.kind))) return false;
  if (filter.tags !== undefined) {
    const tags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
    if (!filter.tags.some((t) => tags.includes(t))) return false;
  }
  if (filter.since !== undefined && Number(metadata.createdAt ?? 0) < filter.since) return false;
  if (filter.until !== undefined && Number(metadata.createdAt ?? 0) > filter.until) return false;
  if (filter.ids !== undefined && !filter.ids.includes(String(metadata.id))) return false;
  return true;
}

// ── In-memory ───────────────────────────────────────────────────────────────

export class InMemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, VectorRecord>();

  upsert(record: VectorRecord): void {
    this.records.set(record.id, { ...record, metadata: { ...record.metadata, id: record.id } });
  }

  upsertBatch(records: VectorRecord[]): void {
    for (const r of records) this.upsert(r);
  }

  get(id: string): Omit<VectorRecord, "vector"> | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    return { id: rec.id, text: rec.text, metadata: rec.metadata };
  }

  vector(id: string): number[] | undefined {
    return this.records.get(id)?.vector;
  }

  query(vector: number[], opts: VectorQueryOptions = {}): VectorHit[] {
    const k = opts.k ?? 5;
    const min = opts.minSimilarity ?? 0;
    const hits: VectorHit[] = [];
    for (const rec of this.records.values()) {
      if (!matchesFilter(rec.metadata, opts.filter)) continue;
      const similarity = cosineSimilarity(vector, rec.vector);
      if (similarity < min) continue;
      hits.push({ id: rec.id, text: rec.text, metadata: rec.metadata, similarity });
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }

  count(filter?: VectorFilter): number {
    if (!filter) return this.records.size;
    let n = 0;
    for (const rec of this.records.values()) if (matchesFilter(rec.metadata, filter)) n++;
    return n;
  }

  clear(): void {
    this.records.clear();
  }
}

// ── SQLite ──────────────────────────────────────────────────────────────────

interface VectorRow {
  id: string;
  namespace: string | null;
  kind: string | null;
  text: string;
  vector: Buffer;
  metadata: string;
}

/**
 * SQLite-backed vector store. One table, Float32 BLOB vectors, WAL journal,
 * SQL pre-filtering + in-JS cosine scan. The same file can host multiple
 * logical collections via `namespace` (memory, rag knowledge, ...).
 */
export class SqliteVectorStore implements VectorStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_vectors (
        id TEXT PRIMARY KEY,
        namespace TEXT,
        kind TEXT,
        text TEXT NOT NULL,
        vector BLOB NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_namespace ON semantic_vectors(namespace);
      CREATE INDEX IF NOT EXISTS idx_semantic_kind ON semantic_vectors(kind);
    `);
  }

  upsert(record: VectorRecord): void {
    this.upsertBatch([record]);
  }

  upsertBatch(records: VectorRecord[]): void {
    if (records.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO semantic_vectors (id, namespace, kind, text, vector, metadata, created_at, updated_at)
      VALUES (@id, @namespace, @kind, @text, @vector, @metadata, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        namespace = excluded.namespace,
        kind = excluded.kind,
        text = excluded.text,
        vector = excluded.vector,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);
    const tx = this.db.transaction((rows: VectorRecord[]) => {
      for (const r of rows) {
        const metadata: Record<string, unknown> = { ...r.metadata, id: r.id };
        const createdAt = Number(metadata.createdAt ?? Date.now());
        insert.run({
          id: r.id,
          namespace: (metadata.namespace as string | undefined) ?? null,
          kind: (metadata.kind as string | undefined) ?? null,
          text: r.text,
          vector: Buffer.from(new Float32Array(r.vector).buffer),
          metadata: JSON.stringify(metadata),
          createdAt,
          updatedAt: Number(metadata.updatedAt ?? createdAt),
        });
      }
    });
    tx(records);
  }

  get(id: string): Omit<VectorRecord, "vector"> | undefined {
    const row = this.db.prepare("SELECT id, text, metadata FROM semantic_vectors WHERE id = ?").get(id) as
      { id: string; text: string; metadata: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, text: row.text, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
  }

  vector(id: string): number[] | undefined {
    const row = this.db.prepare("SELECT vector FROM semantic_vectors WHERE id = ?").get(id) as
      { vector: Buffer } | undefined;
    if (!row) return undefined;
    const out = new Array<number>(row.vector.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = row.vector.readFloatLE(i * 4);
    return out;
  }

  query(vector: number[], opts: VectorQueryOptions = {}): VectorHit[] {
    const k = opts.k ?? 5;
    const min = opts.minSimilarity ?? 0;
    const filter = opts.filter;
    const rows = this.selectRows(filter);
    const hits: VectorHit[] = [];
    for (const row of rows) {
      // Read element-by-element (alignment-safe: never assume the BLOB's
      // underlying ArrayBuffer is 4-byte aligned).
      const stored = new Float32Array(row.vector.byteLength / 4);
      for (let i = 0; i < stored.length; i++) stored[i] = row.vector.readFloatLE(i * 4);
      const similarity = cosineSimilarity(vector, stored as unknown as number[]);
      if (similarity < min) continue;
      hits.push({
        id: row.id,
        text: row.text,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        similarity,
      });
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM semantic_vectors WHERE id = ?").run(id).changes > 0;
  }

  count(filter?: VectorFilter): number {
    if (!filter) {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM semantic_vectors").get() as { n: number };
      return row.n;
    }
    return this.selectRows(filter).length;
  }

  clear(): void {
    this.db.exec("DELETE FROM semantic_vectors");
  }

  /** Close the database (only when this store owns the connection). */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private selectRows(filter?: VectorFilter): VectorRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.namespace !== undefined) {
      conditions.push("namespace = @namespace");
      params.namespace = filter.namespace;
    }
    if (filter?.kinds !== undefined && filter.kinds.length > 0) {
      conditions.push(`kind IN (${filter.kinds.map((_, i) => `@kind${i}`).join(", ")})`);
      filter.kinds.forEach((kind, i) => (params[`kind${i}`] = kind));
    }
    if (filter?.since !== undefined) {
      conditions.push("created_at >= @since");
      params.since = filter.since;
    }
    if (filter?.until !== undefined) {
      conditions.push("created_at <= @until");
      params.until = filter.until;
    }
    if (filter?.ids !== undefined && filter.ids.length > 0) {
      conditions.push(`id IN (${filter.ids.map((_, i) => `@id${i}`).join(", ")})`);
      filter.ids.forEach((id, i) => (params[`id${i}`] = id));
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, namespace, kind, text, vector, metadata FROM semantic_vectors ${where}`;
    const rows = (
      filter?.tags === undefined
        ? this.db.prepare(sql).all(params)
        : (this.db.prepare(sql).all(params) as VectorRow[]).filter((row) => {
            const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
            return matchesFilter(metadata, { tags: filter.tags });
          })
    ) as VectorRow[];
    return rows;
  }
}
