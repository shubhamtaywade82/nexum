/**
 * WebhookService — verified external event ingress.
 *
 * Nexum has an internal EventBus but no formal external-event ingress.
 * DeepSeek Harness has a dedicated webhook capability family for:
 *
 *   verified external events → trusted rules → workspace session
 *
 * This is highly relevant to the autonomous crypto agent direction:
 *
 *   Binance WebSocket
 *         │
 *         ▼
 *   Event Gateway
 *         │
 *         ├── liquidation
 *         ├── price threshold
 *         ├── funding rate
 *         ├── OI change
 *         └── market event
 *                │
 *                ▼
 *           Agent Session
 *
 * The WebhookService:
 *   - registers webhook endpoints (each with a secret for HMAC verification)
 *   - verifies incoming requests (signature, timestamp window)
 *   - applies trusted rules (filter / transform / route)
 *   - emits verified events to the internal EventBus
 *   - persists event log for replay / audit
 *
 * This service is the trust boundary between external systems and the
 * agent runtime. Unverified events NEVER reach agent sessions.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ── Contracts ───────────────────────────────────────────────────────────────

export type WebhookId = string;

export interface WebhookEndpoint {
  id: WebhookId;
  /** URL path (e.g. "/webhooks/binance"). */
  path: string;
  /** Human-facing description. */
  description?: string;
  /** Shared secret for HMAC verification. */
  secret: string;
  /** Header name containing the signature (default "X-Webhook-Signature"). */
  signatureHeader?: string;
  /** Header name containing the timestamp (default "X-Webhook-Timestamp"). */
  timestampHeader?: string;
  /** Max age of a valid request in seconds (default 300 = 5 min). */
  maxAgeSeconds?: number;
  /** Which event types this endpoint accepts (empty = all). */
  acceptedEventTypes?: string[];
  /** Whether the endpoint is active. */
  active: boolean;
  /** Tags for filtering. */
  tags?: string[];
  /** Created timestamp. */
  createdAt: string;
}

export interface WebhookEvent {
  id: string;
  endpointId: WebhookId;
  /** Event type (e.g. "binance.liquidation", "github.push"). */
  type: string;
  /** Verified payload (parsed JSON, or raw string). */
  payload: unknown;
  /** Headers (sanitized — secrets stripped). */
  headers: Record<string, string>;
  /** When the event was received. */
  receivedAt: string;
  /** Whether the event passed verification. */
  verified: boolean;
  /** Verification failure reason (if !verified). */
  verificationError?: string;
  /** Whether the event was delivered to a handler. */
  delivered: boolean;
}

export interface WebhookRule {
  id: string;
  /** Which endpoint this rule applies to (empty = all). */
  endpointId?: WebhookId;
  /** Event type filter (regex). */
  typePattern?: string;
  /** Condition (evaluated against the payload). */
  condition?: (payload: unknown) => boolean;
  /** Transform (mutates the event before delivery). */
  transform?: (event: WebhookEvent) => WebhookEvent;
  /** Handler (receives the verified event). */
  handle: (event: WebhookEvent) => void | Promise<void>;
}

export interface WebhookServiceOptions {
  /** Root directory for persistence (e.g. workspaceRoot/.nexum). */
  rootDir?: string;
  /** Disable fs writes (in-memory). */
  inMemory?: boolean;
}

// ── WebhookService ──────────────────────────────────────────────────────────

export class WebhookService {
  private readonly endpoints = new Map<WebhookId, WebhookEndpoint>();
  private readonly rules: WebhookRule[] = [];
  private readonly events: WebhookEvent[] = [];
  private readonly eventsLogFile?: string;
  private readonly inMemory: boolean;

  constructor(opts: WebhookServiceOptions = {}) {
    this.inMemory = opts.inMemory ?? false;
    if (opts.rootDir && !this.inMemory) {
      const dir = join(opts.rootDir, "webhooks");
      mkdirSync(dir, { recursive: true });
      this.eventsLogFile = join(dir, "events.jsonl");
    }
  }

  /** Register a webhook endpoint. */
  registerEndpoint(endpoint: Omit<WebhookEndpoint, "createdAt">): WebhookEndpoint {
    if (this.endpoints.has(endpoint.id)) {
      throw new Error(`webhook endpoint "${endpoint.id}" already registered`);
    }
    const full: WebhookEndpoint = { ...endpoint, createdAt: new Date().toISOString() };
    this.endpoints.set(endpoint.id, full);
    return full;
  }

  /** Unregister an endpoint. */
  unregisterEndpoint(id: WebhookId): boolean {
    return this.endpoints.delete(id);
  }

  /** List registered endpoints. */
  listEndpoints(): WebhookEndpoint[] {
    return [...this.endpoints.values()];
  }

  /** Get an endpoint by id. */
  getEndpoint(id: WebhookId): WebhookEndpoint | undefined {
    return this.endpoints.get(id);
  }

  /** Find an endpoint by URL path. */
  endpointByPath(path: string): WebhookEndpoint | undefined {
    return [...this.endpoints.values()].find((e) => e.path === path && e.active);
  }

  /** Add a rule (filter/transform/handler). */
  addRule(rule: WebhookRule): this {
    this.rules.push(rule);
    return this;
  }

  /**
   * Receive an incoming webhook request.
   * Verifies signature + timestamp, then applies rules.
   * Returns the recorded event (verified or not).
   */
  async receive(input: {
    endpointId: WebhookId;
    type: string;
    payload: unknown;
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<WebhookEvent> {
    const endpoint = this.endpoints.get(input.endpointId);
    if (!endpoint) {
      return this.recordEvent({
        endpointId: input.endpointId,
        type: input.type,
        payload: input.payload,
        headers: input.headers,
        verified: false,
        verificationError: `unknown endpoint "${input.endpointId}"`,
        delivered: false,
      });
    }

    if (!endpoint.active) {
      return this.recordEvent({
        endpointId: input.endpointId,
        type: input.type,
        payload: input.payload,
        headers: input.headers,
        verified: false,
        verificationError: "endpoint inactive",
        delivered: false,
      });
    }

    // Verify signature.
    const sigHeader = endpoint.signatureHeader ?? "X-Webhook-Signature";
    const tsHeader = endpoint.timestampHeader ?? "X-Webhook-Timestamp";
    const providedSig = input.headers[sigHeader] ?? input.headers[sigHeader.toLowerCase()];
    const providedTs = input.headers[tsHeader] ?? input.headers[tsHeader.toLowerCase()];

    const verification = verifyRequest({
      secret: endpoint.secret,
      rawBody: input.rawBody,
      providedSig,
      providedTs,
      maxAgeSeconds: endpoint.maxAgeSeconds ?? 300,
    });

    if (!verification.ok) {
      return this.recordEvent({
        endpointId: input.endpointId,
        type: input.type,
        payload: input.payload,
        headers: sanitizeHeaders(input.headers),
        verified: false,
        verificationError: verification.error,
        delivered: false,
      });
    }

    // Event type filter.
    if (endpoint.acceptedEventTypes && endpoint.acceptedEventTypes.length > 0) {
      if (!endpoint.acceptedEventTypes.includes(input.type)) {
        return this.recordEvent({
          endpointId: input.endpointId,
          type: input.type,
          payload: input.payload,
          headers: sanitizeHeaders(input.headers),
          verified: true,
          delivered: false,
          verificationError: `event type "${input.type}" not accepted`,
        });
      }
    }

    // Verified — apply rules.
    const event: WebhookEvent = {
      id: `wh_${randomId()}`,
      endpointId: input.endpointId,
      type: input.type,
      payload: input.payload,
      headers: sanitizeHeaders(input.headers),
      receivedAt: new Date().toISOString(),
      verified: true,
      delivered: false,
    };

    let transformed = event;
    let handled = false;
    for (const rule of this.rules) {
      if (rule.endpointId && rule.endpointId !== input.endpointId) continue;
      if (rule.typePattern) {
        const re = new RegExp(rule.typePattern);
        if (!re.test(event.type)) continue;
      }
      if (rule.condition && !rule.condition(event.payload)) continue;
      if (rule.transform) {
        transformed = rule.transform(transformed);
      }
      if (rule.handle) {
        try {
          await rule.handle(transformed);
          handled = true;
        } catch {
          // rule handler failed — continue with next rule
        }
      }
    }

    transformed.delivered = handled;
    // Use recordEvent to persist (it won't re-add id/receivedAt since they're already set).
    this.events.push(transformed);
    if (this.eventsLogFile) {
      try {
        appendFileSync(this.eventsLogFile, `${JSON.stringify(transformed)}\n`, "utf8");
      } catch {
        // best-effort
      }
    }
    return transformed;
  }

  /** List received events (optionally filtered). */
  listEvents(filter?: { endpointId?: WebhookId; verified?: boolean; type?: string }): WebhookEvent[] {
    let events = [...this.events];
    if (filter?.endpointId) events = events.filter((e) => e.endpointId === filter.endpointId);
    if (filter?.verified !== undefined) events = events.filter((e) => e.verified === filter.verified);
    if (filter?.type) events = events.filter((e) => e.type === filter.type);
    return events.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  /** Count events by verification status (for diagnostics). */
  counts(): { verified: number; unverified: number; delivered: number; total: number } {
    let verified = 0;
    let delivered = 0;
    for (const e of this.events) {
      if (e.verified) verified++;
      if (e.delivered) delivered++;
    }
    return { verified, unverified: this.events.length - verified, delivered, total: this.events.length };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private recordEvent(partial: Omit<WebhookEvent, "id" | "receivedAt">): WebhookEvent {
    const event: WebhookEvent = {
      ...partial,
      id: `wh_${randomId()}`,
      receivedAt: new Date().toISOString(),
    };
    this.events.push(event);
    // Persist to JSONL log (append-only).
    if (this.eventsLogFile) {
      try {
        appendFileSync(this.eventsLogFile, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        // best-effort
      }
    }
    return event;
  }
}

// ── Verification ────────────────────────────────────────────────────────────

interface VerificationResult {
  ok: boolean;
  error?: string;
}

function verifyRequest(input: {
  secret: string;
  rawBody: string;
  providedSig?: string;
  providedTs?: string;
  maxAgeSeconds: number;
}): VerificationResult {
  if (!input.providedSig) {
    return { ok: false, error: "missing signature header" };
  }
  if (!input.providedTs) {
    return { ok: false, error: "missing timestamp header" };
  }

  // Check timestamp freshness.
  const ts = Number(input.providedTs);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "invalid timestamp" };
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > input.maxAgeSeconds) {
    return { ok: false, error: `timestamp too old (${ageSeconds}s > ${input.maxAgeSeconds}s)` };
  }

  // Compute expected signature: HMAC-SHA256(secret, `${ts}.${rawBody}`).
  const expected = createHmac("sha256", input.secret).update(`${input.providedTs}.${input.rawBody}`).digest("hex");

  // Timing-safe compare.
  try {
    const a = Buffer.from(input.providedSig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return { ok: false, error: "signature length mismatch" };
    }
    if (!timingSafeEqual(a, b)) {
      return { ok: false, error: "signature mismatch" };
    }
  } catch {
    return { ok: false, error: "signature comparison failed" };
  }

  return { ok: true };
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.includes("secret") || lower.includes("signature") || lower.includes("authorization")) {
      sanitized[key] = "***REDACTED***";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function randomId(): string {
  // Avoid importing randomUUID for browser compat (though this is Node-only).
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Keep imports used (for side-effect typing).
void existsSync;
void readFileSync;
void writeFileSync;
void renameSync;
