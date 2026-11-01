/**
 * CI Healer: a local daemon that heals failing GitHub Actions runs. It drives the
 * nexum agent in an isolated worktree, verifies the patch, and opens a draft PR.
 *
 * Trust boundary: the agent never holds GitHub credentials, and the daemon alone
 * performs GitHub mutations (see adapters/agent-env.ts).
 */

export { main as runCiHealerCli, parseArgs } from "./cli.js";
export { Healer, type HealerDeps } from "./application/healer.js";
export { loadConfig, parseConfig, type HealerConfig } from "./config.js";
export { LedgerStore } from "./persistence/ledger-store.js";
export { agentEnv, repoCommandEnv } from "./adapters/agent-env.js";
export { deriveChecks } from "./domain/checks.js";
export { Digester } from "./domain/digest.js";
export { healBranchName, targetFor, forbiddenPaths, globToRegExp } from "./domain/policy.js";
export { buildPrompt } from "./domain/prompt.js";
export { canTransition, LINEAGE_STATES, type LineageState } from "./domain/lineage.js";
