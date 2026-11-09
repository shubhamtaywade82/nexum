/**
 * Execution profiles (review item 8) — the replacement for command
 * blacklists. Docker sandboxing stays; what changes is that every run
 * declares WHICH profile it executes under, and each profile defines
 * command, network, filesystem and resource permissions as data.
 *
 *   readonly    pure observation: no mutation, no process, no network tools
 *   development local building/editing: workspace writes, sandboxed shell
 *   testing     test suites and lint: workspace reads, sandboxed commands
 *   devops      container/build control: docker + package managers, restricted egress
 *   networked   network-dependent work: API tools, MCP, browser (restricted egress)
 *   production  widest powers + strictest confirmations: live trading, git push
 *
 * The PolicyEngine's ExecutionProfileRule evaluates every tool call
 * against the active profile; the shell sandbox reads the same profile to
 * configure the container (network mode, memory, cpus, pids, timeouts).
 */

import type { ToolRisk } from "../tools/tool-contract.js";

export type ExecutionProfileName = "readonly" | "development" | "testing" | "devops" | "networked" | "production";

export type CommandPermission =
  | "none" // no process spawning at all
  | "sandboxed" // docker container, network=none, resource caps
  | "workspace" // host process, cwd pinned to workspace, no root
  | "unrestricted"; // host process, no extra constraints (rare)

export type NetworkPermission =
  | "none" // no egress
  | "registry" // package registries only (npm, rubygems)
  | "allowlisted" // tool-declared egress domains only
  | "open"; // arbitrary egress (production networked agents)

export type FilesystemPermission =
  | "none" // no file reads or writes
  | "read" // workspace reads only
  | "workspace" // reads + writes inside the workspace (symlinks resolved)
  | "unrestricted"; // reads/writes anywhere the process can reach

export interface ResourceLimits {
  maxDurationSec: number;
  maxMemoryMb: number;
  maxCpus: number;
  maxPids: number;
  maxOutputBytes: number;
}

export interface ExecutionProfile {
  name: ExecutionProfileName;
  description: string;
  permissions: {
    commands: CommandPermission;
    network: NetworkPermission;
    filesystem: FilesystemPermission;
    resources: ResourceLimits;
  };
  /** Tools whose risk meets/exceeds this ceiling are denied outright. */
  riskCeiling: ToolRisk;
  /** Tools at/above this risk require human confirmation. */
  confirmationFloor: ToolRisk;
  /** May tools mutate state outside the workspace (git push, GitHub, MCP writes)? */
  allowExternalMutation: boolean;
  /** May tools move money / positions? */
  allowFinancial: boolean;
  /** Explicit tool deny list (pack-level overrides). */
  deniedTools: string[];
}

const DOCKER_DEFAULTS: ResourceLimits = {
  maxDurationSec: 1800,
  maxMemoryMb: 512,
  maxCpus: 1,
  maxPids: 128,
  maxOutputBytes: 32_768,
};

export const EXECUTION_PROFILES: Record<ExecutionProfileName, ExecutionProfile> = {
  readonly: {
    name: "readonly",
    description: "Pure observation: reads and searches only. No mutation, no processes, no network.",
    permissions: {
      commands: "none",
      network: "none",
      filesystem: "read",
      resources: { ...DOCKER_DEFAULTS, maxDurationSec: 60, maxMemoryMb: 256 },
    },
    riskCeiling: "low",
    confirmationFloor: "medium",
    allowExternalMutation: false,
    allowFinancial: false,
    deniedTools: ["run_shell", "docker", "binance_paper_trade"],
  },
  development: {
    name: "development",
    description: "Local building and editing: workspace writes, sandboxed shell, no external mutation.",
    permissions: {
      commands: "sandboxed",
      network: "registry",
      filesystem: "workspace",
      resources: DOCKER_DEFAULTS,
    },
    riskCeiling: "critical",
    confirmationFloor: "high",
    allowExternalMutation: false,
    allowFinancial: false,
    deniedTools: [],
  },
  testing: {
    name: "testing",
    description: "Test suites and linters: workspace reads, sandboxed commands, longer duration.",
    permissions: {
      commands: "sandboxed",
      network: "registry",
      filesystem: "read",
      resources: { ...DOCKER_DEFAULTS, maxDurationSec: 1800, maxMemoryMb: 1024, maxCpus: 2 },
    },
    riskCeiling: "high",
    confirmationFloor: "high",
    allowExternalMutation: false,
    allowFinancial: false,
    deniedTools: ["binance_paper_trade", "git"],
  },
  devops: {
    name: "devops",
    description: "Container and build control: docker, package managers, restricted egress.",
    permissions: {
      commands: "workspace",
      network: "registry",
      filesystem: "workspace",
      resources: { ...DOCKER_DEFAULTS, maxCpus: 2, maxMemoryMb: 1024 },
    },
    riskCeiling: "critical",
    confirmationFloor: "critical",
    allowExternalMutation: false,
    allowFinancial: false,
    deniedTools: [],
  },
  networked: {
    name: "networked",
    description: "Network-dependent agents: market data, MCP servers, browser; egress allowlisted per tool.",
    permissions: {
      commands: "sandboxed",
      network: "allowlisted",
      filesystem: "workspace",
      resources: DOCKER_DEFAULTS,
    },
    riskCeiling: "critical",
    confirmationFloor: "high",
    allowExternalMutation: true,
    allowFinancial: false,
    deniedTools: [],
  },
  production: {
    name: "production",
    description: "Live mutation powers (git push, trading): widest permissions, strictest confirmations.",
    permissions: {
      commands: "workspace",
      network: "open",
      filesystem: "workspace",
      resources: DOCKER_DEFAULTS,
    },
    riskCeiling: "critical",
    confirmationFloor: "critical",
    allowExternalMutation: true,
    allowFinancial: true,
    deniedTools: [],
  },
};

export function executionProfile(name: ExecutionProfileName): ExecutionProfile {
  return EXECUTION_PROFILES[name];
}

/** Profile from a free string (config/env); unknown → development (safe default). */
export function executionProfileByName(name: string | undefined): ExecutionProfile {
  if (name && name in EXECUTION_PROFILES) {
    return EXECUTION_PROFILES[name as ExecutionProfileName];
  }
  return EXECUTION_PROFILES.development;
}

/** Overlay: derive a narrower profile (never wider) from a base. */
export function restrictProfile(
  base: ExecutionProfile,
  overrides: Partial<
    Pick<
      ExecutionProfile,
      "riskCeiling" | "confirmationFloor" | "allowExternalMutation" | "allowFinancial" | "deniedTools" | "permissions"
    >
  >,
): ExecutionProfile {
  return {
    ...base,
    ...overrides,
    permissions: { ...base.permissions, ...(overrides.permissions ?? {}) },
    deniedTools: [...new Set([...base.deniedTools, ...(overrides.deniedTools ?? [])])],
  };
}

/**
 * Trading execution modes (review item 31) expressed as progressively
 * stricter profiles:
 *   research → readonly + market reads
 *   backtest → readonly + market history
 *   paper    → networked, financial allowed but paper-only executor
 *   shadow   → networked, live data, no order routing
 *   live     → production, financial allowed, hardest confirmations
 */
export type TradingExecutionMode = "research" | "backtest" | "paper" | "shadow" | "live";

export function tradingProfile(mode: TradingExecutionMode): ExecutionProfile {
  switch (mode) {
    case "research":
      return restrictProfile(EXECUTION_PROFILES.readonly, {
        permissions: { ...EXECUTION_PROFILES.readonly.permissions, network: "allowlisted" },
        riskCeiling: "medium",
      });
    case "backtest":
      return restrictProfile(EXECUTION_PROFILES.readonly, {
        permissions: { ...EXECUTION_PROFILES.readonly.permissions, network: "allowlisted" },
        riskCeiling: "medium",
        deniedTools: ["run_shell"],
      });
    case "paper":
      return restrictProfile(EXECUTION_PROFILES.networked, {
        allowFinancial: true,
        confirmationFloor: "critical",
        deniedTools: ["run_shell"],
      });
    case "shadow":
      return restrictProfile(EXECUTION_PROFILES.networked, {
        allowFinancial: false,
        confirmationFloor: "critical",
      });
    case "live":
      return EXECUTION_PROFILES.production;
  }
}
