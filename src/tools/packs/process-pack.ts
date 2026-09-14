/**
 * ProcessPack (review item 21) — process execution surface.
 *
 * shell (Docker-sandboxed, high-risk), docker management, and project
 * lifecycle runners (tests/lint/format/build). The legacy shellPack /
 * dockerPack / projectPack factories remain as compat exports.
 */

import { ShellTool } from "../shell.js";
import { DockerTool } from "../docker-tools.js";
import { RunTestsTool, RunLintTool, RunFormatTool, RunBuildTool } from "../project-tools.js";
import { ToolPack, ToolPackEntry, packOf } from "../gateway/tool-pack.js";
import type { ToolRisk } from "../../core/tools/tool-contract.js";
import { ShellExecutionAccountant } from "../shell-accounting.js";

export type PackShellOutput = (stream: "stdout" | "stderr", chunk: string) => void;

export interface ProcessPackOptions {
  root: string;
  onOutput?: PackShellOutput;
  /** Resource accounting (review item 27) — tracked + persisted per execution. */
  accountant?: ShellExecutionAccountant;
  sandbox?: boolean;
  image?: string;
  timeoutSec?: number;
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
  });
  const entries: ToolPackEntry[] = [
    {
      tool: shell,
      category: "Shell",
      metadata: { risk: "high" as ToolRisk, sideEffects: { filesystem: true, process: true, network: true } },
    },
    {
      tool: new DockerTool(opts.root),
      category: "Docker",
      metadata: { risk: "high" as ToolRisk, sideEffects: { process: true, network: true } },
    },
    ...[
      new RunTestsTool(opts.root),
      new RunLintTool(opts.root),
      new RunFormatTool(opts.root),
      new RunBuildTool(opts.root),
    ].map((tool) => ({
      tool,
      category: "Project",
      metadata: { risk: "medium" as ToolRisk },
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
  shellOpts?: { sandbox?: boolean; image?: string; timeoutSec?: number },
): ToolPack {
  const opts: ConstructorParameters<typeof ShellTool>[0] = { workspaceRoot: root, ...shellOpts };
  if (onOutput) opts.onOutput = onOutput;
  const shell = new ShellTool(opts);
  return packOf(
    "shell",
    shell.sandbox ? "Shell command execution (Docker-sandboxed when available)." : "Shell command execution (host).",
    "process",
    [[shell, { risk: "high", sideEffects: { filesystem: true, process: true, network: true } }]],
    "Shell",
  );
}

/** @deprecated mount processPack instead (review item 21). */
export function dockerPack(root: string): ToolPack {
  return packOf(
    "docker",
    "Docker container management.",
    "devops",
    [[new DockerTool(root), { risk: "high", sideEffects: { process: true, network: true } }]],
    "Docker",
  );
}

/** @deprecated mount processPack instead (review item 21). */
export function projectPack(root: string): ToolPack {
  return packOf(
    "project",
    "Project lifecycle: tests, lint, format, build.",
    "build",
    [new RunTestsTool(root), new RunLintTool(root), new RunFormatTool(root), new RunBuildTool(root)].map((tool) => ({
      tool,
      category: "Project",
      metadata: { risk: "medium" as ToolRisk },
    })),
    "Project",
  );
}
