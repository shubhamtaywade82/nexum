/**
 * Artifacts — first-class outputs with identity, versions, and provenance.
 *
 * Coding agents naturally produce files, patches, diffs, reports,
 * screenshots, logs and benchmark results — today those travel as giant
 * strings inside messages or as anonymous side effects. The ArtifactStore
 * gives them identity so agents (and multi-agent pipelines) reference and
 * compose them instead:
 *
 *   ResearchAgent  → research artifact (v1 → v2 with sources)
 *   AnalysisAgent  → analysis artifact (derives from research v2)
 *   WriterAgent    → report artifact (derives from analysis v1)
 *
 * Every artifact is content-hashed, versioned per (name, kind), and carries
 * provenance (which run/agent/trace produced it, from which parents, via
 * which tool calls). Derivation chains make "where did this number come
 * from" answerable without re-running anything.
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export type ArtifactKind =
  | "report"
  | "patch"
  | "diff"
  | "code"
  | "data"
  | "screenshot"
  | "log"
  | "benchmark"
  | "research"
  | "analysis"
  | "custom";

/** Reference to another artifact — the edges of the derivation graph. */
export interface ArtifactReference {
  artifactId: string;
  /** Resolve to a specific version (default: latest). */
  version?: number;
  name?: string;
}

export interface ArtifactProvenance {
  runId?: string;
  agentId?: string;
  sessionId?: string;
  traceId?: string;
  /** Artifacts this one was derived from. */
  sources?: ArtifactReference[];
  /** Tool calls that contributed (correlation ids). */
  toolCalls?: string[];
  createdAt: number;
}

export interface Artifact {
  /** Stable id: art_<uuid>. */
  id: string;
  /** Human-facing name — versioned per (name, kind). */
  name: string;
  kind: ArtifactKind;
  mimeType?: string;
  content: string;
  /** sha256 of the content (content-addressed identity). */
  contentHash: string;
  /** Monotonic per (name, kind), starting at 1. */
  version: number;
  tags: string[];
  provenance: ArtifactProvenance;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface ArtifactSaveInput {
  name: string;
  kind?: ArtifactKind;
  content: string;
  mimeType?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  provenance?: Omit<ArtifactProvenance, "createdAt">;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
  tags?: string[];
  /** Only artifacts created by this agent. */
  agentId?: string;
  /** Only artifacts created at/after this epoch ms. */
  since?: number;
  limit?: number;
}

export interface ArtifactStore {
  save(input: ArtifactSaveInput): Artifact;
  get(id: string): Artifact | undefined;
  /** Latest version of a (name, kind) artifact. */
  latest(name: string, kind?: ArtifactKind): Artifact | undefined;
  /** Every version of a (name, kind) artifact, oldest first. */
  versions(name: string, kind?: ArtifactKind): Artifact[];
  query(filter?: ArtifactQuery): Artifact[];
  count(filter?: ArtifactQuery): number;
  delete(id: string): boolean;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function newArtifactId(): string {
  return `art_${randomUUID()}`;
}

function toArtifact(input: ArtifactSaveInput, version: number): Artifact {
  const now = Date.now();
  return {
    id: newArtifactId(),
    name: input.name,
    kind: input.kind ?? "custom",
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    content: input.content,
    contentHash: contentHash(input.content),
    version,
    tags: input.tags ?? [],
    provenance: { ...(input.provenance ?? {}), createdAt: now },
    metadata: input.metadata ?? {},
    createdAt: now,
  };
}

/** Volatile store — tests and ephemeral sessions. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();

  save(input: ArtifactSaveInput): Artifact {
    const nextVersion = this.nextVersion(input.name, input.kind ?? "custom");
    const artifact = toArtifact(input, nextVersion);
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const artifact = this.artifacts.get(id);
    return artifact ? { ...artifact } : undefined;
  }

  latest(name: string, kind?: ArtifactKind): Artifact | undefined {
    const all = this.versions(name, kind);
    return all.length > 0 ? { ...all[all.length - 1] } : undefined;
  }

  versions(name: string, kind?: ArtifactKind): Artifact[] {
    return [...this.artifacts.values()]
      .filter((a) => a.name === name && (kind === undefined || a.kind === kind))
      .sort((a, b) => a.version - b.version)
      .map((a) => ({ ...a }));
  }

  query(filter?: ArtifactQuery): Artifact[] {
    return [...this.artifacts.values()]
      .filter((a) => this.matches(a, filter))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter?.limit ?? 100)
      .map((a) => ({ ...a }));
  }

  count(filter?: ArtifactQuery): number {
    return [...this.artifacts.values()].filter((a) => this.matches(a, filter)).length;
  }

  delete(id: string): boolean {
    return this.artifacts.delete(id);
  }

  private nextVersion(name: string, kind: ArtifactKind): number {
    return this.versions(name, kind).length + 1;
  }

  private matches(artifact: Artifact, filter?: ArtifactQuery): boolean {
    if (!filter) return true;
    if (filter.kind !== undefined && artifact.kind !== filter.kind) return false;
    if (filter.agentId !== undefined && artifact.provenance.agentId !== filter.agentId) return false;
    if (filter.since !== undefined && artifact.createdAt < filter.since) return false;
    if (filter.tags !== undefined && filter.tags.length > 0) {
      const has = filter.tags.some((t) => artifact.tags.includes(t));
      if (!has) return false;
    }
    return true;
  }
}

interface ArtifactRow {
  id: string;
  name: string;
  kind: string;
  mime_type: string | null;
  content: string;
  content_hash: string;
  version: number;
  tags: string;
  provenance: string;
  metadata: string;
  created_at: number;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ArtifactKind,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    content: row.content,
    contentHash: row.content_hash,
    version: row.version,
    tags: JSON.parse(row.tags) as string[],
    provenance: JSON.parse(row.provenance) as ArtifactProvenance,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/** SQLite-backed store (table artifacts). One connection, WAL. */
export class SqliteArtifactStore implements ArtifactStore {
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
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        tags TEXT NOT NULL,
        provenance TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_name ON artifacts(name, kind, version);
      CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
    `);
  }

  save(input: ArtifactSaveInput): Artifact {
    const kind = input.kind ?? "custom";
    const versionRow = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE name = ? AND kind = ?")
      .get(input.name, kind) as { v: number };
    const artifact = toArtifact(input, versionRow.v + 1);
    this.db
      .prepare(
        `INSERT INTO artifacts (id, name, kind, mime_type, content, content_hash, version, tags, provenance, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.name,
        artifact.kind,
        artifact.mimeType ?? null,
        artifact.content,
        artifact.contentHash,
        artifact.version,
        JSON.stringify(artifact.tags),
        JSON.stringify(artifact.provenance),
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
      );
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  latest(name: string, kind?: ArtifactKind): Artifact | undefined {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE name = ? AND (? IS NULL OR kind = ?) ORDER BY version DESC LIMIT 1")
      .get(name, kind ?? null, kind ?? null) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  versions(name: string, kind?: ArtifactKind): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE name = ? AND (? IS NULL OR kind = ?) ORDER BY version ASC")
      .all(name, kind ?? null, kind ?? null) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  query(filter?: ArtifactQuery): Artifact[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter?.agentId !== undefined) {
      conditions.push("json_extract(provenance, '$.agentId') = ?");
      params.push(filter.agentId);
    }
    if (filter?.since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(filter.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let rows = this.db
      .prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at DESC`)
      .all(...params) as ArtifactRow[];
    if (filter?.tags !== undefined && filter.tags.length > 0) {
      rows = rows.filter((row) => {
        const tags = JSON.parse(row.tags) as string[];
        return filter.tags!.some((t) => tags.includes(t));
      });
    }
    return rows.slice(0, filter?.limit ?? 100).map(rowToArtifact);
  }

  count(filter?: ArtifactQuery): number {
    return this.query({ ...filter, limit: Number.MAX_SAFE_INTEGER }).length;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

/**
 * Derivation helper: save a new version whose provenance links back to the
 * parent artifacts — the multi-agent handoff seam (agents exchange
 * references, not payload strings).
 */
export function deriveArtifact(
  store: ArtifactStore,
  parent: ArtifactReference,
  input: Omit<ArtifactSaveInput, "name"> & { name?: string },
): Artifact {
  const parentArtifact = store.get(parent.artifactId);
  if (!parentArtifact) throw new Error(`parent artifact "${parent.artifactId}" not found`);
  return store.save({
    ...input,
    name: input.name ?? parentArtifact.name,
    provenance: {
      ...(input.provenance ?? {}),
      sources: [...(input.provenance?.sources ?? []), { ...parent, name: parentArtifact.name }],
    },
  });
}
