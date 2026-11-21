/**
 * Agentic SDLC Kit Tools bridge.
 *
 * Exposes core SDLC methodology capabilities (repository stack inspection,
 * specification validation, implementation plan DAG verification, and
 * deterministic verification) from the Agentic SDLC Kit into Nexum's tool registry.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tool, ToolError } from "./tool.js";

/** Resolves the Agentic SDLC Kit CLI entrypoint from environment or standard paths. */
export function resolveKitCliPath(): string | null {
  const custom = process.env.AGENTIC_SDLC_KIT_PATH || process.env.NEXUM_SDLC_KIT_PATH;
  if (custom && existsSync(custom)) return custom;

  const candidate = join(homedir(), "projects/ai-agents/agentic-sdlc-kit/packages/cli/dist/index.js");
  if (existsSync(candidate)) return candidate;

  const cwdSibling = resolve(process.cwd(), "../../ai-agents/agentic-sdlc-kit/packages/cli/dist/index.js");
  if (existsSync(cwdSibling)) return cwdSibling;

  try {
    const fileSibling = resolve(
      fileURLToPath(import.meta.url),
      "../../../../../ai-agents/agentic-sdlc-kit/packages/cli/dist/index.js",
    );
    if (existsSync(fileSibling)) return fileSibling;
  } catch {
    // Non-file URL fallback
  }

  return null;
}

/** Spawns the kit CLI and captures structured stdout/stderr. */
export async function executeKitCommand(
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = resolveKitCliPath();
  if (!cliPath) {
    throw new ToolError("Agentic SDLC Kit CLI not found. Ensure agentic-sdlc-kit is installed and built.");
  }

  return new Promise((res, rej) => {
    const child = spawn("node", [cliPath, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rej(new ToolError(`kit command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rej(new ToolError(`Failed to run kit: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/** Parses JSON output from kit commands, falling back to a plain output wrapper. */
function parseKitOutput(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout);
  } catch {
    return { output: stdout.trim() };
  }
}

export class SdlcInspectTool extends Tool {
  constructor(private readonly workspaceRoot: string) {
    super();
  }

  get name(): string {
    return "sdlc_inspect";
  }

  get description(): string {
    return "Inspect a repository and report detected stacks, frameworks, package managers, test tools, entry points, and CI status.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to repository or workspace to inspect. Defaults to workspace root.",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = typeof args.path === "string" ? resolve(this.workspaceRoot, args.path) : this.workspaceRoot;
    const { stdout, stderr, exitCode } = await executeKitCommand(["inspect", target, "--json"], this.workspaceRoot);
    if (exitCode !== 0) throw new ToolError(`kit inspect failed: ${stderr || stdout}`);
    return parseKitOutput(stdout);
  }
}

export class SdlcValidateSpecTool extends Tool {
  constructor(private readonly workspaceRoot: string) {
    super();
  }

  get name(): string {
    return "sdlc_validate_spec";
  }

  get description(): string {
    return "Validate a feature specification against schema, quality, and risk invariants.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to specification file or directory. Defaults to docs/specifications.",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = typeof args.path === "string" ? resolve(this.workspaceRoot, args.path) : "docs/specifications";
    const { stdout, stderr, exitCode } = await executeKitCommand(
      ["validate-spec", target, "--json"],
      this.workspaceRoot,
    );
    if (exitCode !== 0) throw new ToolError(`kit validate-spec failed: ${stderr || stdout}`);
    return parseKitOutput(stdout);
  }
}

export class SdlcValidatePlanTool extends Tool {
  constructor(private readonly workspaceRoot: string) {
    super();
  }

  get name(): string {
    return "sdlc_validate_plan";
  }

  get description(): string {
    return "Validate an implementation plan against schema, DAG acyclicity, and task references.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to plan file or directory. Defaults to docs/plans.",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = typeof args.path === "string" ? resolve(this.workspaceRoot, args.path) : "docs/plans";
    const { stdout, stderr, exitCode } = await executeKitCommand(
      ["validate-plan", target, "--json"],
      this.workspaceRoot,
    );
    if (exitCode !== 0) throw new ToolError(`kit validate-plan failed: ${stderr || stdout}`);
    return parseKitOutput(stdout);
  }
}

export class SdlcVerifyTool extends Tool {
  constructor(private readonly workspaceRoot: string) {
    super();
  }

  get name(): string {
    return "sdlc_verify";
  }

  get description(): string {
    return "Execute deterministic verification commands (tests, lint, typecheck, build) defined in .ai-kit/project.yml.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to repository containing .ai-kit/project.yml. Defaults to workspace root.",
        },
        dryRun: {
          type: "boolean",
          description: "Inspect configured verification commands without running them.",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = typeof args.path === "string" ? resolve(this.workspaceRoot, args.path) : this.workspaceRoot;
    const cmdArgs = ["verify", target, "--json"];
    if (args.dryRun) cmdArgs.push("--dry-run");
    const { stdout, stderr, exitCode } = await executeKitCommand(cmdArgs, this.workspaceRoot);
    if (exitCode !== 0) throw new ToolError(`kit verify failed: ${stderr || stdout}`);
    return parseKitOutput(stdout);
  }
}

export class SdlcDoctorTool extends Tool {
  get name(): string {
    return "sdlc_doctor";
  }

  get description(): string {
    return "Check Agentic SDLC Kit toolchain and configuration health.";
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  async call(): Promise<Record<string, unknown>> {
    const { stdout, stderr, exitCode } = await executeKitCommand(["doctor"], process.cwd());
    if (exitCode !== 0) throw new ToolError(`kit doctor failed: ${stderr || stdout}`);
    return { status: "healthy", output: stdout.trim() };
  }
}
