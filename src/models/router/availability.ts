import { ProviderError } from "../adapters/provider.js";

export interface ModelAvailability {
  model: string;
  available: boolean;
  /** 'ok' | 'subscription_required' | 'payment_required' | 'forbidden' | 'not_found' | 'network_error' | 'timeout' | 'http_<status>' */
  reason: string;
  checkedAt: number; // Date.now()
}

export interface AvailabilityCheckerOptions {
  /** Cache TTL in ms. Default 86_400_000 (24 h). */
  ttlMs?: number;
  /** Per-request HTTP timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** TTL for results that reflect a transient condition (timeout, 429, 5xx)
   * rather than a real entitlement answer. Default 60_000. */
  transientTtlMs?: number;
}

/** Reasons that mean "we didn't get an answer", as opposed to a definitive
 * "this key may not use this model". Caching these for the full 24h TTL made
 * one slow cold start permanently exclude a perfectly good model from routing
 * for the rest of the process — and the probe is a real completion, which is
 * exactly the request most likely to exceed the timeout on a cold model. */
const TRANSIENT_REASONS = new Set(["timeout", "network_error"]);

function isTransient(entry: ModelAvailability): boolean {
  return TRANSIENT_REASONS.has(entry.reason) || entry.reason === "http_429" || /^http_5\d\d$/.test(entry.reason);
}

/**
 * Pre-checks which Ollama Cloud models are accessible with each API key so the
 * Router never hits a 403 "subscription required" error at runtime.
 *
 * Results are cached with a configurable TTL (default 24 h). A non-blocking
 * `refreshAll()` is called at Agent startup; the cache is used for all
 * subsequent `isAvailable()` lookups.
 */
export class ModelAvailabilityChecker {
  // Map<apiKey, Map<modelId, ModelAvailability>>
  private readonly cache = new Map<string, Map<string, ModelAvailability>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly transientTtlMs: number;
  /** Deduplicate concurrent refreshAll() calls. */
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKeys: string[],
    opts: AvailabilityCheckerOptions = {},
  ) {
    // Number.isFinite, not ??: these come straight from Number(env ?? file) in
    // config.ts, and NaN is not nullish — it would slip past ?? and make
    // isFresh() permanently false, turning every lookup into a live (billed)
    // probe.
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs! > 0 ? opts.ttlMs! : 86_400_000;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? opts.timeoutMs! : 10_000;
    this.transientTtlMs =
      Number.isFinite(opts.transientTtlMs) && opts.transientTtlMs! > 0 ? opts.transientTtlMs! : 60_000;
    for (const k of apiKeys) this.cache.set(k, new Map());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns true if `model` is accessible with `apiKey`.
   * Uses the cache when fresh; does a live check otherwise.
   */
  async isAvailable(apiKey: string, model: string): Promise<boolean> {
    const cached = this.cache.get(apiKey)?.get(model);
    if (cached && this.isFresh(cached)) return cached.available;
    const result = await this.checkOne(apiKey, model);
    return result.available;
  }

  /**
   * Peeks the cache for a model's last-known availability without triggering
   * a live check — used to annotate a model picker before the user selects
   * anything. Returns undefined when never checked or the entry is stale.
   */
  cachedStatus(apiKey: string, model: string): ModelAvailability | undefined {
    const entry = this.cache.get(apiKey)?.get(model);
    return entry && this.isFresh(entry) ? entry : undefined;
  }

  /**
   * Same as `cachedStatus`, but checks across every configured API key (the
   * caller doesn't know or care which key will actually serve the request) —
   * available on any key wins; otherwise the first cached reason found.
   */
  cachedStatusAnyKey(model: string): ModelAvailability | undefined {
    let fallback: ModelAvailability | undefined;
    for (const apiKey of this.apiKeys) {
      const entry = this.cachedStatus(apiKey, model);
      if (!entry) continue;
      if (entry.available) return entry;
      fallback ??= entry;
    }
    return fallback;
  }

  /**
   * Returns all model IDs cached as available (and non-stale) for `apiKey`.
   */
  availableModels(apiKey: string): string[] {
    const map = this.cache.get(apiKey);
    if (!map) return [];
    const out: string[] = [];
    for (const [model, entry] of map) {
      if (entry.available && this.isFresh(entry)) out.push(model);
    }
    return out;
  }

  /**
   * Returns all available model IDs across all API keys (deduplicated).
   */
  allAvailableModels(): string[] {
    const seen = new Set<string>();
    for (const key of this.apiKeys) {
      for (const m of this.availableModels(key)) seen.add(m);
    }
    return [...seen];
  }

  /**
   * Refreshes all keys sequentially (to avoid hammering the API).
   * Concurrent calls are deduplicated — only one refresh runs at a time.
   */
  async refreshAll(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefreshAll().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  /**
   * Fetches all available model IDs for a single key and checks each one.
   */
  async refreshKey(apiKey: string): Promise<ModelAvailability[]> {
    let modelIds: string[];
    try {
      modelIds = await this.fetchModelIds(apiKey);
    } catch {
      return [];
    }

    const results: ModelAvailability[] = [];
    // Check in batches of 5 to avoid hammering the API.
    for (let i = 0; i < modelIds.length; i += 5) {
      const batch = modelIds.slice(i, i + 5);
      const settled = await Promise.allSettled(batch.map((m) => this.checkOne(apiKey, m)));
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
      }
    }
    return results;
  }

  /**
   * Checks a single model's availability for a given API key.
   * Always writes the result to cache.
   */
  async checkOne(apiKey: string, model: string): Promise<ModelAvailability> {
    const result = await this.doCheck(apiKey, model);
    // Ensure cache map exists (defensive)
    if (!this.cache.has(apiKey)) this.cache.set(apiKey, new Map());
    this.cache.get(apiKey)!.set(model, result);
    return result;
  }

  /** Returns aggregate stats across all keys. */
  stats(): { keys: number; total: number; available: number; unavailable: number } {
    let total = 0;
    let available = 0;
    for (const map of this.cache.values()) {
      for (const entry of map.values()) {
        total++;
        if (entry.available) available++;
      }
    }
    return { keys: this.apiKeys.length, total, available, unavailable: total - available };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Transient failures expire quickly so a cold-start timeout or a 429 can't
   * exclude a working model from routing for the full 24h TTL. */
  private isFresh(entry: ModelAvailability): boolean {
    const ttl = isTransient(entry) ? this.transientTtlMs : this.ttlMs;
    return Date.now() - entry.checkedAt < ttl;
  }

  private async doRefreshAll(): Promise<void> {
    for (const key of this.apiKeys) {
      await this.refreshKey(key);
    }
  }

  private async fetchModelIds(apiKey: string): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch("https://ollama.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!resp.ok) throw new ProviderError(`availability: GET /v1/models returned ${resp.status}`);
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async doCheck(apiKey: string, model: string): Promise<ModelAvailability> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const base: Omit<ModelAvailability, "available" | "reason"> = { model, checkedAt: Date.now() };
    try {
      // A real (tiny) chat completion, not /api/show — Ollama Cloud's
      // subscription gating is enforced on /api/chat; /api/show returns 200
      // metadata for every model regardless of entitlement, which previously
      // made every cloud model read back as "available".
      const resp = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
        signal: controller.signal,
      });
      const text = await resp.text().catch(() => "");

      if (resp.status === 200) return { ...base, available: true, reason: "ok" };
      if (resp.status === 403) {
        return {
          ...base,
          available: false,
          reason: text.toLowerCase().includes("subscription") ? "subscription_required" : "forbidden",
        };
      }
      // 402 is billing (plan or credits), matching the SDK's OllamaPaymentRequiredError.
      if (resp.status === 402) return { ...base, available: false, reason: "payment_required" };
      if (resp.status === 404) return { ...base, available: false, reason: "not_found" };
      return { ...base, available: false, reason: `http_${resp.status}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ...base, available: false, reason: msg.includes("abort") ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}
