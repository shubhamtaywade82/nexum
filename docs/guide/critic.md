# In-Loop Critic & Self-Correction

Nexum's learning plane reflects **after** a run (episode → grade → lesson → skill). The critic plane is the missing **in-loop** counterpart: a weak final answer gets critiqued and revised inside the *same* execution.

```
final answer
     ↓ CriticService (model critique, heuristic fallback)
 critique { verdict: pass | revise, weaknesses[] }
     ↓ revise
 feedback prompt → regeneration (bounded attempts)
     ↓
 improved answer + reflection trail in result.metadata
```

## Where it runs

The ReAct strategy's final-answer path accepts a `CriticPolicy`:

```ts
new ReActStrategy({ critic: { maxAttempts: 1, minSeverity: "high" } });
// or at the runtime level:
new DefaultAgentRuntime({ critic: { maxAttempts: 1, minSeverity: "high" } });
```

- **Kernel default: off** — embedders keep exact model-call accounting.
- **Product default: on** — DevAgent enables `{ maxAttempts: 1, minSeverity: "high" }` automatically (pass `critic: false` to opt out, or a policy to tune it).

On a `revise` verdict, the feedback enters the context as a system message and the loop regenerates the answer (text-only — no new tool calls mid-answer). Critique and regeneration calls are budget-accounted like any other model call. The final result carries the reflection trail:

```ts
result.metadata.critique; // { attempts, verdict, weaknesses, source }
```

## CriticService

Two layers, deliberately:

| Layer | Behavior |
|---|---|
| **Model critique** | JSON `{verdict, weaknesses: [{description, severity, suggestion}], summary}` routed under a critique capability (default `reasoning`). |
| **Heuristic critique** | Deterministic fallback: empty answer, too-short answers, TODO/FIXME/placeholder markers, refusal patterns, question echo. Runs when the model call fails or returns unparseable output — **a critic outage never breaks the run**. |

The verdict is always **derived** from `weaknesses × minSeverity` — the model's self-assessed verdict does not override the policy bar:

```ts
const critic = new CriticService({ modelGateway, minSeverity: "medium", capability: "reasoning" });
const critique = await critic.critique({ goal, input }, answer);
critique.verdict;      // "pass" | "revise"
critique.weaknesses;   // [{ description, severity, suggestion }]
```

## SelfCorrectionLoop

The reusable reflection primitive (regeneration is injected, so it serves the ReAct path and standalone use):

```ts
const loop = new SelfCorrectionLoop(critic, { maxAttempts: 1 });
const result = await loop.improve(task, answer, async (feedbackPrompt) => regenerate(feedbackPrompt));
// result: { answer, attempts, critiques[], improved }
```

## VerifierService

Deterministic post-conditions — the "did it actually happen" complement to quality critique:

```ts
const verifier = new VerifierService()
  .register(expectOutputContains(["checkpoint", "event bus"]))
  .register(expectNoPlaceholders())
  .register(expectMinLength(50));
const report = await verifier.verify(answer); // { results[], pass }
```

Custom checks implement `VerificationCheck { id, description, run(answer) }`; throwing checks are collected as failures, never crashes.

## Relationship to the learning plane

The two systems compose: in-loop correction fixes this answer; the post-run episode recorder still grades the whole trajectory (including whether the critic had to intervene) and feeds lessons into semantic memory.
