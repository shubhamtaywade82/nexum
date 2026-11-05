# Nexum validation log

Manual and automated runs from the [validation playbook](docs/guide/validation.md). Re-run with `npm run doctor`, category-filtered `npm run benchmark`, and `NEXUM_AUTO_APPROVE=true npx tsx scripts/run-validation-missions.ts`.

| Date | Command / mission | Model | Result | Notes |
|------|-------------------|-------|--------|-------|
| 2026-10-09 | `npm run doctor` | gemma4:cloud (config) | pass | Node 24, Docker ok, 5 API keys, 15 LSP providers |
| 2026-10-09 | benchmark `-c tool-calling` | gemma4:cloud | pass | 4/4 cases, local + cloud tiers 100% |
| 2026-10-09 | benchmark `-c output-format` | gemma4:cloud | pass | json-validity 100% |
| 2026-10-09 | benchmark `-c agentic-looping` | gemma4:cloud | pass | react-two-step-tool-chain 100% |
| 2026-10-09 | benchmark `-c tool-calling` | minicpm5:2b | pass | local baseline; slower latency vs cloud gemma |
| 2026-10-09 | benchmark `-c agentic-looping` | minicpm5:2b | pass | local baseline |
| 2026-10-09 | mission B2 | gemma4:cloud | pass | package name @nemesis-oss/nexum |
| 2026-10-09 | mission B3 | gemma4:cloud | pass | OllamaClient import paths |
| 2026-10-09 | mission B4 | gemma4:cloud | pass | three guide docs summarized |
| 2026-10-09 | mission B6 | gemma4:cloud | pass | escalation cases explained |
| 2026-10-09 | `npm test tests/models/provider.test.ts` | n/a | partial | 26 passed, 6 failed (cloud account mock tests) |
| 2026-10-09 | mission B2 | gpt-oss:120b | pass | 6074ms — len=18 |
| 2026-10-09 | mission B3 | gpt-oss:120b | fail | 31368ms — Ollama cloud 404: {"error":"model 'gpt-oss:120b' not found"} |
| 2026-10-09 | mission B4 | gpt-oss:120b | fail | 16445ms — check failed; snippet=I'm not sure where you're going with me — the last few turns got a bit tangled. Let me clarify:  **What do you want to d |
| 2026-10-09 | mission B6 | gpt-oss:120b | pass | 37178ms — len=1074 |
| 2026-10-09 | mission B2 | gemma4:cloud | pass | 6287ms — len=18 |
| 2026-10-09 | mission B3 | gemma4:cloud | pass | 40894ms — len=215 |
| 2026-10-09 | mission B4 | gemma4:cloud | pass | 36792ms — len=1499 |
| 2026-10-09 | mission B6 | gemma4:cloud | pass | 21169ms — len=602 |
