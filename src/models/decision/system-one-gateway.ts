/**
 * SystemOneDecisionGateway — the concrete adapter from Nexum's
 * {@link DecisionRequest} domain contract to the upstream SDK's System One
 * wire protocol (`POST /v1/systemone`).
 *
 * ── Adapter seam ───────────────────────────────────────────────────────────
 *
 * The upstream SDK (`@nemesis-oss/ollama-sdk`) PR #26 currently exposes
 * System One only through generated internals:
 *
 *   - `NativeApi.systemOne(request: Record<string, unknown>): Promise<unknown>`
 *     in `src/generated/api/native-api.ts`
 *   - `systemOneOp` OperationDefinition in `src/generated/api/operations.ts`
 *
 * These are NOT re-exported from the SDK's public entrypoint
 * (`src/index.ts`). Per the integration contract, Nexum does NOT deep-import
 * generated internals. Instead, this gateway depends on a small Nexum-owned
 * {@link SystemOneClient} interface that mirrors the SDK's `systemOne`
 * method shape. A one-line adapter will wire the real SDK call here once the
 * upstream export lands (see the module README and the final report's
 * "Upstream export gap" section).
 *
 * ── Failure model ──────────────────────────────────────────────────────────
 *
 * The gateway surfaces every failure as a typed {@link DecisionError}
 * subclass. It NEVER falls back to `Provider.chat()` — System One is not a
 * chat model, and converting a decision failure into a chat turn would
 * destroy the bounded-decision guarantee. The caller's policy owns the
 * deterministic fallback.
 *
 *   cloud tier          → DecisionUnavailableError (local-only contract)
 *   version < 0.35.0    → DecisionUnavailableError
 *   oversized request   → DecisionProtocolError (caught client-side pre-send)
 *   network/abort       → DecisionTransportError
 *   malformed response  → DecisionProtocolError
 *   out-of-band id      → DecisionProtocolError (System One cannot invent
 *                        tool/domain names)
 */

import type { DecisionGateway } from "./decision-gateway.js";
import { DecisionProtocolError, DecisionTransportError, DecisionUnavailableError } from "./errors.js";
import { DecisionAnswer, DecisionRequest, DecisionResult, validateDecisionRequest } from "./types.js";

/**
 * Nexum-owned seam for the upstream System One call. Mirrors the SDK's
 * generated `NativeApi.systemOne` signature. The production implementation
 * is a thin one-line adapter over `OllamaClient.systemOne(...)` once the SDK
 * re-exports it.
 */
export interface SystemOneClient {
  systemOne(request: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * What the gateway needs to know about its environment to enforce the
 * System One contract. The cloud tier is unsupported by System One —
 * {@link tier} is the only field the gateway uses to refuse.
 */
export interface SystemOneEnvironment {
  readonly tier: "local" | "cloud";
  /** Returns the local Ollama server's version, or undefined if unknown. */
  getVersion(): Promise<string | undefined>;
}

export interface SystemOneGatewayOptions {
  client: SystemOneClient;
  environment: SystemOneEnvironment;
  /**
   * Minimum Ollama version that supports `/v1/systemone` (per
   * `contracts/overlays/systemone.yaml` in the upstream SDK). Default
   * `"0.35.0"`. The gateway refuses to send the request if the version is
   * known and below this value; an unknown version is allowed (the server
   * will reject if it genuinely does not support the endpoint).
   */
  minVersion?: string;
}

const DEFAULT_MIN_VERSION = "0.35.0";

/** Engine label exposed via the {@link DecisionGateway.engine} field. */
export const SYSTEM_ONE_ENGINE = "system-one";

// ── Wire shape (best-effort, deliberately permissive) ───────────────────────
// The exact System One request/response wire shape is not finalized in the
// SDK at this writing. The fields below are the minimum Nexum sends and the
// minimum it parses; any unknown fields are preserved verbatim on the raw
// payload of {@link DecisionAnswer} so callers can replay/audit decisions.

interface WireRequest {
  model: string;
  mode: DecisionRequest["mode"];
  context: string;
  questions: Array<{
    id: string;
    prompt: string;
    choices?: Array<{ id: string; description: string }>;
  }>;
}

interface WireDecisionEntry {
  questionId?: unknown;
  selected?: unknown;
  score?: unknown;
  probabilities?: unknown;
}

interface WireResponse {
  decisions?: unknown;
  model?: unknown;
  meta?: unknown;
  [k: string]: unknown;
}

export class SystemOneDecisionGateway implements DecisionGateway {
  readonly engine = SYSTEM_ONE_ENGINE;
  private readonly client: SystemOneClient;
  private readonly environment: SystemOneEnvironment;
  private readonly minVersion: string;

  constructor(opts: SystemOneGatewayOptions) {
    if (!opts || !opts.client || !opts.environment) {
      throw new DecisionUnavailableError("SystemOneDecisionGateway requires client and environment");
    }
    this.client = opts.client;
    this.environment = opts.environment;
    this.minVersion = opts.minVersion ?? DEFAULT_MIN_VERSION;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    // 1. Validate the Nexum-domain request first. This throws
    //    DecisionProtocolError for any contract violation, including the
    //    64 KiB size limit, BEFORE we touch the network.
    validateDecisionRequest(request);

    // 2. Enforce the local-only contract. System One is documented as
    //    `local: supported, cloud: unsupported` in `systemone.yaml`. The
    //    gateway refuses a cloud tier eagerly — it must never silently
    //    route the decision to Ollama Cloud's chat endpoint.
    if (this.environment.tier === "cloud") {
      throw new DecisionUnavailableError("System One is local-only and is not supported in a cloud-tier configuration");
    }

    // 3. Enforce the Ollama version requirement when known. An unknown
    //    version is permitted so that a local Ollama whose version probe
    //    failed (e.g. wrong host) does not produce a misleading
    //    "version too old" message — the real transport/protocol error is
    //    more informative.
    const version = await this.environment.getVersion();
    if (version !== undefined && compareVersions(version, this.minVersion) < 0) {
      throw new DecisionUnavailableError(
        `System One requires Ollama ${this.minVersion}+; local server reports ${version}`,
      );
    }

    // 4. Build the wire request and call the SDK seam. The signal is
    //    forwarded so the SDK (when wired) honors cancellation; if it does
    //    not, the gateway still surfaces the abort as DecisionTransportError
    //    via the catch below.
    const wire: WireRequest = {
      model: request.model,
      mode: request.mode,
      context: request.context,
      questions: request.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        ...(q.choices ? { choices: q.choices } : {}),
      })),
    };

    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.client.systemOne(wire as unknown as Record<string, unknown>, {
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (err) {
      throw toTransportError(err);
    }
    const latencyMs = Math.max(0, Date.now() - started);

    // 5. Parse the response into the Nexum-domain DecisionResult, with
    //    protocol-level validation of every selected id against the
    //    request's declared choices.
    const parsed = parseWireResponse(raw, request);
    return {
      id: request.id ?? `decision-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      model: parsed.model ?? request.model,
      mode: request.mode,
      decisions: parsed.answers,
      latencyMs,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function toTransportError(err: unknown): DecisionTransportError {
  if (err instanceof DecisionTransportError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DecisionTransportError(`System One transport failure: ${message}`, err);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function parseWireResponse(raw: unknown, request: DecisionRequest): { model?: string; answers: DecisionAnswer[] } {
  if (!raw || typeof raw !== "object") {
    throw new DecisionProtocolError("System One response is not an object");
  }
  const res = raw as WireResponse;

  const modelField = typeof res.model === "string" ? res.model : undefined;

  const decisionsRaw = res.decisions;
  if (!Array.isArray(decisionsRaw)) {
    throw new DecisionProtocolError("System One response missing `decisions` array");
  }

  // Index the request's questions by id for O(1) lookup during validation.
  const requestQuestions = new Map(request.questions.map((q) => [q.id, q]));
  const requestQuestionIds = new Set(request.questions.map((q) => q.id));

  const answers: DecisionAnswer[] = [];
  const answeredQuestionIds = new Set<string>();

  for (let i = 0; i < decisionsRaw.length; i++) {
    const entry = decisionsRaw[i] as WireDecisionEntry;
    if (!entry || typeof entry !== "object") {
      throw new DecisionProtocolError(`System One decision at index ${i} is not an object`);
    }
    const questionId = entry.questionId;
    if (typeof questionId !== "string" || !requestQuestionIds.has(questionId)) {
      throw new DecisionProtocolError(`System One returned a decision for unknown question id "${String(questionId)}"`);
    }
    if (answeredQuestionIds.has(questionId)) {
      throw new DecisionProtocolError(`System One returned a duplicate decision for question "${questionId}"`);
    }
    answeredQuestionIds.add(questionId);

    const q = requestQuestions.get(questionId)!;

    // Selected id must appear in the request's choices when choices are
    // declared — System One must not invent tool/domain names. A `null`
    // selected is allowed for `noul` mode (the model's "none of the above").
    let selected: string | undefined;
    if (entry.selected !== undefined && entry.selected !== null) {
      if (typeof entry.selected !== "string") {
        throw new DecisionProtocolError(`System One selected id for "${questionId}" is not a string`);
      }
      selected = entry.selected;
      if (q.choices && !q.choices.some((c) => c.id === selected)) {
        throw new DecisionProtocolError(
          `System One selected "${selected}" is not a choice for question "${questionId}"`,
        );
      }
    }

    // Score must be a finite number when present.
    let score: number | undefined;
    if (entry.score !== undefined && entry.score !== null) {
      if (typeof entry.score !== "number" || !Number.isFinite(entry.score)) {
        throw new DecisionProtocolError(`System One score for "${questionId}" is not a finite number`);
      }
      score = entry.score;
    }

    // Probabilities: per-choice mass. Keys must match declared choice ids
    // and values must be finite numbers.
    let probabilities: Record<string, number> | undefined;
    if (entry.probabilities !== undefined && entry.probabilities !== null) {
      if (typeof entry.probabilities !== "object") {
        throw new DecisionProtocolError(`System One probabilities for "${questionId}" is not an object`);
      }
      const obj = entry.probabilities as Record<string, unknown>;
      probabilities = {};
      for (const [key, value] of Object.entries(obj)) {
        if (q.choices && !q.choices.some((c) => c.id === key)) {
          // Unknown probability keys are dropped, not fatal — the model
          // surfacing an extra label is a softer contract violation than
          // inventing a selected id, and the probabilities map already
          // preserves the evidence the caller's policy needs.
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new DecisionProtocolError(
            `System One probability for "${key}" on question "${questionId}" is not a finite number`,
          );
        }
        probabilities[key] = value;
      }
      if (Object.keys(probabilities).length === 0) probabilities = undefined;
    }

    answers.push({
      questionId,
      ...(selected !== undefined ? { selected } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(probabilities !== undefined ? { probabilities } : {}),
      // Preserve the raw entry for replay/debugging. We intentionally
      // keep the original object (not a copy) so callers see exactly what
      // the SDK returned; the gateway has already validated its shape.
      raw: entry,
    });
  }

  // Every requested question must be answered.
  for (const q of request.questions) {
    if (!answeredQuestionIds.has(q.id)) {
      throw new DecisionProtocolError(`System One response is missing a decision for question "${q.id}"`);
    }
  }

  return { model: modelField, answers };
}

// The wire request/response types are exported as part of the SDK adapter
// seam so a future `OllamaClient.systemOne` adapter can be verified against
// the same shape.
export type { WireRequest, WireResponse, WireDecisionEntry };
