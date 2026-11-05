import { findCatalogEntry } from "./catalog.js";
import { ingestDocSource, IngestResult } from "./ingest.js";
import { DocsStore } from "./store.js";
import { DocSearchResult } from "./types.js";

/** How long a failed fetch (offline, unknown id, HTTP error) is not retried. */
export const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
/** Upper bound on downloads triggered by a single search call. */
export const MAX_FETCHES_PER_SEARCH = 2;

export type IngestFn = (store: DocsStore, id: string) => Promise<IngestResult>;

export interface LazyDocsOptions {
  ingest?: IngestFn;
  now?: () => number;
  onFetch?: (id: string, phase: "start" | "done" | "failed", detail?: string) => void;
}

export interface LazySearchOutcome {
  results: DocSearchResult[];
  /** Slugs that were searched (workspace-scoped, ingested only). */
  slugs: string[];
  /** Ids downloaded during this call. */
  fetched: string[];
  /** Ids skipped because a recent attempt failed. */
  skipped: string[];
}

/**
 * Fetches DevDocs sources only when a query needs them.
 *
 * - Search what is already cached first; a hit means zero network.
 * - A workspace source the query names ("react hooks") is fetched before the
 *   rest; otherwise candidates are tried in the workspace's priority order
 *   (most specific framework first).
 * - At most MAX_FETCHES_PER_SEARCH downloads per call, one at a time, stopping
 *   at the first source that yields results.
 * - Failures are remembered for FAILURE_COOLDOWN_MS; concurrent requests for
 *   the same id share one download.
 */
export class LazyDocs {
  private readonly failures = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly ingest: IngestFn;
  private readonly now: () => number;
  private readonly onFetch?: LazyDocsOptions["onFetch"];

  constructor(
    private readonly store: DocsStore,
    opts: LazyDocsOptions = {},
  ) {
    this.ingest = opts.ingest ?? ((s, id) => ingestDocSource(s, id));
    this.now = opts.now ?? Date.now;
    this.onFetch = opts.onFetch;
  }

  /** Slugs of `ids` that are already ingested, in the order given. */
  cachedSlugs(ids: string[]): string[] {
    const ingested = new Set(this.store.listSources().map((s) => s.slug));
    const slugs: string[] = [];
    for (const id of ids) {
      const slug = findCatalogEntry(id)?.slug ?? id;
      if (ingested.has(slug) && !slugs.includes(slug)) slugs.push(slug);
    }
    return slugs;
  }

  /** True once `id` is in the store, downloading it if needed. False on failure or cooldown. */
  async ensure(id: string): Promise<boolean> {
    if (this.cachedSlugs([id]).length > 0) return true;
    if (this.inCooldown(id)) return false;

    const existing = this.inflight.get(id);
    if (existing) return existing;

    const attempt = (async () => {
      this.onFetch?.(id, "start");
      try {
        const result = await this.ingest(this.store, id);
        this.onFetch?.(id, "done", `${result.name} (${result.sectionCount} sections)`);
        return true;
      } catch (err) {
        this.failures.set(id, this.now());
        this.onFetch?.(id, "failed", err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, attempt);
    return attempt;
  }

  /** Search the workspace-scoped sources, downloading only what the query needs. */
  async searchWorkspace(query: string, workspaceIds: string[], limit: number): Promise<LazySearchOutcome> {
    const fetched: string[] = [];
    const skipped: string[] = [];

    let slugs = this.cachedSlugs(workspaceIds);
    let results = slugs.length > 0 ? this.store.search(query, { slugs, limit }) : [];

    const missing = this.rankMissing(query, workspaceIds);
    for (const id of missing) {
      if (results.length > 0 || fetched.length >= MAX_FETCHES_PER_SEARCH) break;
      if (this.inCooldown(id)) {
        skipped.push(id);
        continue;
      }
      if (!(await this.ensure(id))) continue;
      fetched.push(id);
      slugs = this.cachedSlugs(workspaceIds);
      results = this.store.search(query, { slugs, limit });
    }

    return { results, slugs, fetched, skipped };
  }

  /** Workspace ids not yet cached: those the query names first, then workspace priority order. */
  private rankMissing(query: string, workspaceIds: string[]): string[] {
    const cached = new Set(this.cachedSlugs(workspaceIds));
    const missing = workspaceIds.filter((id) => !cached.has(findCatalogEntry(id)?.slug ?? id));
    const tokens = new Set(query.toLowerCase().match(/[a-z0-9_+#.]+/g) ?? []);
    const named = (id: string): boolean => {
      const entry = findCatalogEntry(id);
      const keys = [id, entry?.slug, entry?.label].filter((k): k is string => !!k).map((k) => k.toLowerCase());
      return keys.some((k) => tokens.has(k));
    };
    return [...missing.filter(named), ...missing.filter((id) => !named(id))];
  }

  private inCooldown(id: string): boolean {
    const failedAt = this.failures.get(id);
    return failedAt !== undefined && this.now() - failedAt < FAILURE_COOLDOWN_MS;
  }
}
