/**
 * `nexum ci-healer <tick|plan|status> --config <path>`
 *
 * Exit codes: 0 ok (including kill switch and lease contention), 1 tick failed
 * (retry on the next run), 2 configuration, sandbox, or ledger problem (operator
 * action needed).
 */

import { existsSync } from "node:fs";
import { agentEnv } from "./adapters/agent-env.js";
import { AgentRouter, type RuntimeCandidate } from "./adapters/agent-router.js";
import { antigravityAgent, openCodeAgent } from "./adapters/cli-agents.js";
import { NodeCommandRunner } from "./adapters/command-runner.js";
import { GitCli } from "./adapters/git-cli.js";
import { GitHubCli } from "./adapters/github-cli.js";
import { NexumRpcAgent } from "./adapters/nexum-rpc.js";
import { OllamaCondenser } from "./adapters/ollama-condenser.js";
import { buildRepoCommands, preflightSandbox } from "./adapters/repo-commands.js";
import { Healer } from "./application/healer.js";
import { LogSource, type CondensePort } from "./application/log-source.js";
import type { Logger } from "./application/ports.js";
import { loadConfig, type HealerConfig } from "./config.js";
import { Digester } from "./domain/digest.js";
import { CiHealerError, CommandError, ConfigError, StateError } from "./errors.js";
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
    if (args.command === "tick") await preflightSandbox(new NodeCommandRunner(), config.sandbox);

    const healer = buildHealer(config, store, log);
    if (args.command === "plan") {
      for (const line of await healer.plan()) out(line);
      return 0;
    }
    await healer.tick();
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StateError) {
      log.error("fatal configuration, sandbox, or state problem", { error: error.message });
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

/**
 * Wires the ports. Every process the daemon starts goes through an explicit
 * environment policy. The agent's own sandbox setting follows sandbox.mode, so the
 * agent and the repo commands are sandboxed together or not at all.
 */
export function buildHealer(config: HealerConfig, store: LedgerStore, log: Logger): Healer {
  const runner = new NodeCommandRunner();
  const github = new GitHubCli({ command: runner, repo: config.repo.slug, cwd: config.repo.dir });
  const git = new GitCli({ command: runner, repoDir: config.repo.dir, author: config.git_author, log });

  const agentVariables = {
    ...agentEnv(process.env, config.agent_env_allow),
    NEXUM_SANDBOX: config.sandbox.mode === "docker" ? "true" : "false",
  };
  const timeoutMs = config.nexum_timeout_sec * 1000;

  const candidates: RuntimeCandidate[] = config.agent_chain.map((entry) => {
    switch (entry.runtime) {
      case "nexum":
        return {
          name: "nexum",
          agent: new NexumRpcAgent({ command: config.nexum_command, timeoutMs, env: agentVariables, log }),
        };
      case "opencode":
        return {
          name: `opencode:${entry.model}`,
          agent: openCodeAgent({
            model: entry.model,
            binary: entry.binary,
            command: runner,
            timeoutMs,
            env: agentVariables,
          }),
        };
      case "agy":
        return {
          name: "agy",
          agent: antigravityAgent({ binary: entry.binary, command: runner, timeoutMs, env: agentVariables }),
        };
    }
  });

  const router = new AgentRouter({
    repository: config.repo.slug,
    candidates,
    store,
    log,
    policy: {
      rateLimitCooldownMs: config.runtime_rate_limit_cooldown_sec * 1000,
      breakerThreshold: config.runtime_breaker_threshold,
      breakerCooldownMs: config.runtime_breaker_cooldown_sec * 1000,
    },
    now: () => new Date(),
    reset: (workspace) => git.resetWorktree(workspace),
  });

  const logs = new LogSource({
    github,
    digester: new Digester(),
    log,
    condenser: buildCondenser(config),
    byteCap: config.log_byte_cap,
  });

  return new Healer({
    config,
    github,
    git,
    agent: router,
    repo: buildRepoCommands(runner, config.sandbox),
    logs,
    store,
    log,
  });
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
  out(`scan cursor: ${store.scanCursor(config.repo.slug) ?? "(none yet)"}`);
  for (const event of store.recentEvents(config.repo.slug, 20).reverse()) {
    out(`${event.at} ${event.kind} ${event.healBranch ?? ""} ${JSON.stringify(event.detail)}`.trimEnd());
  }
}
