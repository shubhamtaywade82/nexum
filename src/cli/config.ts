import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { envIs, readEnv, readEnvFlag } from "../platform/environment.js";
import { THEME_ORDER, ThemeName } from "../runtime/types.js";
import {
  findWorkspaceRoot,
  globalStateDir,
  legacyGlobalStateDir,
  legacyWorkspaceStateDir,
  workspaceStateDir,
} from "../platform/paths.js";

export interface LanguageOverride {
  enabled?: boolean;
  serverCommand?: string;
  serverArgs?: string[];
}

export interface LspCliConfig {
  idleTimeoutMs?: number;
  maxServers?: number;
  prewarm?: string[];
}

export interface CliConfig {
  model: string;
  workspaceRoot: string;
  tier: "local" | "cloud";
  host?: string;
  apiKey?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  shellImage?: string;
  shellTimeoutSec?: number;
  sandbox?: boolean;
  languages?: Record<string, LanguageOverride>;
  lsp?: LspCliConfig;
  toolSelectionMode?: "heuristic" | "llm" | "hybrid";
  maxActiveTools?: number;
  /** Pool of Ollama Cloud API keys (e.g. separate accounts) — Provider rotates to the
   * next key on a 429 before giving up. Ollama Cloud only, not a multi-vendor router. */
  apiKeys?: string[];
  /** Preferred local model name (substring match) for the "quick" capability,
   * e.g. "minicpm5" — see ModelCatalog.modelsFor. */
  quickModel?: string;

  // ── Hybrid local-cloud architecture ──────────────────────────────────────
  /** Route trivial boilerplate tasks to the local quick model before calling cloud.
   * Default true when quickModel is set. Disable with NEXUM_LOCAL_WORKER=false. */
  enableLocalWorker?: boolean;
  /** After local generation, run a critic pass to catch confident-wrong answers.
   * Off by default (experimental). Enable with NEXUM_VERIFIER=true. */
  enableVerifier?: boolean;
  /** For 'unknown' heuristic decisions, draw N samples and check agreement.
   * Off by default. Enable with NEXUM_SELF_CONSISTENCY=true. */
  enableSelfConsistency?: boolean;
  /** Number of self-consistency samples. Default 3. */
  selfConsistencyN?: number;
  /** Agreement threshold below which to escalate. Default 0.5. */
  selfConsistencyThreshold?: number;
  /** TTL (ms) for the ModelAvailabilityChecker cache. Default 86_400_000 (24 h). */
  availabilityCheckTtlMs?: number;
  /** Pre-check cloud model subscription access at startup.
   * Default true when apiKeys are configured. Disable with NEXUM_AVAIL_CHECK=false. */
  enableAvailabilityCheck?: boolean;
  /** Layer-1 heuristic gate: skip the quick-model attempt entirely when the
   * prompt matches an explicit complexity trigger (debug/architecture/proof/
   * multi-step/etc.), escalating straight to the primary model instead.
   * Default true. Disable with NEXUM_HEURISTIC_GATE=false. */
  enableHeuristicGate?: boolean;
  /** Ollama itself has no published per-token price (subscription/GPU-time
   * billing) — this only computes a cost estimate if you supply your own
   * real rate. Omit to leave cost tracking off (the honest default). */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  /** Approve every destructive tool call (delete_file, `rm -rf`-class shell
   * commands) without prompting. Off by default; only for CI/benchmark runs
   * and throwaway containers. Enable with NEXUM_AUTO_APPROVE=true. */
  autoApprove?: boolean;
  /** Color theme for the TUI: one of the built-in THEME_ORDER names.
   * Set in .nexum/config.json ("theme") or NEXUM_THEME; defaults to "default". */
  theme?: ThemeName;
  /** External MCP (Model Context Protocol) servers to connect at startup —
   * each spawns `command args...` over stdio and registers its tools.
   * Configure in .nexum/config.json; there is no in-session "/mcp add". */
  mcpServers?: Array<{ name: string; command: string; args?: string[] }>;
}

interface ConfigFile {
  model?: string;
  tier?: string;
  theme?: string;
  host?: string;
  apiKey?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  shellImage?: string;
  shellTimeoutSec?: number;
  sandbox?: boolean;
  toolSelectionMode?: string;
  maxActiveTools?: number;
  apiKeys?: string[];
  quickModel?: string;
  enableLocalWorker?: boolean;
  enableVerifier?: boolean;
  enableSelfConsistency?: boolean;
  selfConsistencyN?: number;
  selfConsistencyThreshold?: number;
  availabilityCheckTtlMs?: number;
  enableAvailabilityCheck?: boolean;
  enableHeuristicGate?: boolean;
  autoApprove?: boolean;
  /** Ollama itself has no published per-token price (subscription/GPU-time
   * billing) — this only computes a cost estimate if you supply your own
   * real rate. Omit to leave cost tracking off (the honest default). */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  mcpServers?: Array<{ name: string; command: string; args?: string[] }>;
}

const DEFAULT_SYSTEM_PROMPT = `You are a focused coding assistant operating in a local workspace. \
Adhere strictly to Clean Code, KISS (Keep It Simple), YAGNI (You Aren't Gonna Need It), and SOLID principles. \
Prefer minimal, surgical, and robust changes. Keep functions small, focused, and well-structured. \
Do not introduce speculative abstractions, unused interfaces, or dead code. \
Use the provided tools to edit code, inspect files, and run commands from the workspace root when the user's request calls for it. \
If a command or test fails, inspect the error diagnostics and fix the exact cause rather than performing broad unneeded refactors.`;

const GLOBAL_CONFIG_DIR = globalStateDir();
// Legacy DevAgent-era global state — read as a deprecated fallback, never written.
const LEGACY_GLOBAL_CONFIG_DIR = legacyGlobalStateDir();

/** Parse a config JSON file, tolerating absence and malformed content. */
function readConfigFile(p: string): ConfigFile {
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as ConfigFile;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // skip malformed config file
  }
  return {};
}

function loadGlobalConfig(): ConfigFile {
  if (envIs("TEST_NO_GLOBAL", "true")) return {};
  // Legacy ~/.devagent/config.json still applies (deprecated); the canonical
  // ~/.nexum/config.json wins key-by-key on top of it.
  const legacy = readConfigFile(join(LEGACY_GLOBAL_CONFIG_DIR, "config.json"));
  const current = readConfigFile(join(GLOBAL_CONFIG_DIR, "config.json"));
  return { ...legacy, ...current };
}

// Workspace-root discovery lives in platform/paths.ts: walk up from cwd to
// the nearest `.git`, with `.nexum` (and legacy `.devagent`) as fallback
// markers for non-git workspaces — a real repo needs no prior session to be
// "found", so the first run in a new project never falls back to cwd and
// starts a disconnected history/config.
function loadWorkspaceConfig(root: string): ConfigFile {
  // Legacy .devagent/config.json is read as a deprecated fallback; the
  // canonical .nexum/config.json wins key-by-key on top of it.
  const legacy = readConfigFile(join(legacyWorkspaceStateDir(root), "config.json"));
  const current = readConfigFile(join(workspaceStateDir(root), "config.json"));
  return { ...legacy, ...current };
}

export function saveWorkspaceConfig(root: string, partial: Partial<ConfigFile>): void {
  const dir = workspaceStateDir(root);
  const p = join(dir, "config.json");
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const current = loadWorkspaceConfig(root);
    const merged = { ...current, ...partial };
    writeFileSync(p, JSON.stringify(merged, null, 2), "utf8");
  } catch {
    // Non-fatal if directory is not writable
  }
}

export function saveGlobalConfig(partial: Partial<ConfigFile>): void {
  const dir = GLOBAL_CONFIG_DIR;
  const p = join(dir, "config.json");
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const current = loadGlobalConfig();
    const merged = { ...current, ...partial };
    writeFileSync(p, JSON.stringify(merged, null, 2), "utf8");
  } catch {
    // Non-fatal if directory is not writable
  }
}

function loadAgentsFile(root: string): string {
  for (const name of ["AGENTS.md", "NEXUM.md", "DEVAGENT.md"]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      // skip unreadable file
    }
  }
  return "";
}

import { config as dotenvConfig } from "dotenv";

function loadEnvFiles(workspaceRoot: string): void {
  if (envIs("TEST_NO_GLOBAL", "true")) return;
  // Canonical ~/.nexum/.env; legacy ~/.devagent/.env still loads (deprecated)
  // when the canonical file does not exist.
  const globalEnv = join(GLOBAL_CONFIG_DIR, ".env");
  if (existsSync(globalEnv)) {
    dotenvConfig({ path: globalEnv, override: false, quiet: true } as any);
  } else {
    const legacyGlobalEnv = join(LEGACY_GLOBAL_CONFIG_DIR, ".env");
    if (existsSync(legacyGlobalEnv)) {
      dotenvConfig({ path: legacyGlobalEnv, override: false, quiet: true } as any);
    }
  }
  const cwdEnv = join(process.cwd(), ".env");
  if (existsSync(cwdEnv)) {
    dotenvConfig({ path: cwdEnv, override: true, quiet: true } as any);
  }
  const workspaceEnv = join(workspaceRoot, ".env");
  if (existsSync(workspaceEnv) && workspaceEnv !== cwdEnv) {
    dotenvConfig({ path: workspaceEnv, override: true, quiet: true } as any);
  }
}

export function loadConfig(): CliConfig {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  loadEnvFiles(workspaceRoot);
  const globalFile = loadGlobalConfig();
  const workspaceFile = loadWorkspaceConfig(workspaceRoot);
  // Workspace config overrides global, env vars override both.
  // Product env vars resolve NEXUM_* first, then deprecated DEVAGENT_*
  // (see platform/environment.ts — legacy reads warn on stderr).
  const file = { ...globalFile, ...workspaceFile };

  const rawTimeout = readEnv("TIMEOUT_MS") || String(file.timeoutMs ?? "");
  const timeoutMs = rawTimeout && Number.isFinite(Number(rawTimeout)) ? Number(rawTimeout) : undefined;
  const rawShellTimeout = readEnv("SHELL_TIMEOUT_SEC") || String(file.shellTimeoutSec ?? "");
  const shellTimeoutSec =
    rawShellTimeout && Number.isFinite(Number(rawShellTimeout)) ? Number(rawShellTimeout) : undefined;

  const basePrompt = readEnv("SYSTEM_PROMPT") || file.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const agentsMd = loadAgentsFile(workspaceRoot);
  const folderName = basename(workspaceRoot);
  const workspaceContext = `## Current Workspace Context\n- Workspace Name: ${folderName}\n- Workspace Root Directory: ${workspaceRoot}`;
  const systemPrompt = agentsMd
    ? `${basePrompt}\n\n${workspaceContext}\n\n## Project Rules\n\n${agentsMd}`
    : `${basePrompt}\n\n${workspaceContext}`;

  const rawMaxActiveTools = readEnv("MAX_ACTIVE_TOOLS") || String(file.maxActiveTools ?? "");
  const maxActiveTools =
    rawMaxActiveTools && Number.isFinite(Number(rawMaxActiveTools)) ? Number(rawMaxActiveTools) : undefined;
  // Default to "hybrid": pure heuristic keyword/tag scoring can't tell that
  // e.g. "what does the map method do" needs search_docs — its content words
  // ("map", "method") don't appear in any tool's own name/tags/description.
  // Hybrid tries heuristic first and falls back to a real quick-tier model
  // classification call when heuristic is weak/ambiguous.
  const toolSelectionMode = (readEnv("TOOL_SELECTION_MODE") || file.toolSelectionMode || "hybrid") as
    "heuristic" | "llm" | "hybrid";

  // Pool of Ollama Cloud keys: primary single key, comma-separated OLLAMA_API_KEYS,
  // and any keys listed in the config file, deduped in that priority order.
  // OLLAMA_* are provider-convention variables, not product variables — they
  // keep their upstream names (see docs/REBRANDING.md §3).
  const primaryApiKey = process.env.OLLAMA_API_KEY || file.apiKey;
  const envKeys = (process.env.OLLAMA_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const apiKeys = [...new Set([...(primaryApiKey ? [primaryApiKey] : []), ...envKeys, ...(file.apiKeys ?? [])])];

  // Number() on a malformed value yields NaN, which is not nullish and so
  // sails straight past every `?? default` downstream. Validate here instead.
  const positiveNumber = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const selfConsistencyN = positiveNumber(readEnv("SC_N") || String(file.selfConsistencyN ?? ""), 3);
  const selfConsistencyThreshold = positiveNumber(
    readEnv("SC_THRESHOLD") || String(file.selfConsistencyThreshold ?? ""),
    0.5,
  );
  const availabilityCheckTtlMs = positiveNumber(
    readEnv("AVAIL_TTL_MS") || String(file.availabilityCheckTtlMs ?? ""),
    86_400_000,
  );

  const inputPerMillion = Number(readEnv("PRICE_INPUT_PER_M") || String(file.pricing?.inputPerMillion ?? ""));
  const outputPerMillion = Number(readEnv("PRICE_OUTPUT_PER_M") || String(file.pricing?.outputPerMillion ?? ""));
  const pricing =
    Number.isFinite(inputPerMillion) &&
    Number.isFinite(outputPerMillion) &&
    (inputPerMillion > 0 || outputPerMillion > 0)
      ? { inputPerMillion, outputPerMillion }
      : undefined;

  const tier: CliConfig["tier"] = (readEnv("TIER") || file.tier) === "cloud" ? "cloud" : "local";

  // Theme: env var wins, then config file; unknown values fall back to
  // "default" so a typo can never crash the TUI on startup.
  const rawTheme = (readEnv("THEME") || file.theme || "").trim().toLowerCase();
  const theme = (THEME_ORDER as readonly string[]).includes(rawTheme) ? (rawTheme as ThemeName) : undefined;

  return {
    model: readEnv("MODEL") || file.model || "qwen3.5:4b",
    workspaceRoot,
    tier,
    theme,
    // OLLAMA_HOST is the local-Ollama convention, so it only applies to the
    // local tier. It used to be returned regardless, which meant a user with
    // OLLAMA_HOST set (normal for a local Ollama install) who switched to
    // NEXUM_TIER=cloud silently sent Cloud requests -- Bearer token and all
    // -- to their own localhost. An explicit `host` in config still wins for
    // either tier, since that is a deliberate choice.
    host: file.host || (tier === "local" ? process.env.OLLAMA_HOST : undefined),
    apiKey: primaryApiKey,
    timeoutMs,
    systemPrompt,
    shellImage: readEnv("SHELL_IMAGE") || file.shellImage,
    shellTimeoutSec,
    sandbox: readEnvFlag("SANDBOX", file.sandbox ?? true),
    toolSelectionMode,
    maxActiveTools,
    apiKeys: apiKeys.length ? apiKeys : undefined,
    quickModel: readEnv("QUICK_MODEL") || file.quickModel,
    // Hybrid architecture flags
    enableLocalWorker: readEnvFlag("LOCAL_WORKER", file.enableLocalWorker ?? true),
    // An explicit env value wins in BOTH directions. The previous
    // `env === "true" || file` form meant NEXUM_VERIFIER=false could not
    // switch off a config-file `true`, which is the opposite of how every
    // sibling flag here behaves.
    enableVerifier: readEnvFlag("VERIFIER", file.enableVerifier ?? false),
    enableSelfConsistency: readEnvFlag("SELF_CONSISTENCY", file.enableSelfConsistency ?? false),
    selfConsistencyN,
    selfConsistencyThreshold,
    availabilityCheckTtlMs,
    enableAvailabilityCheck: readEnvFlag("AVAIL_CHECK", file.enableAvailabilityCheck ?? true),
    enableHeuristicGate: readEnvFlag("HEURISTIC_GATE", file.enableHeuristicGate ?? true),
    autoApprove: readEnvFlag("AUTO_APPROVE", file.autoApprove ?? false),
    pricing,
    mcpServers: file.mcpServers,
  };
}
