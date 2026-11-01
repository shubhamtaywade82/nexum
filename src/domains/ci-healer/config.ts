import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";

/**
 * Config file for the healer. Keys match the Ruby tool, so one JSON file works for
 * both. Every field is validated; a missing or unsafe value fails at startup.
 */

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

const positiveInt = z.number().int().positive();
const pathString = z.string().min(1).transform(expandHome);
const stringArray = z.array(z.string());

const condenserSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("deterministic") }),
    z.object({
      type: z.literal("ollama"),
      url: z.url().default("http://127.0.0.1:11434"),
      model: z.string().min(1),
      timeout_sec: positiveInt.default(60),
    }),
  ])
  .default({ type: "deterministic" });

/**
 * Where repo-controlled setup and verify commands run. "docker" is the default and
 * uses a container with no host home, no credentials, and (for verify) no network.
 * "host" runs unsandboxed and must be acknowledged explicitly.
 */
const sandboxSchema = z
  .object({
    mode: z.enum(["docker", "host"]).default("docker"),
    image: z.string().min(1).default("nexum-sandbox:latest"),
    memory: z
      .string()
      .regex(/^\d+[bkmg]?$/i, "memory must look like 512m or 2g")
      .default("2g"),
    cpus: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "cpus must be a number")
      .default("2"),
    pids_limit: positiveInt.default(256),
    /** Setup installs dependencies and needs a network. Verify always runs with none. */
    setup_network: z.enum(["bridge", "none"]).default("bridge"),
    acknowledge_host_execution: z.boolean().default(false),
  })
  .default({
    mode: "docker",
    image: "nexum-sandbox:latest",
    memory: "2g",
    cpus: "2",
    pids_limit: 256,
    setup_network: "bridge",
    acknowledge_host_execution: false,
  })
  .superRefine((sandbox, context) => {
    if (sandbox.mode === "host" && !sandbox.acknowledge_host_execution) {
      context.addIssue({
        code: "custom",
        message: "sandbox.mode=host runs repository code unsandboxed; set sandbox.acknowledge_host_execution to true",
        path: ["acknowledge_host_execution"],
      });
    }
  });

/**
 * Ordered runtime chain for the repair agent. The first candidate that completes
 * wins. A candidate in cooldown is skipped. Free-tier routing is expressed here as
 * ordered (runtime, model) entries, for example a free hosted model first and a
 * local Ollama model after it.
 */
const runtimeSchema = z.discriminatedUnion("runtime", [
  z.object({ runtime: z.literal("nexum") }),
  z.object({
    runtime: z.literal("opencode"),
    model: z.string().min(1, "opencode entries need a provider/model string"),
    binary: z.string().min(1).default("opencode"),
  }),
  z.object({
    runtime: z.literal("agy"),
    binary: z.string().min(1).default("agy"),
  }),
]);

const schema = z.object({
  repo: z.object({
    slug: z.string().regex(SLUG, "repo.slug must look like owner/name"),
    dir: pathString,
  }),
  state_file: pathString.default(expandHome("~/.local/share/ci-healer/ci-healer.db")),
  kill_switch_file: pathString.default(expandHome("~/.local/share/ci-healer/DISABLED")),
  worktree_base: pathString.default("/tmp/ci-healer-worktrees"),
  nexum_command: z.array(z.string().min(1)).min(1, "nexum_command must not be empty").default(["nexum"]),
  nexum_timeout_sec: positiveInt.default(1800),
  agent_chain: z
    .array(runtimeSchema)
    .min(1)
    .default([{ runtime: "nexum" }]),
  setup_commands: stringArray.default([]),
  setup_timeout_sec: positiveInt.default(900),
  verify_commands: z
    .array(z.string().trim().min(1))
    .min(1, "verify_commands must be non-empty: unverified patches are never pushed"),
  verify_timeout_sec: positiveInt.default(900),
  sandbox: sandboxSchema,
  max_heal_attempts_per_lineage: z.number().int().min(1).max(10).default(3),
  max_heals_per_tick: positiveInt.default(1),
  max_open_prs_per_base: positiveInt.default(1),
  max_changed_files: positiveInt.default(10),
  /** Recent runs fetched per branch head. */
  run_scan_limit: positiveInt.default(30),
  /** Branches scanned per tick. The default branch is always scanned. The rest rotate. */
  max_branches_per_tick: positiveInt.default(20),
  log_byte_cap: positiveInt.default(2_000_000),
  forbidden_paths: stringArray.default([".github/workflows/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"]),
  git_author: z
    .object({ name: z.string().min(1), email: z.string().min(1) })
    .default({ name: "ci-healer", email: "ci-healer@localhost" }),
  condenser: condenserSchema,
  /** Extra environment variable names passed to the agent (for example provider API keys). GitHub and SSH names are always denied. */
  agent_env_allow: stringArray.default([]),
  /** Must exceed the longest tick, or another worker may take the lease mid-run. */
  lease_ttl_sec: positiveInt.default(7200),
  /** Cooldown after a rate-limit error from a runtime. */
  runtime_rate_limit_cooldown_sec: positiveInt.default(1800),
  /** Consecutive failures that open the circuit breaker for a runtime. */
  runtime_breaker_threshold: positiveInt.default(3),
  runtime_breaker_cooldown_sec: positiveInt.default(900),
});

export type RawHealerConfig = z.output<typeof schema>;

export interface HealerConfig extends RawHealerConfig {
  /** Last path segment of repo.slug, used in worktree names. */
  repo_name: string;
}

export function parseConfig(raw: unknown): HealerConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(message);
  }
  const config = result.data;
  if (!existsSync(join(config.repo.dir, ".git"))) {
    throw new ConfigError(`repo.dir is not a git checkout: ${config.repo.dir}`);
  }
  return { ...config, repo_name: basename(config.repo.slug) };
}

export function loadConfig(path: string): HealerConfig {
  let text: string;
  try {
    text = readFileSync(expandHome(path), "utf8");
  } catch {
    throw new ConfigError(`config file not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(`config is not valid JSON (${path}): ${(error as Error).message}`);
  }
  return parseConfig(raw);
}
