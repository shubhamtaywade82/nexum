import { createHash } from "node:crypto";

/**
 * Replays for repeated `Idempotency-Key` headers on mutating host routes.
 *
 * A key is scoped to the route (method + path), so one key cannot replay a
 * response from a different session or endpoint. All authenticated callers
 * share one token, so the key is not scoped per principal.
 *
 * Three rules:
 *   - Reuse with a different request body is a conflict (422), not a replay.
 *   - A duplicate that arrives while the first request is still running is
 *     refused (409) rather than executed a second time.
 *   - Only successful (2xx) responses are stored. A failed attempt releases
 *     its reservation so the client can retry with the same key.
 *
 * Entries expire after `ttlMs` and the store holds at most `maxEntries`
 * completed responses; the oldest completed entries are evicted first.
 */

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

type Entry =
  | { state: "pending"; fingerprint: string; ts: number }
  | { state: "done"; fingerprint: string; ts: number; response: IdempotentResponse };

export type IdempotencyDecision =
  | { kind: "reserved" }
  | { kind: "replay"; response: IdempotentResponse }
  | { kind: "in_progress" }
  | { kind: "conflict" };

export interface IdempotencyStoreOptions {
  /** How long a completed response stays replayable. Default 24 h. */
  ttlMs?: number;
  /** Upper bound on stored completed responses. Default 10 000. */
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: IdempotencyStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  begin(scope: string, key: string, fingerprint: string): IdempotencyDecision {
    this.expire();
    const id = entryId(scope, key);
    const existing = this.entries.get(id);
    if (!existing) {
      this.entries.set(id, { state: "pending", fingerprint, ts: this.now() });
      return { kind: "reserved" };
    }
    if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
    if (existing.state === "pending") return { kind: "in_progress" };
    return { kind: "replay", response: existing.response };
  }

  complete(scope: string, key: string, response: IdempotentResponse): void {
    const id = entryId(scope, key);
    const existing = this.entries.get(id);
    if (existing?.state !== "pending") return;
    this.entries.set(id, { state: "done", fingerprint: existing.fingerprint, ts: this.now(), response });
    this.evictOverflow();
  }

  release(scope: string, key: string): void {
    const id = entryId(scope, key);
    if (this.entries.get(id)?.state === "pending") this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }

  private expire(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.ts < cutoff) this.entries.delete(id);
    }
  }

  private evictOverflow(): void {
    // Map iterates in insertion order, so the first completed entries are the oldest.
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.state === "done") this.entries.delete(id);
    }
  }
}

/** Stable digest of a parsed JSON body, used to detect key reuse with a different request. */
export function fingerprintBody(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

function entryId(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}
