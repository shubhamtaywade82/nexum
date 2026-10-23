/**
 * OllamaSystemOneClient — the production adapter from Nexum's
 * {@link SystemOneClient} seam to the SDK's System One operation
 * (`POST /v1/systemone`).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Nexum's Decision Plane depends on the small Nexum-owned
 * {@link SystemOneClient} interface (declared in
 * `./system-one-gateway.js`), not on any SDK type. That keeps the Decision
 * Plane testable without the SDK, and lets the SDK evolve its wire shape
 * without forcing a Nexum-wide change.
 *
 * This adapter is the ONE place where the SDK's System One operation is
 * actually called, through the SDK's public `OllamaClient.systemOne`. That
 * method runs the SDK's cloud-model version gate (a `:cloud` model through a
 * local server needs Ollama 0.40.5+) before the request, and takes an
 * `AbortSignal` that covers both the gate and the wire request (SDK 1.21.0+).
 * Nexum therefore keeps no gate of its own for that floor.
 */

import type { OllamaClient, SystemOneRequest } from "@nemesis-oss/ollama-sdk";
import type { SystemOneClient } from "./system-one-gateway.js";

export class OllamaSystemOneClient implements SystemOneClient {
  private readonly client: OllamaClient;

  constructor(client: OllamaClient) {
    this.client = client;
  }

  systemOne(request: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> {
    // Pass the signal through only when present, so a call without one is the
    // same SDK call as before cancellation support.
    return this.client.systemOne(request as unknown as SystemOneRequest, opts?.signal ? { signal: opts.signal } : {});
  }
}
