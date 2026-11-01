/**
 * `nexum ci-healer <tick|plan|status> --config <path>`
 *
 * Exit codes: 0 ok (including kill switch and lease contention), 1 tick failed
 * (retry on the next run), 2 configuration or ledger problem (operator action needed).
 */

import { existsSync } from "node:fs";
import { CommandError } from "./errors.js";
import { agentEnv } from "./adapters/agent-env.js";
import { GitCli } from "./adapters/git-cli.js";
import { GitHubCli } from "./adapters/github-cli.js";
import { NodeCommandRunner } from "./adapters/command-runner.js";
import { NexumRpcAgent } from "./adapters/nexum-rpc.js";
import { OllamaCondenser } from "./adapters/ollama-condenser.js";
import { Healer } from "./application/healer.js";
import { LogSource, type CondensePort } from "./application/log-source.js";
import type { Logger } from "./application/ports.js";
import { Digester } from "./domain/digest.js";
import { loadConfig, type HealerConfig } from "./config.js";
import { ConfigError, CiHealerError, StateError } from "./errors.js";
import { createLogger } from "./logger.js";
import { LedgerStore } from "./persistence/ledger-store.js";

const USAGE = "usage: nexum ci-healer <tick|plan|status> --config <path>";

export interface ParsedArgs {
  command: "tick" | "plan" | "status";
  config: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "tick" && command !== "plan" && command !== "status") {
    throw new ConfigError(USAGE);
  }
  const index = rest.indexOf("--config");
  const config = index >= 0 ? rest[index + 1] : undefined;
  if (!config) throw new ConfigError(USAGE);
  return { command, config };
}

export interface CliOptions {
  out?: (line: string) => void;
  log?: Logger;
}

export async function main(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = options.log ?? createLogger();
  let store: LedgerStore | undefined;
  try {
    const args = parseArgs(argv);
    const config = loadConfig(args.config);
    if (existsSync(config.kill_switch_file)) {
      log.warn("kill switch present; not running", { path: config.kill_switch_file });
      return 0;
    }

    store = new LedgerStore(config.state_file);
    if (args.command === "status") {
      printStatus(store, config, out);
      return 0;
    }
    const healer = buildHealer(config, store, log);
    if (args.command === "plan") {
      for (const line of await healer.plan()) out(line);
      return 0;
    }
    await healer.tick();
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StateError) {
      log.error("fatal configuration or state problem", { error: error.message });
      return 2;
    }
    if (error instanceof CiHealerError || error instanceof CommandError) {
      log.error("tick failed", { error: error.message });
      return 1;
    }
    throw error;
  } finally {
    store?.close();
  }
}

export function buildHealer(config: HealerConfig, store: LedgerStore, log: Logger): Healer {
  const runner = new NodeCommandRunner();
  const github = new GitHubCli({ command: runner, repo: config.repo.slug, cwd: config.repo.dir });
  const git = new GitCli({ command: runner, repoDir: config.repo.dir, author: config.git_author, log });
  const agent = new NexumRpcAgent({
    command: config.nexum_command,
    timeoutMs: config.nexum_timeout_sec * 1000,
    env: agentEnv(process.env, config.agent_env_allow),
    log,
  });
  const logs = new LogSource({
    github,
    digester: new Digester(),
    log,
    condenser: buildCondenser(config),
    byteCap: config.log_byte_cap,
  });
  return new Healer({ config, github, git, agent, logs, command: runner, store, log });
}

function buildCondenser(config: HealerConfig): CondensePort | undefined {
  const { condenser } = config;
  if (condenser.type === "deterministic") return undefined;
  return new OllamaCondenser({ url: condenser.url, model: condenser.model, timeoutMs: condenser.timeout_sec * 1000 });
}

function printStatus(store: LedgerStore, config: HealerConfig, out: (line: string) => void): void {
  const lineages = store.activeLineages(config.repo.slug);
  if (lineages.length === 0) out("no active lineages");
  for (const lineage of lineages) {
    out(
      `${lineage.healBranch} state=${lineage.state} attempts=${lineage.attempts} pr=#${lineage.prNumber} base=${lineage.baseBranch}`,
    );
  }
  for (const event of store.recentEvents(config.repo.slug, 20).reverse()) {
    out(`${event.at} ${event.kind} ${event.healBranch ?? ""} ${JSON.stringify(event.detail)}`.trimEnd());
  }
}
