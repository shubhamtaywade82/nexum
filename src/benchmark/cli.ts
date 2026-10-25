#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Provider } from "../models/adapters/provider.js";
import { ModelCatalog, isEmbeddingModel } from "../models/catalog.js";
import { loadConfig } from "../cli/config.js";
import { Agent } from "../cli/agent.js";
import { createAgentDriver } from "./agent-driver.js";
import { runBenchmark, BenchmarkTarget } from "./runner.js";
import { BUILTIN_CASES } from "./cases.js";
import { buildAgenticCases } from "./cases-agentic.js";
import { buildHarnessCases } from "./cases-harness.js";
import { buildExecutionCases } from "./cases-execution.js";
import { BenchmarkCase } from "./types.js";
import { scoreByModel, scoreByCategory } from "./score.js";
import { formatReport, formatCategoryReport } from "./report.js";

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", short: "m" },
      category: { type: "string", short: "c" },
      timeout: { type: "string", short: "t" },
      verbose: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      // "agent" runs agentic cases through the harness's own Agent; "model" (default) calls the model directly.
      driver: { type: "string" },
    },
  });
  const driverName = values.driver ?? "model";
  if (driverName !== "model" && driverName !== "agent") {
    console.error(`Unknown --driver "${driverName}" (expected "model" or "agent").`);
    process.exitCode = 1;
    return;
  }
  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
  const verbose = values.verbose ?? false;

  const cfg = loadConfig();

  const local = new Provider({ tier: "local", model: cfg.model, host: cfg.tier === "local" ? cfg.host : undefined });
  const cloud = cfg.apiKey
    ? new Provider({
        tier: "cloud",
        model: cfg.model,
        apiKey: cfg.apiKey,
        host: cfg.tier === "cloud" ? cfg.host : undefined,
      })
    : undefined;

  const catalog = new ModelCatalog(local, cloud);
  const allModels = (await catalog.refresh()).filter((m) => m.capabilities.length > 0 && !isEmbeddingModel(m.name));

  const modelFilter = values.model?.toLowerCase();
  const models = modelFilter ? allModels.filter((m) => m.name.toLowerCase().includes(modelFilter)) : allModels;

  if (allModels.length === 0) {
    console.error("No models discovered (local Ollama unreachable and no cloud API key configured).");
    process.exitCode = 1;
    return;
  }
  if (models.length === 0) {
    console.error(
      `No discovered model matches --model "${values.model}". Available: ${allModels.map((m) => m.name).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const targets: BenchmarkTarget[] = models.map((m) => ({
    model: m.name,
    tier: m.tier,
    provider: m.tier === "local" ? local : (cloud as Provider),
  }));

  // Execution cases spin up a real (shared, read-only) temp workspace once —
  // safe to reuse across targets since they don't mutate state, unlike the
  // agentic cases' error-recovery case, which needs a fresh call-count
  // closure per target (see buildAgenticCases/runBenchmark's factory note).
  const executionCases = await buildExecutionCases();
  const categoryFilter = values.category;
  const buildCases = (): BenchmarkCase[] => {
    const all = [...BUILTIN_CASES, ...buildAgenticCases(), ...buildHarnessCases(), ...executionCases];
    return categoryFilter ? all.filter((c) => c.category === categoryFilter) : all;
  };

  // One fresh Agent per case, built from this workspace's own config: the harness under test.
  // The quick model is pinned to the target so routing does not swap the executor mid-case;
  // any other model the router still picks is reported in the result's modelsUsed.
  const agentDriver =
    driverName === "agent"
      ? createAgentDriver(
          ({ workspaceRoot, target, events }) =>
            new Agent({
              config: { ...cfg, workspaceRoot, model: target.model, tier: target.tier, quickModel: target.model },
              events,
            }),
        )
      : undefined;

  const caseCount = buildCases().filter((c) => !agentDriver || c.kind === "agentic").length;
  if (caseCount === 0) {
    console.error(`No case matches --category "${values.category}".`);
    process.exitCode = 1;
    return;
  }

  if (!values.json) console.log(`Benchmarking ${models.length} model(s) across ${caseCount} case(s)...\n`);

  const results = await runBenchmark(targets, buildCases, {
    timeoutMs,
    agentDriver,
    onProgress: values.json
      ? undefined
      : (e) => {
          if (e.status === "running") {
            console.log(`  [${e.index + 1}/${e.total}] ${e.tier}/${e.model} — ${e.caseId} ...`);
          } else {
            const outcome = e.error ? `ERROR: ${e.error}` : e.pass ? "pass" : "fail";
            const reasonSuffix = verbose && e.reason ? ` — ${e.reason}` : "";
            console.log(
              `  [${e.index + 1}/${e.total}] ${e.tier}/${e.model} — ${e.caseId} -> ${outcome} (${e.latencyMs}ms)${reasonSuffix}`,
            );
          }
        },
    onToolCall: verbose
      ? (e) => {
          console.log(`      turn ${e.turn + 1}: ${e.name}(${JSON.stringify(e.args)}) -> ${JSON.stringify(e.result)}`);
        }
      : undefined,
  });
  // Machine-readable mode: the evolution CLI's subprocess evaluator consumes
  // exactly this array (see evolution/cli.ts parseBenchmarkJson). One JSON
  // array on stdout, nothing else printed.
  if (values.json) {
    console.log(JSON.stringify(results));
    return;
  }

  console.log();
  const failures = results.filter((r) => !r.pass);

  console.log(formatReport(scoreByModel(results)));
  console.log("\nBy category:\n");
  console.log(formatCategoryReport(scoreByCategory(results)));

  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  ${f.tier}/${f.model} — ${f.caseId}: ${f.error ?? f.reason ?? "unknown"}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    // A timed-out case's underlying fetch may still be in flight (withTimeout
    // stops waiting on it but doesn't abort it) — force exit instead of
    // letting a dangling request/socket keep the process alive indefinitely.
    process.exit(process.exitCode ?? 0);
  });
