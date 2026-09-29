import { ModelAvailabilityChecker } from "./availability.js";

interface KeySlot {
  apiKey: string;
  /** Empty string means unbound (not yet assigned to any model). */
  boundModel: string;
  busy: boolean;
}

export interface KeyManagerOptions {
  /** How long to wait between poll cycles when all slots are busy (ms). Default 200. */
  pollIntervalMs?: number;
  /** Maximum time to wait for a slot before giving up (ms). Default 30_000. */
  acquireTimeoutMs?: number;
}

/**
 * Manages a pool of Ollama Cloud API keys, binding each to a specific model to
 * keep it warm in Ollama Cloud VRAM and prevent thrashing.
 *
 * - A key bound to model A will never be used for model B while busy.
 * - An unbound key can be bound to any model whose availability is confirmed.
 * - Multiple concurrent callers for the same model queue and share one key.
 *
 * This layer sits ABOVE the Provider's existing 429-rotation fallback, which
 * remains intact as a last-resort safety net.
 */
export class KeyManager {
  private readonly slots: KeySlot[];
  private readonly pollIntervalMs: number;
  private readonly acquireTimeoutMs: number;

  constructor(
    apiKeys: string[],
    private readonly checker: ModelAvailabilityChecker,
    opts: KeyManagerOptions = {},
  ) {
    this.slots = apiKeys.map((k) => ({ apiKey: k, boundModel: "", busy: false }));
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 30_000;
  }

  /**
   * Acquires an API key for the given model.
   * Preference order:
   *   1. Already-bound-to-model, not busy → immediately available.
   *   2. Unbound key whose checker confirms model is available → bind + return.
   *   3. Poll until one of the above becomes true (up to acquireTimeoutMs).
   *
   * Caller MUST call `release(apiKey)` in a finally block.
   */
  async acquire(model: string): Promise<string> {
    const deadline = Date.now() + this.acquireTimeoutMs;

    while (true) {
      const key = await this.tryAcquire(model);
      if (key !== null) return key;

      if (Date.now() >= deadline) {
        throw new Error(
          `[KeyManager] timed out waiting for an available key for model "${model}" after ${this.acquireTimeoutMs}ms`,
        );
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Non-blocking single attempt to acquire a key.
   * Returns the API key string or null if no slot is currently available.
   */
  async tryAcquire(model: string): Promise<string | null> {
    // 1. Prefer an already-bound, idle slot for this model.
    for (const slot of this.slots) {
      if (slot.boundModel === model && !slot.busy) {
        slot.busy = true;
        return slot.apiKey;
      }
    }

    // 2. Try to bind an unbound idle slot. The slot is marked busy BEFORE the
    // probe await: the probe is async, and without the reservation two
    // concurrent acquires for different models could both select the same
    // slot, both see the probe succeed, and clobber each other's binding
    // while sharing one key — leaving a second key idle for no reason. If
    // the probe says the model is unavailable, the reservation is dropped
    // and the next unbound slot is tried.
    for (const slot of this.slots) {
      if (slot.boundModel === "" && !slot.busy) {
        slot.busy = true;
        let ok: boolean;
        try {
          ok = await this.checker.isAvailable(slot.apiKey, model);
        } catch {
          ok = false;
        }
        if (ok) {
          slot.boundModel = model;
          return slot.apiKey;
        }
        // Model not available on this key — drop the reservation and try
        // the next unbound slot.
        slot.busy = false;
      }
    }

    return null;
  }

  /**
   * Releases a previously acquired key.
   * The key stays bound to its model (to keep it warm); only `busy` is cleared.
   */
  release(apiKey: string): void {
    const slot = this.slots.find((s) => s.apiKey === apiKey);
    if (slot) slot.busy = false;
  }

  /**
   * Returns the API key of the first idle slot bound to `model`, or null.
   * Non-blocking; useful for status display / stats.
   */
  bestKeyForModel(model: string): string | null {
    const slot = this.slots.find((s) => s.boundModel === model && !s.busy);
    return slot?.apiKey ?? null;
  }

  /**
   * Returns all unique models that currently have at least one bound slot.
   */
  boundModels(): string[] {
    return [...new Set(this.slots.map((s) => s.boundModel).filter(Boolean))];
  }

  /**
   * Returns a snapshot of all slots for monitoring / debugging.
   */
  snapshot(): ReadonlyArray<{ apiKey: string; boundModel: string; busy: boolean }> {
    return this.slots.map((s) => ({ apiKey: s.apiKey.slice(0, 8) + "…", boundModel: s.boundModel, busy: s.busy }));
  }

  /**
   * Resets a slot's model binding (e.g. after a model is evicted from Ollama Cloud).
   */
  unbind(apiKey: string): void {
    const slot = this.slots.find((s) => s.apiKey === apiKey);
    if (slot && !slot.busy) {
      slot.boundModel = "";
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
