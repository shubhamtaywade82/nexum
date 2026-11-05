import { Tool } from "../../tools/tool.js";
import { assertNotOption, runCommand, type CommandRunner } from "../../tools/command-runner.js";

const RSPEC_FORMATS = new Set(["progress", "documentation", "json", "junit"]);

export class RunRSpecTool extends Tool {
  /** `runner` executes RSpec (the Docker sandbox when enabled); without one it runs on the host. */
  constructor(
    private readonly root: string,
    private readonly runner?: CommandRunner,
  ) {
    super();
  }

  get name(): string {
    return "run_rspec";
  }

  get description(): string {
    return "Run RSpec tests. Optionally target a specific file, directory, or line number.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to a spec file or directory. Omit to run the full suite.",
        },
        line: {
          type: "number",
          description: "Line number for focused run (appended as `:line` to path).",
        },
        format: {
          type: "string",
          enum: ["progress", "documentation", "json", "junit"],
          description: "Output format (default: documentation).",
        },
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = args.path as string | undefined;
    const line = args.line as number | undefined;
    const format = (args.format as string) || "documentation";

    try {
      assertNotOption(target, "path");
    } catch (e) {
      return { error: "ArgumentError", message: (e as Error).message };
    }
    if (!RSPEC_FORMATS.has(format)) {
      return { error: "ArgumentError", message: `format must be one of ${[...RSPEC_FORMATS].join(", ")}` };
    }

    const rspecArgs = ["exec", "rspec", "--format", format];
    if (target) {
      rspecArgs.push(line ? `${target}:${line}` : target);
    }

    const outcome = await runCommand({
      root: this.root,
      bin: "bundle",
      args: rspecArgs,
      timeoutSec: 120,
      hostTimeoutMs: 120_000,
      runner: this.runner,
    });
    if (outcome.exitCode === -1 && !outcome.stdout) {
      return { exitCode: -1, stdout: "", stderr: outcome.stderr, examples: 0, failures: 0, pending: 0, duration: 0 };
    }
    return {
      command: `bundle exec rspec --format ${format}${target ? ` ${target}${line ? `:${line}` : ""}` : ""}`,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      ...parseRSpecSummary(outcome.stdout, outcome.stderr),
    };
  }
}

interface RSpecSummary {
  examples: number;
  failures: number;
  pending: number;
  duration: number;
}

function parseRSpecSummary(stdout: string, stderr: string): RSpecSummary {
  const combined = stdout + "\n" + stderr;
  // "X examples, Y failures, Z pending"
  const summary = /(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending?)?/.exec(combined);
  // "Finished in X.Y seconds"
  const finished = /Finished\s+in\s+([\d.]+)\s+seconds?/.exec(combined);

  return {
    examples: summary ? parseInt(summary[1], 10) : 0,
    failures: summary ? parseInt(summary[2], 10) : 0,
    pending: summary ? (summary[3] ? parseInt(summary[3], 10) : 0) : 0,
    duration: finished ? parseFloat(finished[1]) : 0,
  };
}
