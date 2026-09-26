# Multi-Key Cloud Pools & Rotation

Ollama Cloud keys are configured as a **pool**, not one-at-a-time. When several keys are available, Nexum rotates across them automatically mid-session: a rate-limited key is skipped without surfacing an error, keys are kept bound to "their" model so Ollama Cloud keeps them warm in VRAM, and no manual switching is ever required. This page documents the three layers that make that work and how they compose.

```
request for model M (cloud tier)
      ↓
[1] KeyManager (2+ keys)     model→key warmth binding; queue + probe
      ↓ preferred key (or none)
[2] Provider endpoint pool   one endpoint per key, preferred pinned first
      ↓                      SDK fails over on 429 / network / auth …
[3] Router                   on unrecoverable model failure: switch candidate
      ↓                      (availability pre-check excludes cold models)
   response
```

## Configuring a pool

Keys are collected from three sources, deduplicated in this priority order:

```bash
OLLAMA_API_KEY=key_a                       # primary single key
OLLAMA_API_KEYS=key_b,key_c,key_d          # comma-separated pool
```

```json
// .nexum/config.json
{ "apiKeys": ["key_e"] }
```

`OLLAMA_*` names are provider-convention variables and keep their upstream names (see `docs/REBRANDING.md`). A single key still works exactly as before — the pool machinery only engages with **two or more** keys.

## Layer 1 — automatic rotation in the SDK client

The cloud Provider builds one client with **one endpoint per key**, all on the same host, in descending priority order. When an endpoint fails with a retryable condition, the SDK fails over to the next key's endpoint transparently within the same call:

- `failureThreshold: 1` — a single 429 immediately knocks a key out of rotation for its cooldown window (no three-strikes circuit breaker still preferring a hot key).
- `retries: 0` — a failed key is not retried against itself; the next key is tried at once.
- Failover codes: `network_error`, `timeout`, `server_error`, `rate_limited`, `auth_error`, `unsupported_capability`.
- Rotation state **persists across calls**: after a mid-session 429, the next request starts from the last healthy key rather than re-hitting the rate-limited one.

This layer is always on for cloud traffic and is the safety net everything else falls back to.

## Layer 2 — KeyManager warmth binding

Ollama Cloud keeps recently-used models warm in VRAM. If consecutive requests for different models bounce across the same key, models get evicted and re-loaded, adding latency. With two or more keys, the `KeyManager` (`src/models/router/key-manager.ts`) prevents that thrashing:

- Each key slot is **bound to at most one model**. A request for model M first looks for an idle slot already bound to M — instant, no probe.
- Otherwise an unbound slot is probed (via the availability checker) and bound to M. The slot is reserved _before_ the async probe so two concurrent acquires can't race onto the same slot.
- Concurrent callers for the same model **queue and share** one key rather than fanning out.
- `release()` keeps the binding (warmth) and only clears the busy flag.

In the live request path (`ModelStack` → cloud `Provider`), the acquired "preferred" key is pinned as the **highest-priority endpoint** of the client, with all other pool keys kept below it as failover. Key selection and rotation therefore compose instead of replacing each other: the KeyManager decides which key a request _starts_ on, and Layer 1 still handles mid-call failures.

Key selection is strictly best-effort — it is an optimization, never a correctness requirement:

| Failure                           | Behavior                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------ |
| All keys busy                     | Wait up to 5 s (`acquireTimeoutMs`), then fall back to the plain endpoint pool |
| Availability probe fails / throws | Slot reservation dropped, next unbound slot tried, then plain pool             |
| Selector misconfigured / throws   | Request proceeds with the plain pool — never breaks a chat                     |

The 5 s acquire timeout (tightened from the 30 s library default) ensures a fully-saturated pool degrades to plain SDK failover quickly instead of stalling an interactive turn.

## Layer 3 — router candidate switching

If a model itself fails unrecoverably (not just one key), the `ScoredModelRouter` retries with the next best candidate model — possibly degrading to a local tier model for resilience. Before that, the availability pre-check (`ModelAvailabilityChecker`) probes which models each key can actually reach, excluding inaccessible ones from routing; results are cached 24 h (60 s on transient failures). See [Capability Router & Escalation](/guide/capability-routing) for the routing side.

## Worked example: a 429 mid-session

| Time       | Event                                       | What the user sees                                                          |
| ---------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| t1         | `chat()` on key A (bound to `gpt-oss:120b`) | normal response                                                             |
| t2         | key A returns 429 (rate-limited)            | nothing — SDK fails over to key B within the same call                      |
| t3         | next request                                | starts on key B; key A stays out of rotation for its cooldown, then returns |
| throughout | keys A and B stay bound to their models     | warm VRAM, no reload latency                                                |

## Observability

The `KeyManager` exposes a redacted snapshot for status displays and debugging:

```ts
keyManager.snapshot();
// [{ apiKey: "ghp_12345…", boundModel: "gpt-oss:120b", busy: false }, …]
keyManager.bestKeyForModel("gpt-oss:120b"); // → idle key bound to that model
keyManager.boundModels(); // → ["gpt-oss:120b", "qwen3-coder:480b"]
keyManager.unbind(key); // drop a binding, e.g. after the model is evicted
```

The behavior described on this page is pinned by tests: `tests/models/provider.test.ts` (rotation on 429, rotation-state persistence across calls, preferred-key pinning via `Authorization` header, fallback-on-acquire-failure), `tests/models/key-manager.test.ts` (binding, probe-race, queueing, timeouts), and `tests/cli/model-stack-keys.test.ts` (live request-path wiring).
