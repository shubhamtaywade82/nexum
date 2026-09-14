/**
 * AttachmentStore — content-addressed data plane for persistent attachments.
 *
 * Nexum has filesystem handling and file tools, but no equivalent of a
 * generalized attachment subsystem. DeepSeek Harness has a dedicated
 * attachment capability for:
 *   - persistent attachment identifiers (attachment://sha256/...)
 *   - validation (integrity check on read)
 *   - local content-addressed storage
 *
 * Use cases:
 *   - multimodal models (images, PDFs)
 *   - agent-to-agent exchange (child returns an attachment id)
 *   - generated artifacts (charts, reports, screenshots)
 *   - external file ingestion (web crawl results, downloaded archives)
 *
 * Design:
 *   - Content-addressed: the id IS the sha256 of the content.
 *   - Immutable: once written, an attachment never changes.
 *   - Local-first: stored under .nexum/attachments/<sha256-prefix>/<sha256>
 *   - Validated: reading verifies the hash matches.
 *   - Typed: each attachment carries a mediaType and optional metadata.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// ── Contracts ───────────────────────────────────────────────────────────────

export type AttachmentId = string; // "sha256:abcdef..."

export type AttachmentMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "application/zip"
  | "application/json"
  | "text/plain"
  | "text/markdown"
  | "application/octet-stream"
  | string;

export interface AttachmentRecord {
  /** Content-addressed id: "sha256:<hex>". */
  id: AttachmentId;
  /** Media type (MIME). */
  mediaType: AttachmentMediaType;
  /** Byte size of the content. */
  size: number;
  /** When the attachment was first stored. */
  createdAt: string;
  /** Optional human-facing filename. */
  filename?: string;
  /** Optional metadata (source, tags, etc.). */
  metadata?: Record<string, unknown>;
}

export interface AttachmentStoreOptions {
  /** Root directory for attachments (e.g. workspaceRoot/.nexum). */
  rootDir: string;
  /** Disable fs writes (tests / in-memory use). */
  inMemory?: boolean;
}

// ── AttachmentStore ─────────────────────────────────────────────────────────

export class AttachmentStore {
  private readonly attachmentsDir: string;
  private readonly indexFile: string;
  private readonly inMemory = new Map<AttachmentId, { content: Buffer; record: AttachmentRecord }>();

  constructor(private readonly opts: AttachmentStoreOptions) {
    this.attachmentsDir = join(opts.rootDir, "attachments");
    this.indexFile = join(opts.rootDir, "attachments.json");
    if (!opts.inMemory) {
      mkdirSync(this.attachmentsDir, { recursive: true });
    }
  }

  /** Store content, returning the content-addressed id. */
  store(
    content: Buffer | string,
    mediaType: AttachmentMediaType = "application/octet-stream",
    metadata?: { filename?: string; metadata?: Record<string, unknown> },
  ): AttachmentRecord {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const id = hashContent(buffer);
    const record: AttachmentRecord = {
      id,
      mediaType,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      filename: metadata?.filename,
      metadata: metadata?.metadata,
    };

    if (this.opts.inMemory) {
      if (!this.inMemory.has(id)) {
        this.inMemory.set(id, { content: buffer, record });
      }
      return record;
    }

    // Filesystem: shard by first 2 hex chars to avoid huge directories.
    const shard = id.slice(7, 9); // skip "sha256:"
    const shardDir = join(this.attachmentsDir, shard);
    const contentPath = join(shardDir, id.slice(7));
    if (!existsSync(contentPath)) {
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(contentPath, buffer);
    }

    // Update index.
    this.updateIndex(record);
    return record;
  }

  /** Read attachment content, verifying the hash. */
  read(id: AttachmentId): Buffer | undefined {
    if (this.opts.inMemory) {
      return this.inMemory.get(id)?.content;
    }
    const shard = id.slice(7, 9);
    const contentPath = join(this.attachmentsDir, shard, id.slice(7));
    if (!existsSync(contentPath)) return undefined;
    const buffer = readFileSync(contentPath);
    // Verify hash integrity.
    const actualId = hashContent(buffer);
    if (actualId !== id) {
      throw new Error(
        `attachment integrity check failed: expected ${id}, got ${actualId}`,
      );
    }
    return buffer;
  }

  /** Read attachment content as a UTF-8 string. */
  readText(id: AttachmentId): string | undefined {
    const buffer = this.read(id);
    return buffer?.toString("utf8");
  }

  /** Get the metadata record for an attachment (without reading content). */
  stat(id: AttachmentId): AttachmentRecord | undefined {
    if (this.opts.inMemory) {
      return this.inMemory.get(id)?.record;
    }
    const index = this.readIndex();
    return index.find((r) => r.id === id);
  }

  /** List all stored attachments. */
  list(): AttachmentRecord[] {
    if (this.opts.inMemory) {
      return [...this.inMemory.values()].map((e) => e.record);
    }
    return this.readIndex();
  }

  /** Check if an attachment exists. */
  has(id: AttachmentId): boolean {
    return this.stat(id) !== undefined;
  }

  /** Convert an attachment id to a URI (for use in tool results / model context). */
  toUri(id: AttachmentId): string {
    return `attachment://${id}`;
  }

  /** Parse an attachment URI back to an id. */
  fromUri(uri: string): AttachmentId | undefined {
    const match = uri.match(/^attachment:\/\/(.+)$/);
    return match ? match[1] : undefined;
  }

  /** Delete an attachment (best-effort — content-addressed, so safe to remove if no refs). */
  delete(id: AttachmentId): boolean {
    if (this.opts.inMemory) {
      return this.inMemory.delete(id);
    }
    const shard = id.slice(7, 9);
    const contentPath = join(this.attachmentsDir, shard, id.slice(7));
    if (!existsSync(contentPath)) return false;
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(contentPath);
      // Remove from index.
      const index = this.readIndex().filter((r) => r.id !== id);
      this.writeIndex(index);
      return true;
    } catch {
      return false;
    }
  }

  /** Total size of all stored attachments (for diagnostics). */
  totalSize(): number {
    return this.list().reduce((sum, r) => sum + r.size, 0);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private readIndex(): AttachmentRecord[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const content = readFileSync(this.indexFile, "utf8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as AttachmentRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(records: AttachmentRecord[]): void {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2));
    const { renameSync } = require("node:fs");
    renameSync(tmp, this.indexFile);
  }

  private updateIndex(record: AttachmentRecord): void {
    const index = this.readIndex();
    const existing = index.findIndex((r) => r.id === record.id);
    if (existing >= 0) {
      // Merge metadata (don't lose existing metadata on re-store).
      index[existing] = { ...index[existing], ...record, metadata: { ...index[existing].metadata, ...record.metadata } };
    } else {
      index.push(record);
    }
    this.writeIndex(index);
  }
}

/** Compute the content-addressed id for a buffer. */
export function hashContent(buffer: Buffer): AttachmentId {
  const hash = createHash("sha256").update(buffer).digest("hex");
  return `sha256:${hash}`;
}

/** Quick utility: store a file from disk. */
export function storeFile(
  store: AttachmentStore,
  filePath: string,
  mediaType?: AttachmentMediaType,
): AttachmentRecord {
  const buffer = readFileSync(filePath);
  const filename = filePath.split("/").pop();
  return store.store(buffer, mediaType ?? guessMediaType(filePath), { filename });
}

/** Guess media type from file extension. */
export function guessMediaType(filename: string): AttachmentMediaType {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "pdf": return "application/pdf";
    case "zip": return "application/zip";
    case "json": return "application/json";
    case "md": return "text/markdown";
    case "txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

void readdirSync;
void statSync;
