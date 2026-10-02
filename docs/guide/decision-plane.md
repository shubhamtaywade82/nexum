# Decision Plane (System One)

Nexum has two model planes that stay strictly separated:

```
Nexum Model Plane
      │
   ┌──┴───┐
   │      │
Generation   Decision
   │      │
Provider/   DecisionGateway
Gateway     │
            SystemOneDecisionGateway
            │
            SystemOneClient (SDK seam)
```

The **Generation Plane** is what most of Nexum already uses: `Provider.chat()`, `Router`, `ModelStack`, `LocalWorker`, `Verifier`, `CriticService`, `SelfCorrectionLoop`. It produces prose, code, tool-call arguments — open-ended generation.

The **Decision Plane** is a **bounded decision engine**. It does not generate prose. It answers small, explicitly-bounded questions like "which of these 12 domains best matches this prompt?", "is this draft acceptable as-is or does it need critique?", "should this run on the local or cloud tier?".

This document describes what the Decision Plane is, how it is wired, and how to use and disable it. Code lives under `src/models/decision/`.

---

## What System One is

System One is Ollama's bounded-decision endpoint, exposed at `POST /v1/systemone` by the upstream SDK contract. Per the SDK's `contracts/overlays/systemone.yaml`:

- **local-only** — `tier: local` is supported, `tier: cloud` is not
- **non-streaming** — single request, single response
- **experimental** — the wire shape may still change
- **Ollama >= 0.35.0** required
- **64 KiB request-size limit** (server-enforced)
- **no tools, no images, no generation controls** — bounded decisions only

Nexum does not treat System One as another `Provider.chat()` model. It is not added as a `Capability.SystemOne` chat routing path, and it is never used as the primary generative agent model. System One produces **evidence** (probabilities, scores, selected ids); **Nexum policy** converts that evidence into an operational decision.

---

## Why a separate plane

A small model emitting free-form tool names hallucinates: `"super_search_repo"`, `"magic_patch"`, `"run_everything"` all happen. Asking it to pick from a bounded set eliminates the hallucination surface. The same pattern applies to every other decision Nexum needs a small model for:

- **Tool selection** — pick a domain (`filesystem`, `shell`, `git`, ...), not a tool name
- **Routing** — pick a tier (`local` | `cloud`), not a model id
- **Verification gate** — pick `accept` | `escalate`, not a verdict
- **Task complexity / single-vs-multi-step / groundedness / risk** — pick from a fixed list, never invent

Keeping the Decision Plane separate from the Generation Plane means:

- A System One failure never silently falls back to `Provider.chat()`
- A cloud-tier configuration never accidentally routes a decision to Ollama Cloud
- Tool policy / approval / sandbox / execution budgets / cloud-local restrictions all keep running unchanged — the Decision Plane only changes _which_ tools are surfaced or _whether_ the expensive critic is entered; it never executes anything itself

---

## How the `DecisionGateway` works

The Nexum-owned seam is `src/models/decision/decision-gateway.ts`:

```ts
export interface DecisionGateway {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  readonly engine: string; // "system-one" | "fake" | ...
}
```

`DecisionRequest` and `DecisionResult` are Nexum domain types (`src/models/decision/types.ts`). They carry no SDK / transport detail:

```ts
interface DecisionRequest {
  id?: string;
  model: string; // dedicated decision model
  mode: "choice" | "score" | "noul";
  context: string; // compact, bounded
  questions: DecisionQuestion[];
  signal?: AbortSignal;
  metadata?: DecisionMetadata; // never secrets
}

interface DecisionResult {
  id: string;
  model: string;
  mode: DecisionMode;
  decisions: DecisionAnswer[]; // { questionId, selected?, score?, probabilities?, raw? }
  latencyMs: number;
  metadata?: DecisionMetadata;
}
```

`mode` mirrors System One's operational taxonomy:

- `choice` — pick exactly one id from a bounded set
- `score` — emit a scalar (0..1) per question, no predefined alternatives
- `noul` — pick zero or one id, with an implicit "none of the above" outcome

The gateway **never converts evidence into an action**. It returns the structured `DecisionResult` to the caller. The caller applies a `DecisionPolicy` (`src/models/decision/decision-policy.ts`) to derive the operational decision.

### Policy

```ts
interface DecisionPolicy {
  minimumProbability: number; // default 0.5 — majority threshold
  maxDomains: number; // default 4 — bounds the active set
}
```

`applyDecisionPolicy(result, policy)` returns the deterministic list of selected ids (sorted by descending probability, truncated to `maxDomains`). The defaults are conservative starting points, NOT tuned — the Wave 7 evaluation harness is where they get retuned against real System One probability distributions.

`NO_ACTION` (an empty selected set) is a first-class valid outcome: a "hello" or "what is dependency injection?" request must not require System One to manufacture work.

---

## The System One adapter

`src/models/decision/system-one-gateway.ts` is the only file that knows about the SDK's wire shape. Its responsibilities:

1. Validate the `DecisionRequest` (including the 64 KiB size limit) **before** touching the network
2. Refuse a `tier: cloud` environment with `DecisionUnavailableError` — System One is local-only
3. Refuse an Ollama version below `0.35.0` (when known) with `DecisionUnavailableError`
4. Build the wire request and call the `SystemOneClient` seam
5. Parse the response, validating every `selected` id against the question's declared `choices` (System One cannot invent ids)
6. Surface every failure as a typed `DecisionError` subclass — never a silent chat fallback

### Error model

`src/models/decision/errors.ts` extends the existing `AgentRuntimeError` hierarchy:

| Class                      | Code                         | Cause                                                          |
| -------------------------- | ---------------------------- | -------------------------------------------------------------- |
| `DecisionUnavailableError` | `DECISION_UNAVAILABLE`       | cloud tier, disabled, Ollama down, version < 0.35.0            |
| `DecisionTransportError`   | `DECISION_TRANSPORT_FAILURE` | network, timeout, abort                                        |
| `DecisionProtocolError`    | `DECISION_PROTOCOL_ERROR`    | malformed response, out-of-band id, oversized request pre-send |
| `DecisionPolicyError`      | `DECISION_POLICY_VIOLATION`  | the caller's policy rejected the evidence (no-action outcome)  |

The gateway never catches a `DecisionError` and converts it into a chat turn — that would destroy the bounded-decision guarantee. The caller's policy owns the deterministic fallback.

---

## SDK adapter seam

The upstream `@nemesis-oss/ollama-sdk@1.7.0+` exposes the System One operation through the public `./generated/api` subpath declared in its `exports` map:

- `NativeApi` class — generated API class for the native domain; `systemOne(request): Promise<unknown>` is its System One method
- `systemOneOp` (re-exported as `systemOne`) — the `OperationDefinition` constant that `NativeApi.systemOne` passes to `OllamaRuntime.invoke`
- `OllamaRuntime` — the runtime that owns transport, retry, streaming, telemetry, and error handling; reachable through the public `OllamaClient.runtime` getter

Nexum does **NOT** depend on `NativeApi.systemOne` directly, because that method does not accept an `AbortSignal` and Nexum's Decision Plane contract preserves the caller's signal end-to-end. Instead, the production adapter `OllamaSystemOneClient` (in `src/models/decision/ollama-system-one-client.ts`) calls `OllamaClient.runtime.invoke({ operation: systemOneOp, body, signal })` directly — using only SDK public surface — which gives us native abort support without a `Promise.race` workaround.

`SystemOneDecisionGateway` itself does NOT depend on any SDK type. It depends on a small Nexum-owned seam:

```ts
// src/models/decision/system-one-gateway.ts
export interface SystemOneClient {
  systemOne(request: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
}
```

`OllamaSystemOneClient` is the only implementor of that seam in production. Tests inject a `FakeSystemOneClient` (or any custom `SystemOneClient`) through `ModelStackOptions.decisionGateway`, so decision-plane logic is fully tested without touching the network.

`Provider.getOllamaClient()` (public accessor in `src/models/adapters/provider.ts`) is how the `ModelStack` reaches the same cached `OllamaClient` that the chat path uses. `LocalSystemOneEnvironment` uses the same accessor with the SDK's `version` operation to probe the local Ollama server's version on the first `decide()` call — the result is cached for the stack's lifetime.

---

## Integrations

### Tool selection (Wave 4)

`src/tools/decision-tool-selector.ts` — the first Decision-Plane integration. Replaces the "ask the small model to emit a JSON array of tool names" path with:

```
user request
   │
   ▼
deterministic domain heuristic  ── high confidence ──▶ deterministic domain→tool mapping
   │
   └── ambiguous
         ▼
      System One (one batched call, all 12 domains as `noul` choices)
         │
         ▼
      domain probabilities
         │
         ▼
      decision policy (threshold + maxDomains)
         │
         ▼
      deterministic domain → tool mapping
         │
         ▼
      Tool[]
```

System One picks **domains**, not tool names. The `DOMAIN_TOOL_NAMES` map (owned by Nexum) converts domains to concrete tools by intersecting with the runtime's available tools. System One cannot invent tool names — the gateway rejects out-of-band ids.

On any `DecisionError`, the selector returns its own heuristic result (which may be empty). System One is an optimization, not the final authority.

The selector is a parallel class — the existing `DynamicToolSelector` heuristic / llm / hybrid modes are untouched.

### Routing hint (Wave 5)

`src/models/router/decision-routing-hint.ts` — System One as an ambiguity resolver for `HeuristicRouter`, not a replacement.

```
HeuristicRouter.classify(prompt)
   │
   ├── obvious (local | cloud) ──▶ deterministic, via='heuristic'
   │
   └── ambiguous ('unknown')
         ▼
      System One (one bounded question: local | cloud, noul mode)
         │
         ├── clear winner ──▶ via='decision'
         └── no winner / failure ──▶ via='fallback' (preserves 'unknown')
```

The resolver returns a `RoutingHint` (a small structured object), not a `Router`. The existing `Router` still owns model routing.

### Verification gate (Wave 6)

`src/runtime/critic/decision-gate.ts` — a cheap bounded decision gate placed **before** the expensive `CriticService` / `SelfCorrectionLoop` path.

```
draft
  │
  ▼
DecisionVerificationGate (one bounded System One call)
  │
  ├── escalate=false ──▶ skip the expensive critic; deterministic VerifierService still runs
  │
  └── escalate=true  ──▶ enter CriticService → SelfCorrection → deterministic verification
```

The gate returns a hint with one bit of information — `shouldEscalate` — and never certifies correctness. The deterministic `VerifierService` is mandatory regardless. System One cannot, by construction, mark an unsafe output valid: the hint shape carries only `escalate`/`via`/`raw`, no `verified`/`certified`/`approved` field.

On any `DecisionError` or inconclusive System One answer, the gate **escalates by default** — never silently accepts. This is the §26 rule: a System One failure on a security-sensitive decision must not become "execute anyway".

The existing `Verifier` / `CriticService` / `SelfCorrectionLoop` / `SelfConsistency` are untouched.

---

## ModelStack integration

`src/cli/services/model-stack.ts` exposes:

```ts
class ModelStack {
  readonly provider: Provider;
  readonly catalog: ModelCatalog;
  readonly router: Router;
  readonly decisionGateway: DecisionGateway | undefined; // undefined = disabled
  readonly decisionModel: string | undefined; // independent of primary model
  // ...
}
```

The stack takes a `ModelStackOptions` with a `decisionGateway` field for dependency injection. Tests pass a `FakeDecisionGateway` to exercise decision consumers without running Ollama.

Construction rules:

- `cfg.enableDecision === false` → `decisionGateway === undefined` (disabled, never built)
- `cfg.tier === "cloud"` → `decisionGateway === undefined` (auto-disabled; System One is local-only)
- `cfg.enableDecision === true && cfg.tier === "local"` → built around `OllamaSystemOneClient` (calls `OllamaClient.runtime.invoke` with the SDK's `systemOneOp`); the local Ollama version is probed lazily on the first `decide()` call via the SDK's `version` operation and cached for the stack's lifetime
- An explicitly-injected `decisionGateway` wins **only when the plane is enabled** — `enableDecision=false` always wins so a caller cannot accidentally enable a disabled plane

The primary generation `model` (e.g. `qwen3.5:4b`) and the `decisionModel` (e.g. `tev1`, the 4B System One model from Together AI) are kept strictly independent. Concurrent `provider.chat()` and `decisionGateway.decide()` calls do not mutate shared model state — the decision gateway receives its own model in the `DecisionRequest`, the `Provider` is untouched.

---

## Configuration

### Environment variables

| Variable               | Description                                                             | Default |
| :--------------------- | :---------------------------------------------------------------------- | :------ |
| `NEXUM_DECISION`       | Enable the bounded Decision Plane (System One). `true` / `false`.       | `false` |
| `NEXUM_DECISION_MODEL` | Dedicated decision model (independent of the primary generation model). | `tev1`  |

### Workspace / global config (`.nexum/config.json` or `~/.nexum/config.json`)

```json
{
  "enableDecision": true,
  "decisionModel": "tev1"
}
```

### Defaults and notes

- The Decision Plane is **off by default**. System One is an optimization / decision aid, never a mandatory runtime dependency.
- The default `decisionModel` is `tev1` — the 4B System One model from Together AI, published at <https://ollama.com/library/tev1>. `tev1:0.8b` is the smaller-memory alternative for tight VRAM (see "Tuning for tev1" below). It is **not** claimed to be universally best; the value is tunable, and the Wave 7 evaluation harness is the place where alternatives are measured.
- In a `tier: cloud` configuration, `enableDecision=true` is silently ignored — no gateway is built. The local-only contract is enforced at both the config layer and the gateway itself.
- Setting `NEXUM_DECISION=false` from the environment overrides a config-file `true` (consistent with every other `NEXUM_*` flag).

---

## Tuning for tev1

`tev1` from Together AI is the actual published System One model on Ollama (<https://ollama.com/library/tev1>). Its README documents the real `/v1/systemone` wire format and the operating envelope. The notes below translate that envelope into Nexum-specific guidance.

### Model choice

- **`tev1`** (4B, ~4.4 GB download) — the default. Per Together AI's eval table, ~88% accuracy on the main decision set.
- **`tev1:0.8b`** (~812 MB) — the smaller-memory alternative for tight VRAM. ~63.5% accuracy on the same set. Set `NEXUM_DECISION_MODEL=tev1:0.8b` (or `decisionModel` in `.nexum/config.json`) to use it.

### Pulling the model

```bash
ollama pull tev1           # or: ollama pull tev1:0.8b
```

Requires Ollama >= 0.35.0. The gateway enforces the version on the first `decide()` call (the `LocalSystemOneEnvironment` in `src/cli/services/model-stack.ts` probes the local Ollama via the SDK's `version` operation and caches the result for the stack's lifetime).

### Context budget

tev1 runs with ~2,000 tokens of context; the longest training example is ~1,500 tokens. Keep `state` short — Nexum's `DecisionRequest.context` is already intended for compact context (no repository dumps, no source files). The 64 KiB request cap (server-enforced, also enforced client-side by `validateDecisionRequest`) is the **hard** server limit; the ~2,000-token context is the **practical soft** limit for accuracy. A 30 KB `context` that fits the wire will materially degrade tev1's accuracy.

### Question count

Up to 64 questions per request. Nexum batches all questions in a single `decide()` call. The tool selector sends 1 batched question with 12 domains as choices — well within the limit. Most callers batch 1–3 questions.

### Options per question

2–26 options for `choice`/`score` (tev1 was trained on 2–24; stay in that range). Nexum's tool selector uses 12 domains — within range. The routing hint resolver and verification gate use 2 options each.

### "None" option convention

When a question's options might not fit the input, add a `none` option. The gateway does this **automatically** for `noul` mode with `choices`: a synthetic `"none": "None of the listed options fit."` entry is appended to the wire `criteria`, and a response with `choice === "none"` maps to `selected: undefined` (the no-candidate-fits outcome) with the `none` probability mass preserved. For `choice` mode, the caller must add a `none` choice explicitly if they want it (the gateway does not synthesize one).

### `keep_alive`

Optional `DecisionRequest.keepAlive` (string, e.g. `"5m"`, `"30s"`, `"-1"` for infinite) controls how long the model stays loaded after the request. Set this when batching multiple `decide()` calls in a tight loop to avoid re-loading the 4B model between calls. The gateway forwards the string verbatim — it does not interpret or validate the format (the Ollama server is the authority).

### Confidence vs probability

tev1 returns a `confidence` field (0..1) which is the **concentration** of the probability distribution, NOT the chance the answer is right. Do not treat it as calibrated correctness. Nexum preserves it on `DecisionAnswer.confidence` (and on `DecisionAnswer.raw`) for telemetry; the policy layer uses `probabilities` and `score` as evidence, never `confidence` as a correctness signal. The evaluation harness's metrics are computed from fixture pass/fail, not from `confidence`.

### Local-only

tev1 (and System One in general) is local-only. The gateway refuses `tier: cloud` with `DecisionUnavailableError`. `ModelStack` auto-disables the gateway in a cloud tier so no adapter is even built. Don't try to route decisions to Ollama Cloud.

### Decision models aren't in the Ollama CLI yet

Use the API (which Nexum does via `OllamaClient.runtime.invoke` with the `systemOneOp` operation) or the TypeSafe SDK. Don't fall back to `Provider.chat()` for decisions — tev1 in a regular chat tends to reply in prose, which would destroy the bounded-decision guarantee. The `SystemOneDecisionGateway` constructor takes only a `SystemOneClient` + environment (no chat provider), so by construction it cannot silently route a decision to `Provider.chat()`.

---

## How to disable it

Any of the following disables the Decision Plane:

- `NEXUM_DECISION=false`
- `enableDecision: false` in `.nexum/config.json` or `~/.nexum/config.json`
- `tier: "cloud"` (auto-disabled — System One is local-only)
- Omit `enableDecision` entirely (default off)

When disabled, `ModelStack.decisionGateway` is `undefined`. Decision consumers (`DecisionToolSelector`, `DecisionRoutingHintResolver`, `DecisionVerificationGate`) accept an optional gateway — `undefined` makes them fall through to the deterministic heuristic / `unknown` / escalate-by-default path. The existing heuristic / llm / hybrid tool selection modes, the existing `HeuristicRouter`, and the existing `Verifier` / `CriticService` / `SelfCorrectionLoop` keep working unchanged.

---

## Cloud / local restrictions

System One is **local-only** by contract. Nexum enforces this in three places:

1. `ModelStack` constructor — never builds a gateway when `cfg.tier === "cloud"`. No adapter is instantiated; the System One endpoint is never called.
2. `SystemOneDecisionGateway.decide()` — refuses `environment.tier === "cloud"` with `DecisionUnavailableError` even if a gateway somehow reaches `decide()` in a cloud tier.
3. Caller policy — every consumer (`DecisionToolSelector`, `DecisionRoutingHintResolver`, `DecisionVerificationGate`) treats `DecisionUnavailableError` as a fallback signal, never as a "route to cloud chat" signal.

The gateway never falls back from a decision call to `Provider.chat()`. The caller's policy chooses the deterministic fallback (heuristic / `unknown` / escalate), and the fallback is always to a non-generative path.

---

## Fallback behavior

System One is an optimization, not the final authority. Every consumer follows the same fallback contract:

| Consumer                      | On `DecisionError`                                | On inconclusive result (no clear winner)          |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `DecisionToolSelector`        | return heuristic result (may be empty `Tool[]`)   | return empty `Tool[]` (NO_ACTION is valid)        |
| `DecisionRoutingHintResolver` | return `{ decision: "unknown", via: "fallback" }` | return `{ decision: "unknown", via: "fallback" }` |
| `DecisionVerificationGate`    | return `{ escalate: true, via: "fallback" }`      | return `{ escalate: true, via: "fallback" }`      |

For security-sensitive decisions (verification gate), the fallback is **escalate**, never **accept** — a System One outage never silently lets an unsafe draft through.

---

## Telemetry and replay

`src/models/decision/telemetry.ts` provides the recording seam:

```ts
interface DecisionEvent {
  id: string;
  engine: string;
  model: string;
  mode: DecisionMode;
  questionCount: number;
  latencyMs: number;
  success: boolean;
  selected: string[]; // post-policy
  policy: DecisionPolicy;
  fallbackReason?: "transport_failure" | "protocol_error" | "policy_violation" | "unavailable" | "unknown";
  metadata?: Record<string, unknown>; // never secrets
  raw?: DecisionResult; // full structured evidence for replay
  timestamp: number;
}
```

`RecordingDecisionGateway` wraps any `DecisionGateway` and records every call (success or failure) to a `DecisionEventRecorder`. The default `InMemoryDecisionEventRecorder` keeps events in memory; production callers can substitute any recorder (file, OTel, sqlite). Recorder errors are **swallowed** — telemetry must never break the runtime it observes.

The recorder preserves the structured `DecisionResult` (id, model, mode, decisions with probabilities/scores/raw) so you can answer:

- Which decision was made?
- Why?
- What model produced the evidence?
- What probabilities/scores were returned?
- Which policy threshold converted that evidence into an action?

It never persists API keys, Authorization headers, or other transport-layer secrets — those live on the wire request, which the gateway already separates from this telemetry.

---

## Evaluation harness

`src/models/decision/evaluation.ts` lets you evaluate a `DecisionGateway` against a list of (request, expected) fixtures **without** running the full agent runtime. It captures:

- accuracy
- false-positive rate
- false-negative rate
- average latency
- fallback rate

Fixtures live in `src/models/decision/evaluation-fixtures.ts` and cover the categories required by the integration prompt §30:

- tool domain classification (`TOOL_DOMAIN_FIXTURES`)
- tool necessity / NO_ACTION (`NO_ACTION_FIXTURES`)
- task complexity (`TASK_COMPLEXITY_FIXTURES`)
- single vs multi-step
- verification (`VERIFICATION_FIXTURES`)
- groundedness
- risk classification

More fixtures are added over time as real System One probability distributions become available. The harness is where the default `DecisionPolicy` thresholds get retuned against actual evidence — not against guessed "optimal" values.

The harness never adds arbitrary confidence-score claims. Probabilities remain an input to policy, not a guarantee of correctness.

---

## How to test it

The Decision Plane is fully testable without a running Ollama:

- **`FakeDecisionGateway`** (`src/models/decision/fake-gateway.ts`) — scripts answers by question id, enforces the same `selected`-in-`choices` contract the real gateway imposes, and supports a `failWith` hook for fallback-behavior tests.
- **`RecordingDecisionGateway`** — wraps any gateway for telemetry assertions.
- **`ModelStack({ decisionGateway: fake })`** — the DI seam lets integration tests inject a fake without touching the SDK or network.

Focused tests live under:

```
tests/models/decision/
├── types.test.ts                  # contract validation (choice/score/noul, 64 KiB, malformed)
├── fake-gateway.test.ts           # fake enforces the same protocol as the real gateway
├── system-one-gateway.test.ts     # local-only, version, transport, oversized, malformed, abort
├── decision-policy.test.ts        # threshold + maxDomains + NO_ACTION
├── telemetry.test.ts              # structured evidence + privacy + reliability
└── evaluation.test.ts             # accuracy / FPR / FNR / fallback rate

tests/tools/decision-tool-selector.test.ts   # heuristic + System One + bounded mapping
tests/models/decision-routing-hint.test.ts   # heuristic wins / ambiguity / fallback
tests/critic/decision-gate.test.ts           # accept / escalate / failure-escalates
tests/cli/model-stack-decision.test.ts       # DI seam, cloud auto-disable, model isolation
```

Run the focused suite:

```bash
NEXUM_TEST_NO_GLOBAL=true node --experimental-vm-modules node_modules/.bin/jest \
  tests/models/decision tests/tools/decision-tool-selector.test.ts \
  tests/cli/model-stack-decision.test.ts tests/models/decision-routing-hint.test.ts \
  tests/critic/decision-gate.test.ts
```

---

## Planes — quick reference

Nexum is organized around five cooperating planes. The Decision Plane is the newest; the others are unchanged.

| Plane              | Code                                                                                       | Responsibility                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation Plane   | `src/models/adapters/provider.ts`, `src/models/router/`, `src/cli/services/model-stack.ts` | Open-ended reasoning / coding / generation via `Provider.chat()`.                                                                                                                            |
| Decision Plane     | `src/models/decision/`                                                                     | Bounded classification / scoring / gating / routing via `DecisionGateway`.                                                                                                                   |
| Tool Plane         | `src/tools/`                                                                               | Tool registry, selection, execution. The Decision Plane feeds `DecisionToolSelector`; tool execution itself goes through the existing `ToolGateway` / `ApprovalBroker` / `PolicyEngine`.     |
| Policy Plane       | `src/core/policy/`, `src/runtime/budget/`                                                  | Approval, budget, sandbox, posture. The Decision Plane never bypasses any of these — decisions only change _which_ tools are surfaced or _whether_ the expensive critic is entered.          |
| Verification Plane | `src/models/verification/`, `src/runtime/critic/`                                          | `Verifier` / `CriticService` / `SelfCorrectionLoop` / `SelfConsistency`. The Decision Plane adds a cheap **gate** before the expensive critic; it never replaces deterministic verification. |

For a broader architecture overview, see `docs/guide/architecture.md`.
