/**
 * ProcessPack (review item 21) — process execution surface.
 *
 * shell (Docker-sandboxed, high-risk), docker management, and project
 * lifecycle runners (tests/lint/format/build). The legacy shellPack /
 * dockerPack / projectPack factories remain as compat exports.
 */

import { ShellTool } from "../shell.js";
import { DockerTool, type DockerToolOptions } from "../docker-tools.js";
import { RunTestsTool, RunLintTool, RunFormatTool, RunBuildTool } from "../project-tools.js";
import { ToolPack, ToolPackEntry, packOf } from "../gateway/tool-pack.js";
import type { LegacyToolMetadata } from "../gateway/tool-catalog.js";
import type { ToolRisk } from "../../core/tools/tool-contract.js";
import { ShellExecutionAccountant } from "../shell-accounting.js";
import type { CommandRunner } from "../command-runner.js";

export type PackShellOutput = (stream: "stdout" | "stderr", chunk: string) => void;

/** True only when commands go through a Docker-sandboxed ShellTool. */
export function runsSandboxed(runner: CommandRunner | undefined): boolean {
  return (runner as { sandbox?: unknown } | undefined)?.sandbox === true;
}

const SHELL_SIDE_EFFECTS = { filesystem: true, process: true, network: true };

/** Metadata for run_shell: on the host (sandbox disabled) every command needs a human's confirmation. */
export function shellMetadata(sandboxed: boolean): LegacyToolMetadata {
  return sandboxed
    ? { risk: "high", sideEffects: SHELL_SIDE_EFFECTS, execution: { isolation: "sandbox" } }
    : {
        risk: "high",
        sideEffects: SHELL_SIDE_EFFECTS,
        policy: { confirmation: "required" },
        execution: { isolation: "host" },
      };
}

/** Metadata for script runners (package.json / bundle): host execution needs confirmation too. */
export function scriptRunnerMetadata(sandboxed: boolean): LegacyToolMetadata {
  return sandboxed
    ? { risk: "medium" }
    : {
        risk: "high",
        sideEffects: SHELL_SIDE_EFFECTS,
        policy: { confirmation: "required" },
        execution: { isolation: "host" },
      };
}

export interface ProcessPackOptions {
  root: string;
  onOutput?: PackShellOutput;
  /** Resource accounting (review item 27) — tracked + persisted per execution. */
  accountant?: ShellExecutionAccountant;
  sandbox?: boolean;
  image?: string;
  timeoutSec?: number;
  /** Directory the sandbox may write to (rest of the workspace read-only). */
  writeScope?: string;
}

/**
 * ProcessPack — every process-spawning tool in one mountable pack
 * (review item 21): run_shell (sandboxed), docker, test/lint/format/build
 * runners.
 */
export function processPack(opts: ProcessPackOptions): ToolPack {
  const shell = new ShellTool({
    workspaceRoot: opts.root,
    onOutput: opts.onOutput,
    accountant: opts.accountant,
    sandbox: opts.sandbox,
    image: opts.image,
    timeoutSec: opts.timeoutSec,
    writeScope: opts.writeScope,
  });
  const entries: ToolPackEntry[] = [
    {
      tool: shell,
      category: "Shell",
      metadata: shellMetadata(shell.sandbox),
    },
    {
      tool: new DockerTool(opts.root),
      category: "Docker",
      metadata: { risk: "high" as ToolRisk, sideEffects: { process: true, network: true } },
    },
    ...[
      new RunTestsTool(opts.root, shell),
      new RunLintTool(opts.root, shell),
      new RunFormatTool(opts.root, shell),
      new RunBuildTool(opts.root, shell),
    ].map((tool) => ({
      tool,
      category: "Project",
      metadata: scriptRunnerMetadata(shell.sandbox),
    })),
  ];
  return packOf(
    "process",
    "Process execution: sandboxed shell, docker, tests/lint/format/build.",
    "process",
    entries,
    "Process",
  );
}

// ── compat factories (same behavior as pre-split packs) ──────────────────────

/** @deprecated mount processPack instead (review item 21). */
export function shellPack(
  root: string,
  onOutput?: PackShellOutput,
  shellOpts?: { sandbox?: boolean; image?: string; timeoutSec?: number; writeScope?: string },
): ToolPack {
  const opts: ConstructorParameters<typeof ShellTool>[0] = { workspaceRoot: root, ...shellOpts };
  if (onOutput) opts.onOutput = onOutput;
  const shell = new ShellTool(opts);
  return packOf(
    "shell",
    shell.sandbox ? "Shell command execution (Docker-sandboxed when available)." : "Shell command execution (host).",
    "process",
    [[shell, shellMetadata(shell.sandbox)]],
    "Shell",
  );
}

/** @deprecated mount processPack instead (review item 21). */
export function dockerPack(root: string, opts: DockerToolOptions = {}): ToolPack {
  return packOf(
    "docker",
    "Docker container management.",
    "devops",
    [[new DockerTool(root, opts), { risk: "high", sideEffects: { process: true, network: true } }]],
    "Docker",
  );
}

/** @deprecated mount processPack instead (review item 21). */
/** `runner` (e.g. the sandboxed ShellTool) executes the scripts; without it they run on the host. */
export function projectPack(root: string, runner?: CommandRunner): ToolPack {
  return packOf(
    "project",
    "Project lifecycle: tests, lint, format, build.",
    "build",
    [
      new RunTestsTool(root, runner),
      new RunLintTool(root, runner),
      new RunFormatTool(root, runner),
      new RunBuildTool(root, runner),
    ].map((tool) => ({
      tool,
      category: "Project",
      metadata: scriptRunnerMetadata(runsSandboxed(runner)),
    })),
    "Project",
  );
}
