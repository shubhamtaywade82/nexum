import { Tool } from "../../tools/tool.js";
import { assertNotOption, runCommand, type CommandRunner } from "../../tools/command-runner.js";

export class RunRubocopTool extends Tool {
  /** `runner` executes RuboCop (the Docker sandbox when enabled); without one it runs on the host. */
  constructor(
    private readonly root: string,
    private readonly runner?: CommandRunner,
  ) {
    super();
  }

  get name(): string {
    return "run_rubocop";
  }

  get description(): string {
    return "Run RuboCop linting on the Ruby project. Optionally target a specific file or directory.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to a file or directory to lint. Omit to lint the whole project.",
        },
        autoCorrect: {
          type: "boolean",
          description: "Apply auto-correctable fixes (--auto-correct).",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = args.path as string | undefined;
    const autoCorrect = args.autoCorrect === true;

    try {
      assertNotOption(target, "path");
    } catch (e) {
      return { error: "ArgumentError", message: (e as Error).message };
    }

    const ruboCopArgs = ["exec", "rubocop", "--format", "simple"];
    if (autoCorrect) ruboCopArgs.push("--auto-correct");
    if (target) ruboCopArgs.push(target);

    const outcome = await runCommand({
      root: this.root,
      bin: "bundle",
      args: ruboCopArgs,
      timeoutSec: 60,
      hostTimeoutMs: 60_000,
      runner: this.runner,
    });
    if (outcome.exitCode === -1 && !outcome.stdout) {
      return { exitCode: -1, stdout: "", stderr: outcome.stderr, offenseCount: 0, corrected: 0 };
    }
    const offenseCount = parseRubocopOffenses(outcome.stdout, outcome.stderr);
    return {
      command: `bundle exec rubocop${autoCorrect ? " --auto-correct" : ""}${target ? ` ${target}` : ""}`,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      offenseCount,
      corrected: autoCorrect ? offenseCount.corrected : 0,
    };
  }
}

interface RubocopOffenseCount {
  total: number;
  corrected: number;
}

function parseRubocopOffenses(stdout: string, stderr: string): RubocopOffenseCount {
  const combined = stdout + "\n" + stderr;
  // RuboCop summary line: "X offenses detected, Y offenses corrected"
  const summary = /(\d+)\s+offense(?:s)?\s+detected/.exec(combined);
  const corrected = /(\d+)\s+offense(?:s)?\s+corrected/.exec(combined);
  return {
    total: summary ? parseInt(summary[1], 10) : 0,
    corrected: corrected ? parseInt(corrected[1], 10) : 0,
  };
}
