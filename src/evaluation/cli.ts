/**
 * `nexum eval <dataset.json>` — score real agent runs against a dataset.
 *
 *   dataset.json ─► EvaluationRunner ─► AgentRunHarness (one fresh Agent per
 *   scenario, real model + tools) ─► trajectory from the durable run log
 *   (.nexum/runs) ─► rule metrics (+ LLM judge with --judge) ─► markdown
 *   report + JSON (.nexum/evals) ─► optional regression gate (--baseline)
 *
 * Exit code: 0 when the report (and the regression gate) pass, 1 otherwise —
 * suitable as a CI step. Scenarios run with the configured workspace and
 * approvals: destructive actions are denied unattended, so point it at a
 * scratch checkout for scenarios that edit files.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EvaluationRunner, observeExecution, type AgentHarness } from "./runner.js";
import {
  compareReports,
  defineDataset,
  type EvaluationDataset,
  type Scenario,
  type TrajectoryObservation,
} from "./types.js";
import { ReportStore, renderMarkdownReport, renderRegression } from "./report.js";
import { LlmJudge } from "./judge/llm-judge.js";
import type { ExecutionEventStore } from "../runtime/persistence/execution-event-store.js";
import type { ModelGateway } from "../core/types.js";
import type { ExecutionEvent } from "../runtime/events/execution-events.js";

/** What the harness needs from an agent (the CLI Agent satisfies it). */
export interface EvaluableAgent {
  runUserMessage(message: string): Promise<string>;
  readonly runEvents: ExecutionEventStore;
  stopHost?(): Promise<void>;
}

/**
 * Runs each scenario as one real agent turn on a fresh agent (no shared
 * conversation between scenarios) and observes the trajectory from that
 * run's recorded execution events.
 */
export class AgentRunHarness implements AgentHarness {
  constructor(private readonly createAgent: () => EvaluableAgent) {}

  async run(scenario: Scenario): Promise<TrajectoryObservation> {
    const agent = this.createAgent();
    const before = new Set(agent.runEvents.listRuns().map((r) => r.runId));
    const startedAt = Date.now();
    let output = "";
    let status = "completed";
    let error: string | undefined;
    try {
      output = await agent.runUserMessage(scenario.task.goal);
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      await agent.stopHost?.().catch(() => undefined);
    }
    const run = agent.runEvents
      .listRuns()
      .filter((r) => !before.has(r.runId))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    const events = run ? agent.runEvents.eventsForRun(run.runId).map((e) => e.event as ExecutionEvent) : [];
    return observeExecution({
      scenario,
      runId: run?.runId ?? "unrecorded",
      agentId: run?.agentId ?? "devagent",
      status: run && run.status !== "running" ? run.status : status,
      output,
      events,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    });
  }
}

export interface EvalCliDeps {
  createAgent: () => EvaluableAgent & { modelGateway?: ModelGateway };
  stateDir: string;
  log?: (line: string) => void;
}

const USAGE = `Usage: nexum eval <dataset.json> [options]

Options:
  --baseline <file>      Compare against a saved report (regression gate)
  --max-regression <n>   Allowed drop per metric average vs baseline (default 0.05)
  --out <dir>            Report directory (default .nexum/evals)
  --concurrency <n>      Parallel scenarios (default 1: agents share the workspace)
  --timeout-ms <n>       Per-scenario timeout (default 300000)
  --judge                Enable the LLM judge for scenarios with a rubricId`;

/** Returns the process exit code. */
export async function runEvalCli(argv: string[], deps: EvalCliDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        baseline: { type: "string" },
        "max-regression": { type: "string" },
        out: { type: "string" },
        concurrency: { type: "string" },
        "timeout-ms": { type: "string" },
        judge: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    log(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length !== 1) {
    log(USAGE);
    return values.help ? 0 : 2;
  }

  let dataset: EvaluationDataset;
  try {
    dataset = defineDataset(JSON.parse(await readFile(resolve(positionals[0]), "utf8")) as EvaluationDataset);
  } catch (err) {
    log(`invalid dataset ${positionals[0]}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const positive = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined ? fallback : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const judge = values.judge
    ? (() => {
        const gateway = deps.createAgent().modelGateway;
        return gateway ? new LlmJudge({ modelGateway: gateway }) : undefined;
      })()
    : undefined;

  const runner = new EvaluationRunner(new AgentRunHarness(deps.createAgent), {
    concurrency: Math.floor(positive(values.concurrency, 1)),
    scenarioTimeoutMs: positive(values["timeout-ms"], 300_000),
    ...(judge ? { judge } : {}),
    onScenarioComplete: (r) => log(`${r.pass ? "PASS" : "FAIL"} ${r.scenarioId}`),
  });
  const report = await runner.run(dataset);
  log("");
  log(renderMarkdownReport(report));

  const store = new ReportStore(values.out ? resolve(values.out) : join(deps.stateDir, "evals"));
  const saved = await store.save(report);
  log(`report saved: ${saved}`);

  let regressionPass = true;
  if (values.baseline) {
    const baseline = JSON.parse(await readFile(resolve(values.baseline), "utf8"));
    const maxRegression = Number(values["max-regression"] ?? 0.05);
    const rules = Object.keys(report.summary.metricAverages).map((metricId) => ({ metricId, maxRegression }));
    const regression = compareReports(baseline, report, { rules, mode: "fail" });
    log(renderRegression(regression));
    regressionPass = regression.pass;
  }
  return report.pass && regressionPass ? 0 : 1;
}

/** Default composition: fresh CLI Agents on the configured workspace. */
export async function runEvalCommand(argv: string[]): Promise<number> {
  const { Agent } = await import("../cli/agent.js");
  const { loadConfig } = await import("../cli/config.js");
  const { workspaceStateDir } = await import("../platform/paths.js");
  const cfg = loadConfig();
  return runEvalCli(argv, {
    createAgent: () => new Agent({ config: cfg }),
    stateDir: workspaceStateDir(cfg.workspaceRoot),
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  runEvalCommand(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
