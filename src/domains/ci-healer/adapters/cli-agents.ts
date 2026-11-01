import type { AgentOutcome, AgentPort, CommandPort } from "../application/ports.js";

const OUTPUT_TAIL_BYTES = 8_000;

export interface CliAgentOptions {
  name: string;
  command: CommandPort;
  binary: string;
  /** Argument vector after the binary, built from the goal. */
  args: (goal: string) => string[];
  timeoutMs: number;
  /** The agent environment policy result. */
  env: Record<string, string>;
}

/**
 * Runs a headless coding CLI in the workspace. "completed" means exit status 0. The
 * CLI's own JSON is not parsed: its schema is not a stable contract, and the verify
 * gate is the authority on whether the change works.
 */
export class CliAgent implements AgentPort {
  constructor(private readonly options: CliAgentOptions) {}

  async execute(input: { workspace: string; goal: string }): Promise<AgentOutcome> {
    const { name, command, binary, args, timeoutMs, env } = this.options;
    const result = await command.run([binary, ...args(input.goal)], {
      cwd: input.workspace,
      timeoutMs,
      env,
      allowFailure: true,
    });
    const output = tail(result.stdout);
    if (result.status === 0) return { status: "completed", output, runtime: name };
    const stderr = tail(result.stderr).trim();
    return {
      status: "failed",
      output,
      error: stderr.length > 0 ? stderr : `${binary} exited ${result.status}`,
      runtime: name,
    };
  }
}

/**
 * OpenCode in non-interactive mode: `opencode run --model <provider/model> --format json <goal>`.
 * Provider credentials must be listed in agent_env_allow. Verify with `opencode --help`
 * on the installed version, because flags can change between releases.
 */
export function openCodeAgent(options: {
  model: string;
  binary: string;
  command: CommandPort;
  timeoutMs: number;
  env: Record<string, string>;
}): CliAgent {
  return new CliAgent({
    name: `opencode:${options.model}`,
    command: options.command,
    binary: options.binary,
    args: (goal) => ["run", "--model", options.model, "--format", "json", goal],
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
}

/**
 * Antigravity in headless print mode: `agy -p <goal> --output-format json`. It needs
 * cached credentials from an interactive sign-in, which live under HOME. That is a
 * deliberate exposure, so this runtime is opt-in. No permission-bypass flag is passed:
 * commands that need approval are denied, and verification then decides the outcome.
 */
export function antigravityAgent(options: {
  binary: string;
  command: CommandPort;
  timeoutMs: number;
  env: Record<string, string>;
}): CliAgent {
  return new CliAgent({
    name: "agy",
    command: options.command,
    binary: options.binary,
    args: (goal) => ["-p", goal, "--output-format", "json"],
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
}

function tail(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= OUTPUT_TAIL_BYTES ? text : bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8");
}
