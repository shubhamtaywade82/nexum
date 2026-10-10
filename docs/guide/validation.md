# Validation playbook

This guide records how to validate Nexum and the underlying `@nemesis-oss/ollama-sdk` transport on **Ollama Cloud free tier** and **local** models without burning quota on full multi-model matrix runs.

## Prerequisites

1. Set `OLLAMA_API_KEY` (or `OLLAMA_API_KEYS`) — see [model keys](./model-keys.md).
2. Point `tier` and `model` in `~/.nexum/config.json` or workspace `.nexum/config.json` — see [configuration](./configuration.md).
3. Trust the workspace so sandbox and `.env` apply: `nexum trust`.

```bash
cd nexum
npm run doctor
```

## Phase A — Model benchmark harness

Category-filtered runs (one model per session):

```bash
npm run benchmark -- -m 'gemma4:cloud' -c tool-calling -v
npm run benchmark -- -m 'gemma4:cloud' -c output-format -v
npm run benchmark -- -m 'gemma4:cloud' -c agentic-looping -v
```

Optional local baseline (edge / small model):

```bash
npm run benchmark -- -m 'minicpm5:2b' -c tool-calling -v
npm run benchmark -- -m 'minicpm5:2b' -c agentic-looping -v
```

See [benchmarks](./benchmarks.md) for criteria and the latest recorded pass rates.

## Phase B — Agent smoke missions

Non-interactive missions (B2–B4, B6) against the real agent loop:

Load the workspace model (free-tier models like `gemma4:cloud` are not the same as names in `~/.nexum/config.json`):

```bash
set -a && source .env && set +a   # sets NEXUM_MODEL=gemma4:cloud when present
export NEXUM_AUTO_APPROVE=true
npx tsx scripts/run-validation-missions.ts
```

If missions fail with `model 'gpt-oss:120b' not found`, set `NEXUM_MODEL=gemma4:cloud` in `.env` or update `~/.nexum/config.json` to a model your Ollama Cloud account exposes (`ollama list`).

Append results to [VALIDATION_LOG.md](../../VALIDATION_LOG.md) at the repo root.

Mission B5 (provider unit tests):

```bash
npm test -- tests/models/provider.test.ts
```

## Phase C — SDK-only (optional)

From the monorepo `ollama-sdk/` package, run package tests and README examples for MCP, structured output, and failover when Nexum does not exercise those paths.

## Free-tier discipline

- Run **one model** and **one category** per session.
- Skip daily full `npm run benchmark` without `-m` / `-c` filters.
- Log failures with `caseId` from `-v` output.
