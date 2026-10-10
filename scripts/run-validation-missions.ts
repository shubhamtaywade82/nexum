#!/usr/bin/env node
/**
 * Non-interactive smoke missions for VALIDATION_LOG (plan Phase B).
 * Usage:
 *   set -a && source .env && set +a   # loads NEXUM_MODEL when workspace is trusted
 *   NEXUM_AUTO_APPROVE=true npx tsx scripts/run-validation-missions.ts
 *
 * Override model: NEXUM_VALIDATION_MODEL=gemma4:cloud
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Agent } from "../src/cli/agent.js";
import { applyEnvFiles, loadConfig, type CliConfig } from "../src/cli/config.js";
import { readEnv } from "../src/platform/environment.js";

const missions: Array<{ id: string; goal: string; check: (out: string) => boolean }> = [
  {
    id: "B2",
    goal: "Read nexum/package.json in this workspace and reply with only the npm package name field value.",
    check: (out) => /@nemesis-oss\/nexum/i.test(out),
  },
  {
    id: "B3",
    goal: "Find where OllamaClient from @nemesis-oss/ollama-sdk is imported in this repo. List up to 5 file paths.",
    check: (out) => /provider\.ts|ollama-sdk/i.test(out) && out.length > 20,
  },
  {
    id: "B4",
    goal:
      "Read docs/guide/benchmarks.md and docs/guide/configuration.md and docs/guide/evaluation.md. " +
      "In one short paragraph, name all three doc topics.",
    check: (out) => /benchmark/i.test(out) && /config/i.test(out) && /eval/i.test(out),
  },
  {
    id: "B6",
    goal:
      "Open src/benchmark/cases-agentic.ts and explain in 3 sentences what the escalation benchmark cases test.",
    check: (out) => /escalat/i.test(out) && out.length > 80,
  },
];

async function logLine(line: string): Promise<void> {
  const logPath = join(process.cwd(), "VALIDATION_LOG.md");
  await appendFile(logPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function resolveValidationModel(cfg: CliConfig): string {
  return (
    process.env.NEXUM_VALIDATION_MODEL?.trim() ||
    readEnv("VALIDATION_MODEL") ||
    readEnv("MODEL") ||
    cfg.model ||
    "gemma4:cloud"
  );
}

async function main(): Promise<void> {
  // Ensures NEXUM_MODEL in workspace .env applies even when trust skipped .env in applyEnvFiles.
  loadDotenv({ path: join(process.cwd(), ".env"), override: false, quiet: true });
  applyEnvFiles();
  const baseCfg = loadConfig();
  const model = resolveValidationModel(baseCfg);
  const cfg: CliConfig = { ...baseCfg, model };

  const date = new Date().toISOString().slice(0, 10);
  let failed = 0;

  for (const m of missions) {
    const agent = new Agent({ config: cfg });
    await agent.startHost().catch(() => undefined);
    const started = Date.now();
    let result = "fail";
    let notes = "";
    try {
      const out = String(await agent.runUserMessage(m.goal));
      const ok = m.check(out);
      result = ok ? "pass" : "fail";
      notes = ok ? `len=${out.length}` : `check failed; snippet=${out.slice(0, 120).replace(/\n/g, " ")}`;
    } catch (err) {
      notes = err instanceof Error ? err.message : String(err);
    } finally {
      await agent.stopHost?.().catch(() => undefined);
    }
    if (result === "fail") failed += 1;
    const ms = Date.now() - started;
    await logLine(`| ${date} | mission ${m.id} | ${model} | ${result} | ${ms}ms — ${notes} |`);
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
