# Agent Evaluation Framework

The benchmark harness scores **models** (JSON validity, tool-call format). This framework scores **agent runs** end to end: declared expectations → executed trajectory → metrics → thresholds → regression gates.

```
EvaluationDataset
  └─ Scenario (task + expectations)
       ↓ AgentHarness.run(scenario)
  TrajectoryObservation (status · output · tool calls · model calls · usage)
       ↓ EvaluatorRegistry — RuleEvaluator (deterministic) + JudgeEvaluator (LLM rubric)
  MetricResult[] (normalized 0..1, higher = better)
       ↓ thresholds + compareReports(baseline, current, policy)
  EvaluationReport → markdown / JSON baseline
```

## Scenarios

```ts
import { defineDataset } from "@nemesis-oss/nexum";

const dataset = defineDataset({
  id: "devagent:core-flows",
  name: "Core DevAgent flows",
  scenarios: [
    {
      id: "read-package-name",
      name: "Read package name",
      task: { goal: "Read package.json and report the package name" },
      expected: {
        status: "completed",
        finalOutputContains: ["@nemesis-oss/nexum"],
        toolCalls: [{ name: "read_file", argsContains: { path: "package.json" } }],
        forbiddenTools: ["shell"],
        maxTurns: 6,
        maxLatencyMs: 20_000,
        rubricId: "builtin:task-completion",   // LLM-judged quality
      },
    },
  ],
});
```

## Metrics

| Metric id | What it measures | Normalized |
|---|---|---|
| `goal.completion` | expected status + output substrings | ✅ |
| `tool.selection` | required tool calls made (name + arg subset match) | ✅ |
| `tool.arguments` | expected argument subsets satisfied | ✅ |
| `trajectory.efficiency` | tool-call frugality vs expectation (respects `maxToolCalls`) | ✅ |
| `recovery.success` | failed tool calls later retried successfully | ✅ |
| `safety.forbidden` | no forbidden tool fired | ✅ |
| `run.latency_ms` | wall-clock (gate: `maxLatencyMs`) | raw |
| `run.tokens` | token total (gate: `maxTokens`) | raw |
| `run.turns` | strategy turns (gate: `maxTurns`) | raw |
| `judge.overall` / `judge.criterion.*` | LLM-judge verdicts (needs `rubricId`) | ✅ |

Evaluators are pluggable: implement `Evaluator { id, evaluate(scenario, observation) }` and register it.

## Running

```ts
import { EvaluationRunner, FunctionHarness, observeExecution } from "@nemesis-oss/nexum";

const runner = new EvaluationRunner(harness, {
  concurrency: 4,
  scenarioTimeoutMs: 120_000,
  judge,                                        // optional: enables rubric metrics
  thresholds: [{ metricId: "goal.completion", min: 0.9 }],
  onScenarioComplete: (r) => console.log(r.scenarioId, r.pass),
});
const report = await runner.run(dataset);
```

A **harness** is anything that executes a scenario and returns a `TrajectoryObservation`:
- `FunctionHarness(fn)` for fakes and recorded runs (unit tests).
- `observeExecution({...events})` builds observations from a captured kernel `EventBus` stream — tool calls are paired by event id (`tool.started` → `tool.completed`/`tool.failed`), unresolved calls surface as failures.

Harness errors and timeouts become **errored scenarios** in the report — one broken scenario never crashes the suite.

## Regression gating

```ts
const regression = compareReports(baselineReport, currentReport, {
  rules: [{ metricId: "goal.completion", maxRegression: 0.05 }],
  mode: "fail",            // or "warn"
});
regression.regressions; // [{ metricId, baseline, current, delta, maxRegression }]
```

Persist baselines with `ReportStore(dir)` (`save` / `load` / `latestFor(datasetId)`) and render CI output with `renderMarkdownReport(report)` / `renderRegression(regression)`.
