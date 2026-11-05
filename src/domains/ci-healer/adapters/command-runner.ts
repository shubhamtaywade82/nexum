import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { CommandOptions, CommandPort, CommandResult } from "../application/ports.js";
import { CommandError, TimeoutError } from "../errors.js";

const KILL_GRACE_MS = 5_000;

/**
 * Runs argv arrays (never shell strings) in their own process group, so a timeout
 * kills the whole tree. `env` replaces the child's environment when given.
 */
export class NodeCommandRunner implements CommandPort {
  run(argv: readonly string[], options: CommandOptions): Promise<CommandResult> {
    const [bin, ...args] = argv;
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // The child may exit before reading stdin. That is not an error for us.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin ?? "");

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killGroup(child.pid, "SIGTERM");
        setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
        reject(new TimeoutError(`timed out after ${options.timeoutMs}ms: ${argv.slice(0, 3).join(" ")}`));
      }, options.timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new CommandError(argv, -1, error.message));
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const status = code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
        if (status !== 0 && !options.allowFailure) {
          reject(new CommandError(argv, status, stderr));
          return;
        }
        resolve({ status, stdout, stderr });
      });
    });
  }
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group already exited.
  }
}
