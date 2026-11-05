# Context Compiler & Verification Gate

Nexum keeps the full world state outside the model (task graph, memory, RAG,
artifacts, tool history). The **Context Compiler** turns that state into the
_minimum sufficient_ context for one model call, sized to whichever model the
router picked. The **verification gate** makes a deterministic check — not the
model's claim — the only path from `running` to `completed`.

The same pipeline serves every tier: a 2B quick model (e.g. MiniCPM5), a
local 14B–70B model, or a cloud frontier model. Only the budget changes.

## Model budget

`budgetForProfile(profile)` (`src/models/profiles/context-budget.ts`) derives
a `ModelBudget` from a `ModelProfile`:

| Size class | Selected when                                | Context tokens | Tools | Reasoning |
| ---------- | -------------------------------------------- | -------------- | ----- | --------- |
| `small`    | `quick` capability or `latencyClass: "fast"` | 8,000          | 6     | low       |
| `standard` | any other local model                        | 24,000         | 12    | medium    |
| `frontier` | cloud tier                                   | 48,000         | 20    | high      |

Precedence: explicit overrides → `constraints.preferredContextTokens` /
`constraints.maxToolCount` → size-class default. The result is always clamped
to `contextWindow − reserveOutputTokens` (reserve = `maxOutputTokens`, default
4,096, capped at half the window), floor 1,024 tokens.

A 128K window is a ceiling, not a target: small models reason best over a few
thousand relevant tokens and a handful of tool schemas.

## Compiling context

```ts
import { ContextCompiler } from "@nemesis-oss/nexum";

const compiled = new ContextCompiler().compileFor(profile, {
  goal: "Fix the failing authentication spec",
  step: { id: "s3", objective: "Make auth_spec.rb pass", inputs: ["spec/auth_spec.rb"] },
  constraints: ["Do not modify the database schema"],
  successCriteria: ["bundle exec rspec spec/auth_spec.rb exits 0"],
  failures: ["patched token check; spec still fails at line 48"],
  facts: [{ id: "redis", text: "Redis is required", verified: true, source: "docs/arch.md" }],
  artifacts: [{ uri: "artifact://test-results/456", summary: "37 passed, 2 failed", excerpt: "auth_spec.rb:48" }],
  evidence: { diagnostics: [...], code: [...] }, // packed by ContextPacker
  tools: registry.list(),                         // Tool instances satisfy CompileTool
});

compiled.promptBlock; // what the model sees
compiled.tools;       // tool names to expose (≤ toolBudget)
compiled.excluded;    // every dropped item with a reason
```

Allocation order:

1. **Tool pack** — dedupe, pinned tools first, rank by score (or goal
   overlap), cap to `toolBudget`. Schema JSON is charged to the budget
   (`chargeToolSchemas`, default on) and may never exceed half of it.
2. **Pinned** — task goal, current step, constraints, success criteria. Never
   dropped; truncated proportionally when they alone exceed the budget.
3. **Evidence** — `ContextPacker` gets `evidenceShare` (default 0.6) of what
   remains; unused space flows on to state.
4. **State** — strict priority: previous failures (newest first) → decisions
   → facts (verified first, then relevance) → artifacts → progress. Items are
   atomic: included whole or recorded in `excluded`.

Output is deterministic for identical input and budget, so a resumed or
replayed step sees identical context.

## Verification gate

```ts
import { VerifierService, expectCommandSucceeds, gateTaskCompletion } from "@nemesis-oss/nexum";

const contract = new VerifierService().register(
  expectCommandSucceeds("rspec", "auth spec passes", () => sandbox.run("bundle exec rspec spec/auth_spec.rb")),
);

const { tasks: next, outcome, reason } = await gateTaskCompletion(tasks, "s3", contract, modelAnswer);
// outcome: "completed" | "failed" | "blocked" | "skipped"
```

- Only a `running` task is gated; anything else returns `skipped` without
  running checks (late/duplicate completion events are harmless).
- An empty contract refuses completion unless `requireChecks: false`.
- A check that throws (sandbox down, network error) counts as a failure.
- `onFailure: "blocked"` routes failures to `blocked` instead of the
  retryable `failed`.
