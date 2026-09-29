import { spawn } from "node:child_process";

/** Executes a shell command string; ShellTool (sandboxed or host, per its config) satisfies this. */
export interface CommandRunner {
  call(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Environment variable names that carry credentials. */
const CREDENTIAL_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;

/**
 * The environment for commands run directly on the host: the parent's
 * environment minus credential-looking variables (the agent's own API keys,
 * tokens), so a script the agent wrote cannot read them from its env.
 */
export function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_ENV.test(name)));
}

/** POSIX single-quote an argument for `sh -c`. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Reject tool arguments that would be parsed as options (e.g. `--require /tmp/x.rb`). */
export function assertNotOption(value: string | undefined, field: string): void {
  if (value !== undefined && value.startsWith("-")) {
    throw new Error(`${field} must be a path, not an option: ${value}`);
  }
}

/**
 * Run `bin args…` in the workspace. With a runner the command goes through it
 * (the Docker sandbox when enabled); without one it spawns on the host.
 */
export function runCommand(opts: {
  root: string;
  bin: string;
  args: string[];
  timeoutSec: number;
  runner?: CommandRunner;
  hostTimeoutMs?: number;
}): Promise<CommandOutcome> {
  if (opts.runner) {
    const command = [opts.bin, ...opts.args].map(shellQuote).join(" ");
    return opts.runner.call({ command, timeoutSec: opts.timeoutSec }).then((r) => ({
      exitCode: typeof r.exitCode === "number" ? r.exitCode : -1,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      ...(typeof r.error === "string" ? { error: r.error } : {}),
    }));
  }
  return new Promise((resolvePromise) => {
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.root,
      env: hostEnv(),
      ...(opts.hostTimeoutMs ? { timeout: opts.hostTimeoutMs } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? -1, stdout, stderr }));
    child.on("error", (err) => resolvePromise({ exitCode: -1, stdout: "", stderr: err.message }));
  });
}
