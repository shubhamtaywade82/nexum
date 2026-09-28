import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Tool } from "./tool.js";
import { runCommand, type CommandRunner } from "./command-runner.js";

/** package.json scripts are arbitrary code the agent can edit: cap them like any shell run. */
const SCRIPT_TIMEOUT_SEC = 900;

async function detectPackageManager(root: string): Promise<"npm" | "pnpm" | "yarn"> {
  const check = async (file: string) => {
    try {
      await readFile(join(root, file));
      return true;
    } catch {
      return false;
    }
  };
  if (await check("pnpm-lock.yaml")) return "pnpm";
  if (await check("yarn.lock")) return "yarn";
  return "npm";
}

async function hasScript(root: string, scriptName: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.[scriptName]);
  } catch {
    return false;
  }
}

async function runScript(
  root: string,
  pm: "npm" | "pnpm" | "yarn",
  scriptName: string,
  runner?: CommandRunner,
): Promise<Record<string, unknown>> {
  const args = pm === "yarn" ? [scriptName] : ["run", scriptName];
  const outcome = await runCommand({ root, bin: pm, args, timeoutSec: SCRIPT_TIMEOUT_SEC, runner });
  return { command: `${pm} ${args.join(" ")}`, ...outcome };
}

abstract class ScriptRunnerTool extends Tool {
  protected abstract readonly scriptName: string;
  protected abstract readonly toolName: string;
  protected abstract readonly toolDescription: string;

  /** `runner` executes the script (the Docker sandbox when enabled); without one it runs on the host. */
  constructor(
    protected readonly root: string,
    private readonly runner?: CommandRunner,
  ) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  async call(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await hasScript(this.root, this.scriptName))) {
      return { error: "ScriptNotFoundError", message: `no "${this.scriptName}" script in package.json` };
    }
    const pm = await detectPackageManager(this.root);
    return runScript(this.root, pm, this.scriptName, this.runner);
  }
}

export class RunTestsTool extends ScriptRunnerTool {
  protected readonly scriptName = "test";
  protected readonly toolName = "run_tests";
  protected readonly toolDescription = 'Run the project\'s test suite via its package.json "test" script.';
}

export class RunLintTool extends ScriptRunnerTool {
  protected readonly scriptName = "lint";
  protected readonly toolName = "run_lint";
  protected readonly toolDescription = 'Run the project\'s linter via its package.json "lint" script.';
}

export class RunFormatTool extends ScriptRunnerTool {
  protected readonly scriptName = "format";
  protected readonly toolName = "run_format";
  protected readonly toolDescription = 'Run the project\'s formatter via its package.json "format" script.';
}

export class RunBuildTool extends ScriptRunnerTool {
  protected readonly scriptName = "build";
  protected readonly toolName = "run_build";
  protected readonly toolDescription = 'Run the project\'s build via its package.json "build" script.';
}
