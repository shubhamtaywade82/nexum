# Model Benchmark Harness

Nexum includes a built-in benchmark harness to evaluate local and cloud LLMs for agentic coding readiness.

---

## Running the Benchmark

Score all installed local Ollama models and cloud tiers:

```bash
npm run benchmark
```

---

## Evaluation Criteria

1. **Tool Calling Syntax**: Correct function call extraction, argument parsing, and type validation.
2. **JSON Schema Adherence**: Strict structured JSON generation without Markdown markdown fence leakage.
3. **Agentic Decision Making**: Multi-turn tool chaining and recovery from mock environment errors.
4. **Throughput & Latency**: Time to First Token (TTFT) and Tokens Per Second (tok/s).

---

## Recorded validation (2026-10-09)

Harness runs on this checkout with Ollama Cloud + local daemon. Full commands: [validation playbook](./validation.md).

| Model | Category | Pass rate | Notes |
|-------|----------|-----------|-------|
| `gemma4:cloud` | `tool-calling` | 100% (4/4 per tier) | cloud avg ~589ms; local tag same name |
| `gemma4:cloud` | `output-format` | 100% | `json-validity` |
| `gemma4:cloud` | `agentic-looping` | 100% | `react-two-step-tool-chain` |
| `minicpm5:2b` | `tool-calling` | 100% | local ~2.7s avg latency vs ~0.5s cloud tier |
| `minicpm5:2b` | `agentic-looping` | 100% | same two-step chain case |

Categories not yet recorded in this table: `reasoning`, `thinking`, `error-recovery`, `escalation`, `execution`. Some `escalation` cases are expected to fail until routing is tuned — see `src/cli/agent.ts` and `src/benchmark/cases-agentic.ts`.
