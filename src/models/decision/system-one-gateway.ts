/**
 * SystemOneDecisionGateway — the concrete adapter from Nexum's
 * {@link DecisionRequest} domain contract to the tev1 /v1/systemone wire
 * protocol documented at https://ollama.com/library/tev1.
 *
 * ── tev1 wire shape ────────────────────────────────────────────────────────
 *
 * tev1 from Together AI is the actual published System One model on Ollama.
 * Its README documents the real wire format Nexum must speak. The previous
 * implementation guessed at a `decisions: Array<{questionId, selected}>`
 * shape that was materially different from what the server returns.
 *
 * Request (what Nexum sends to POST /v1/systemone):
 *
 *   {
 *     "model": "tev1" | "tev1:0.8b" | ...,
 *     "state": "<string, or JSON object/array>",
 *     "questions": {
 *       "<question_name>": {
 *         "type": "choice" | "noul" | "score",
 *         "instructions": "<string>",
 *         "criteria":
 *           // choice / noul-with-choices: object map {option_id: description|null}
 *           { "<option_id>": "<description>" | null, ... }
 *           // score: array of level descriptions, lowest level first
 *           | string[]
 *       },
 *       ...
 *     },
 *     "keep_alive": "<optional duration>"
 *   }
 *
 * Response (what the server returns):
 *
 *   {
 *     "answers": {
 *       "<question_name>": {
 *         // choice / noul-with-choices:
 *         "choice": "<selected_option_id>",
 *         "probabilities": { "<option_id>": <0..1>, ... },
 *         "confidence": <0..1>,
 *         // noul without choices:
 *         "noul": <0..1>,            // probability the answer is true
 *         // score:
 *         "score": <0..N>,           // probability-weighted level
 *         "legend": [...],
 *         "probabilities": [...],
 *         "confidence": <0..1>
 *       },
 *       ...
 *     },
 *     "model": "<string, optional>"
 *   }
 *
 * The tev1 `confidence` field is the CONCENTRATION of the probability
 * distribution, NOT the calibrated probability the answer is right. Nexum
 * preserves it on {@link DecisionAnswer.confidence} (and in
 * {@link DecisionAnswer.raw}) for telemetry; the policy layer uses
 * `probabilities` and `score` as evidence, never `confidence` as a
 * correctness signal.
 *
 * ── Nexum→tev1 mapping rules ───────────────────────────────────────────────
 *
 * Nexum keeps one `mode` per {@link DecisionRequest}; tev1 has per-question
 * `type`. The gateway maps the single request mode to every question's
 * `type` field. Callers that need per-question types must issue separate
 * `decide()` calls (one per question type).
 *
 * For `choice` mode: `criteria` is the object map `{ [choice.id]:
 * choice.description }`. If a choice description is empty, the wire value
 * is `null` (tev1's "let the option name describe itself"). NOTE: Nexum's
 * `validateDecisionQuestion` currently rejects empty descriptions, so the
 * `null` path is unreachable through the public Nexum contract; the code
 * handles it defensively for parity with the tev1 spec.
 *
 * For `noul` mode with `choices`: same object map PLUS a synthetic `"none":
 * "None of the listed options fit."` entry (per the README's "add a none
 * option when none of your listed options might fit"). A response with
 * `choice === "none"` maps to `answer.selected = undefined` (the "no
 * candidate fits" outcome), and the `probabilities.none` key is preserved.
 *
 * For `noul` mode without `choices`: no `criteria` field (tev1's true/false
 * gating). The response's `noul` number (0..1) maps to `answer.score`.
 *
 * For `score` mode: `criteria` is the array of choice descriptions (lowest
 * level first). The response's `score` (the probability-weighted level)
 * maps to `answer.score`; `legend` and array `probabilities` are preserved
 * verbatim in `answer.raw` (not coerced to a map).
 *
 * `request.keepAlive` (string) is forwarded verbatim as `keep_alive`; it is
 * omitted when the request does not set it.
 *
 * ── Adapter seam ───────────────────────────────────────────────────────────
 *
 * The upstream SDK (`@nemesis-oss/ollama-sdk@1.7.0+`) exposes the System One
 * operation through its public `./generated/api` subpath export, which ships
 * `NativeApi`, `systemOneOp` (re-exported as `systemOne`), and the
 * `OllamaRuntime` class. The SDK's public `OllamaClient.runtime` getter
 * returns the runtime that `NativeApi` would use internally.
 *
 * Nexum does NOT depend on `NativeApi.systemOne` directly because that method
 * does not accept an `AbortSignal`, and Nexum's Decision Plane contract
 * preserves the caller's signal end-to-end. Instead, the production adapter
 * ({@link OllamaSystemOneClient} in `./ollama-system-one-client.js`) calls
 * `OllamaClient.runtime.invoke({ operation: systemOneOp, body, signal })`
 * directly — using only SDK public surface — which gives us native abort
 * support. This gateway depends on the small Nexum-owned
 * {@link SystemOneClient} interface that mirrors the SDK's call shape, so
 * tests can inject a fake without the SDK.
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
 *                        tool/domain names; the synthetic "none" is the
 *                        only out-of-band id the gateway allows)
 */

import type { DecisionGateway } from "./decision-gateway.js";
import { DecisionError, DecisionProtocolError, DecisionTransportError, DecisionUnavailableError } from "./errors.js";
import type { DecisionAnswer, DecisionRequest, DecisionResult } from "./types.js";
import { validateDecisionRequest } from "./types.js";

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

// ── tev1 wire shape ────────────────────────────────────────────────────────
// The tev1 /v1/systemone request/response shapes, as documented at
// https://ollama.com/library/tev1. The gateway translates Nexum's
// DecisionRequest/DecisionResult domain types to/from these wire types.

interface WireRequest {
  model: string;
  state: string;
  questions: Record<string, WireQuestion>;
  keep_alive?: string;
}

interface WireQuestion {
  type: DecisionRequest["mode"];
  instructions: string;
  // For choice / noul-with-choices: object map { option_id: description | null }.
  // For score: array of level descriptions, lowest first.
  // For noul without choices: omitted (no criteria field).
  criteria?: Record<string, string | null> | string[];
}

interface WireAnswerEntry {
  // choice / noul-with-choices
  choice?: unknown;
  // noul without choices (probability the answer is true, 0..1)
  noul?: unknown;
  // score (the probability-weighted level, 0..N)
  score?: unknown;
  // probabilities: object map for choice/noul, array for score
  probabilities?: unknown;
  // legend: array of level descriptions, for score
  legend?: unknown;
  // confidence: probability concentration, 0..1 (NOT calibrated correctness)
  confidence?: unknown;
}

interface WireResponse {
  answers?: unknown;
  model?: unknown;
  meta?: unknown;
  [k: string]: unknown;
}

/** The synthetic "none" option the gateway appends to `noul` mode with choices. */
const SYNTHETIC_NONE_OPTION = "none";
const SYNTHETIC_NONE_DESCRIPTION = "None of the listed options fit.";

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

    // 4. Build the tev1 wire request and call the SDK seam. The signal is
    //    forwarded so the SDK honors cancellation; if it does not, the
    //    gateway still surfaces the abort as DecisionTransportError via
    //    the catch below.
    const wire = buildWireRequest(request);

    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.client.systemOne(wire as unknown as Record<string, unknown>, {
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (err) {
      throw mapSystemOneError(err);
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

function mapSystemOneError(err: unknown): Error {
  // Preserve any typed DecisionError raised inside the client seam — the
  // OllamaSystemOneClient adapter and any caller-injected test fake all
  // surface typed decision errors here, and we must NOT rewrap them as
  // generic transport failures. Only true transport-layer errors (network,
  // abort) get wrapped as DecisionTransportError.
  if (err instanceof DecisionError) return err;
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

/**
 * Build the tev1 wire request from the Nexum-domain {@link DecisionRequest}.
 *
 * Mapping (see the file header for the full spec table):
 *   - request.model  → wire.model
 *   - request.context → wire.state
 *   - request.questions (array) → wire.questions (object map keyed by q.id)
 *   - request.mode   → wire.questions[q.id].type (applied to ALL questions)
 *   - q.prompt       → wire.questions[q.id].instructions
 *   - q.choices      → wire.questions[q.id].criteria (shape depends on mode)
 *   - request.keepAlive → wire.keep_alive (verbatim, omitted when absent)
 *   - The top-level `mode` field is NOT on the wire (tev1 has per-question type).
 */
function buildWireRequest(request: DecisionRequest): WireRequest {
  const questions: Record<string, WireQuestion> = {};
  for (const q of request.questions) {
    const type = request.mode;
    const criteria = buildCriteria(q, type);
    questions[q.id] = {
      type,
      instructions: q.prompt,
      ...(criteria !== undefined ? { criteria } : {}),
    };
  }
  const wire: WireRequest = {
    model: request.model,
    state: request.context,
    questions,
  };
  if (request.keepAlive !== undefined) {
    wire.keep_alive = request.keepAlive;
  }
  return wire;
}

/**
 * Build the per-question `criteria` field for the tev1 wire request. Returns
 * `undefined` when the (mode, choices) combination does not emit a criteria
 * field — for `noul` mode without choices (tev1's true/false gating shape).
 */
function buildCriteria(
  q: DecisionRequest["questions"][number],
  mode: DecisionRequest["mode"],
): WireQuestion["criteria"] {
  if (mode === "noul" && !q.choices) {
    // noul without choices: true/false gating. tev1 emits no `criteria` field.
    return undefined;
  }
  if (!q.choices) {
    // score mode without choices: the model emits a scalar per question
    // with no predefined alternatives — no `criteria` field. (For choice /
    // noul-with-choices, `validateDecisionRequest` already rejected the
    // missing-choices case before this point, so reaching here with no
    // choices is only possible for `score` mode.)
    return undefined;
  }
  if (mode === "score") {
    // score: array of level descriptions, lowest level first. The caller is
    // responsible for ordering choices by level (the gateway does not
    // reorder).
    return q.choices.map((c) => c.description);
  }
  // choice, or noul with choices: object map { [choice.id]: description | null }.
  // Empty descriptions map to `null` (tev1's "let the option name describe
  // itself"). NOTE: `validateDecisionQuestion` currently rejects empty
  // descriptions, so the `null` path is unreachable through the public Nexum
  // contract; we keep the defensive mapping for parity with the tev1 spec.
  const map: Record<string, string | null> = {};
  for (const c of q.choices) {
    map[c.id] = c.description.length > 0 ? c.description : null;
  }
  if (mode === "noul") {
    // Append the synthetic "none" option so the model can legitimately
    // answer "none of the listed options fit". A response with
    // `choice === "none"` maps to `answer.selected = undefined` (the
    // no-candidate-fits outcome), and the `probabilities.none` key is
    // preserved verbatim.
    map[SYNTHETIC_NONE_OPTION] = SYNTHETIC_NONE_DESCRIPTION;
  }
  return map;
}

/**
 * Parse the tev1 wire response into the Nexum-domain DecisionAnswer[],
 * with protocol-level validation of every `choice` id against the
 * request's declared choices.
 *
 * Mapping (see the file header for the full spec table):
 *   - res.answers (object map) → array of DecisionAnswer keyed by questionId
 *   - entry.choice  → answer.selected (choice / noul-with-choices); "none"
 *                    → answer.selected = undefined
 *   - entry.noul    → answer.score (noul without choices; probability the
 *                    answer is true, 0..1)
 *   - entry.score   → answer.score (score mode; the probability-weighted level)
 *   - entry.probabilities (object map) → answer.probabilities for choice/noul
 *                    (drop keys not in declared choices, preserve "none")
 *   - entry.probabilities (array) → preserved verbatim in answer.raw for score
 *                    (do NOT coerce to a map — tev1's score `probabilities`
 *                    is indexed by level)
 *   - entry.confidence → answer.confidence (probability concentration, NOT
 *                    calibrated correctness) and preserved in answer.raw
 *   - entry.legend  → preserved verbatim in answer.raw for score
 *   - res.model (string, if present) → result.model
 */
function parseWireResponse(raw: unknown, request: DecisionRequest): { model?: string; answers: DecisionAnswer[] } {
  if (!raw || typeof raw !== "object") {
    throw new DecisionProtocolError("System One response is not an object");
  }
  const res = raw as WireResponse;

  const modelField = typeof res.model === "string" ? res.model : undefined;

  const answersRaw = res.answers;
  if (answersRaw === undefined || answersRaw === null) {
    throw new DecisionProtocolError("System One response missing `answers` object");
  }
  if (typeof answersRaw !== "object" || Array.isArray(answersRaw)) {
    throw new DecisionProtocolError("System One `answers` is not an object");
  }
  const answersMap = answersRaw as Record<string, unknown>;

  // Index the request's questions by id for O(1) lookup during validation.
  const requestQuestions = new Map(request.questions.map((q) => [q.id, q]));
  const requestQuestionIds = new Set(request.questions.map((q) => q.id));

  const answers: DecisionAnswer[] = [];
  const answeredQuestionIds = new Set<string>();

  for (const [name, entry] of Object.entries(answersMap)) {
    if (!requestQuestionIds.has(name)) {
      throw new DecisionProtocolError(`System One returned an answer for unknown question "${name}"`);
    }
    if (answeredQuestionIds.has(name)) {
      // Structurally impossible in a Record<string, unknown> (object keys
      // are unique after JSON parsing — duplicates overwrite), but the
      // defensive check keeps parity with the old array-based wire shape's
      // duplicate-questionId contract.
      throw new DecisionProtocolError(`System One returned a duplicate answer for question "${name}"`);
    }
    answeredQuestionIds.add(name);

    if (!entry || typeof entry !== "object") {
      throw new DecisionProtocolError(`System One answer for "${name}" is not an object`);
    }
    const e = entry as WireAnswerEntry;
    const q = requestQuestions.get(name)!;
    const mode = request.mode;

    answers.push(parseAnswerEntry(name, e, q, mode));
  }

  // Every requested question must be answered.
  for (const q of request.questions) {
    if (!answeredQuestionIds.has(q.id)) {
      throw new DecisionProtocolError(`System One response is missing an answer for question "${q.id}"`);
    }
  }

  return { model: modelField, answers };
}

/**
 * Parse a single tev1 `answers[name]` entry into a {@link DecisionAnswer},
 * branching on the request mode and whether the question declared choices.
 */
function parseAnswerEntry(
  name: string,
  e: WireAnswerEntry,
  q: DecisionRequest["questions"][number],
  mode: DecisionRequest["mode"],
): DecisionAnswer {
  // `raw` preserves the original wire entry verbatim for telemetry/replay.
  const answer: DecisionAnswer = { questionId: name, raw: e };

  // Confidence is on every entry shape (choice/noul/score). Preserve it as
  // a top-level field AND in `raw` (which we already did via the assignment
  // above). Treat invalid confidence as "absent" rather than a protocol
  // violation — confidence is evidence of concentration, not a structural
  // field the contract depends on.
  if (typeof e.confidence === "number" && Number.isFinite(e.confidence)) {
    answer.confidence = e.confidence;
  }

  if (mode === "noul" && !q.choices) {
    // noul without choices: true/false gating. `noul` is the probability the
    // answer is true (0..1). Map to `answer.score` so callers reading the
    // scalar compare it to their own threshold — applyDecisionPolicy uses
    // `probabilities` for choice/noul-with-choices and ignores `score`;
    // the caller is responsible for the score threshold (per the policy
    // module's existing JSDoc on `minimumProbability`).
    if (e.noul === undefined || e.noul === null) {
      throw new DecisionProtocolError(`System One answer for "${name}" is missing the \`noul\` probability`);
    }
    if (typeof e.noul !== "number" || !Number.isFinite(e.noul)) {
      throw new DecisionProtocolError(`System One \`noul\` for "${name}" is not a finite number`);
    }
    answer.score = e.noul;
    return answer;
  }

  if (mode === "score") {
    // score: a numeric level (0..N). Map to `answer.score`. Legend and array
    // `probabilities` are preserved verbatim in `answer.raw` (set above) —
    // we do NOT coerce the array to a map because tev1's score
    // `probabilities` is indexed by level, not by option_id.
    if (e.score === undefined || e.score === null) {
      throw new DecisionProtocolError(`System One answer for "${name}" is missing the \`score\` field`);
    }
    if (typeof e.score !== "number" || !Number.isFinite(e.score)) {
      throw new DecisionProtocolError(`System One \`score\` for "${name}" is not a finite number`);
    }
    answer.score = e.score;
    return answer;
  }

  // choice, or noul with choices — both use `choice` + `probabilities`.
  if (e.choice === undefined || e.choice === null) {
    throw new DecisionProtocolError(`System One answer for "${name}" is missing the \`choice\` field`);
  }
  if (typeof e.choice !== "string") {
    throw new DecisionProtocolError(`System One \`choice\` for "${name}" is not a string`);
  }
  const choice = e.choice;
  // The choice must appear in the question's declared choices OR be the
  // synthetic "none" (only valid for noul mode, where we appended it). An
  // out-of-band choice id is a protocol violation — System One cannot
  // invent tool/domain names.
  const isNone = choice === SYNTHETIC_NONE_OPTION;
  const isInChoices = q.choices?.some((c) => c.id === choice) ?? false;
  if (!isInChoices && !(isNone && mode === "noul")) {
    throw new DecisionProtocolError(`System One selected "${choice}" is not a choice for question "${name}"`);
  }
  // Map the synthetic "none" → selected: undefined (the "no candidate fits"
  // outcome). A normal choice maps to its id.
  if (!isNone) {
    answer.selected = choice;
  }

  // Probabilities: object map { option_id: 0..1 }. Drop keys not in the
  // declared choices; preserve the synthetic "none" key when present (the
  // caller may want to see the model's "no candidate fits" mass).
  if (e.probabilities !== undefined && e.probabilities !== null) {
    if (typeof e.probabilities !== "object" || Array.isArray(e.probabilities)) {
      throw new DecisionProtocolError(`System One \`probabilities\` for "${name}" is not an object`);
    }
    const probs = e.probabilities as Record<string, unknown>;
    const validIds = new Set<string>(q.choices?.map((c) => c.id) ?? []);
    if (mode === "noul") {
      validIds.add(SYNTHETIC_NONE_OPTION);
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(probs)) {
      if (!validIds.has(k)) {
        // Unknown probability keys are dropped, not fatal — the model
        // surfacing an extra label is a softer contract violation than
        // inventing a selected id, and the probabilities map already
        // preserves the evidence the caller's policy needs.
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new DecisionProtocolError(
          `System One probability for "${k}" on question "${name}" is not a finite number`,
        );
      }
      out[k] = v;
    }
    if (Object.keys(out).length > 0) {
      answer.probabilities = out;
    }
  }

  return answer;
}

// The wire request/response types are exported as part of the SDK adapter
// seam so a future `OllamaClient.systemOne` adapter can be verified against
// the same shape.
export type { WireRequest, WireResponse, WireQuestion, WireAnswerEntry };
