/**
 * OllamaSystemOneClient — the production adapter from Nexum's
 * {@link SystemOneClient} seam to the real `@nemesis-oss/ollama-sdk` System One
 * operation (`POST /v1/systemone`).
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
 * actually called. It depends exclusively on the SDK's PUBLIC surface:
 *
 *   - `OllamaClient.runtime` (public getter on the SDK's main client class)
 *   - `systemOneOp` (re-exported as `systemOne` from the SDK's
 *     `./generated/api` subpath, which `@nemesis-oss/ollama-sdk@1.7.0+`
 *     declares as a supported public entrypoint in its `exports` map)
 *   - `OllamaRuntime.invoke` (public method that the SDK's `NativeApi`
 *     classes delegate to)
 *
 * It does NOT deep-import any `dist/` path that is not declared in the
 * SDK's `exports` map.
 *
 * ── Implementation choice ──────────────────────────────────────────────────
 *
 * The SDK ships `NativeApi.systemOne(request): Promise<unknown>`, but that
 * method does not accept an `AbortSignal`. The `OllamaRuntime.invoke` method
 * underneath it does accept one. We call `runtime.invoke` directly with the
 * SDK's exported `systemOneOp` constant so callers can cancel a decision
 * request natively — no external `Promise.race` abort hack that would leak a
 * pending HTTP request.
 *
 * The "regression guard" test in
 * `tests/models/decision/ollama-system-one-client.test.ts` verifies that the
 * `operation` we pass is the same constant the SDK's `NativeApi.systemOne`
 * would have passed — i.e. we are not silently forking the contract.
 */

import { systemOne as systemOneOperation } from "@nemesis-oss/ollama-sdk/generated/api";
import type { OllamaClient } from "@nemesis-oss/ollama-sdk";
import type { SystemOneClient } from "./system-one-gateway.js";

export class OllamaSystemOneClient implements SystemOneClient {
  private readonly client: OllamaClient;

  constructor(client: OllamaClient) {
    this.client = client;
  }

  systemOne(request: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> {
    // Pass the signal straight through to `runtime.invoke`. When no signal is
    // provided we omit the field entirely so the wire shape matches what the
    // SDK's `NativeApi.systemOne` would have produced (regression-guarded).
    const invokeReq = opts?.signal
      ? { operation: systemOneOperation, body: request, signal: opts.signal }
      : { operation: systemOneOperation, body: request };
    return this.client.runtime.invoke<unknown>(invokeReq);
  }
}
