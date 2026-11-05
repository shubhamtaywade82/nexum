/**
 * CI Healer: a local daemon that heals failing GitHub Actions runs. It runs a
 * repair runtime chain in an isolated worktree, verifies the patch in a sandbox, and
 * opens a draft PR.
 *
 * Trust boundary: the repair runtime never holds GitHub credentials. Repo-controlled
 * commands run in a container with no host home and no network for verify. The daemon
 * alone performs GitHub mutations (see adapters/agent-env.ts and adapters/repo-commands.ts).
 */

export { main as runCiHealerCli, parseArgs, buildHealer } from "./cli.js";
export { Healer, selectScanWindow, type HealerDeps } from "./application/healer.js";
export { loadConfig, parseConfig, type HealerConfig } from "./config.js";
export { LedgerStore } from "./persistence/ledger-store.js";
export { agentEnv, repoCommandEnv } from "./adapters/agent-env.js";
export { AgentRouter, type RuntimeCandidate } from "./adapters/agent-router.js";
export { buildDockerRunArgs, buildRepoCommands, preflightSandbox } from "./adapters/repo-commands.js";
export { deriveChecks, isFailing } from "./domain/checks.js";
export { Digester } from "./domain/digest.js";
export { healBranchName, targetFor, forbiddenPaths, globToRegExp } from "./domain/policy.js";
export { buildPrompt } from "./domain/prompt.js";
export { canTransition, LINEAGE_STATES, type LineageState } from "./domain/lineage.js";
