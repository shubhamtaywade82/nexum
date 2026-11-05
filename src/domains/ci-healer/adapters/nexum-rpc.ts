import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentOutcome, AgentPort, Logger } from "../application/ports.js";
import { ProtocolError, TimeoutError } from "../errors.js";
import { killGroup } from "./command-runner.js";

const RPC_ID = 1;
const SHUTDOWN_GRACE_MS = 30_000;

export interface NexumRpcOptions {
  /** e.g. ["nexum"] or ["node", "/path/to/nexum/bin/cli.js"]. "rpc --workspace <dir>" is appended. */
  command: readonly string[];
  timeoutMs: number;
  /** The agent environment policy result. The child sees only this. */
  env: Record<string, string>;
  log: Logger;
}

/**
 * Drives `nexum rpc --workspace <dir>` over newline-delimited JSON-RPC 2.0 (see
 * src/cli/rpc.ts). One process per repair: send agent.execute, read the reply with
 * the matching id, then close stdin so the server calls stopHost() and exits.
 *
 * Non-JSON stdout (the plugin host logs to stdout) is ignored, not treated as a
 * protocol error.
 */
export class NexumRpcAgent implements AgentPort {
  constructor(private readonly options: NexumRpcOptions) {}

  async execute(input: { workspace: string; goal: string }): Promise<AgentOutcome> {
    const [bin, ...args] = [...this.options.command, "rpc", "--workspace", input.workspace];
    const child = spawn(bin, args, {
      cwd: input.workspace,
      env: this.options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    let exited = false;
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        exited = true;
        resolve();
      });
    });

    try {
      const outcome = await this.request(child, input.goal, closed);
      child.stdin!.end();
      await this.waitForExit(child, closed);
      return outcome;
    } finally {
      // Kill only a process that is still running. A dead pid can be reused.
      if (!exited) killGroup(child.pid, "SIGKILL");
      const tail = stderr.join("").trim().split("\n").slice(-20).join("\n");
      if (tail) this.options.log.debug("nexum stderr", { tail });
    }
  }

  private request(child: ChildProcess, goal: string, closed: Promise<void>): Promise<AgentOutcome> {
    return new Promise<AgentOutcome>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const timer = setTimeout(() => {
        lines.close();
        reject(new TimeoutError(`nexum rpc gave no agent.execute response within ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);

      lines.on("line", (line) => {
        const message = this.parse(line);
        if (!message || message.id !== RPC_ID) return;
        clearTimeout(timer);
        lines.close();
        try {
          resolve(toOutcome(message));
        } catch (error) {
          reject(error);
        }
      });
      void closed.then(() => {
        clearTimeout(timer);
        reject(new ProtocolError("nexum rpc closed stdout before answering"));
      });

      const request = { jsonrpc: "2.0", id: RPC_ID, method: "agent.execute", params: { goal } };
      child.stdin!.write(`${JSON.stringify(request)}\n`);
    });
  }

  private async waitForExit(child: ChildProcess, closed: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS);
    });
    const result = await Promise.race([closed.then(() => "closed" as const), timedOut]);
    clearTimeout(timer);
    if (result === "timeout") killGroup(child.pid, "SIGTERM");
  }

  private parse(line: string): Record<string, unknown> | undefined {
    try {
      const value: unknown = JSON.parse(line);
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      this.options.log.debug("non-JSON stdout from nexum ignored", { line: line.slice(0, 200) });
      return undefined;
    }
  }
}

function toOutcome(message: Record<string, unknown>): AgentOutcome {
  if (message.error !== undefined) {
    const error = message.error;
    const detail = error !== null && typeof error === "object" ? (error as { message?: unknown }).message : error;
    return { status: "failed", output: "", error: `rpc error: ${String(detail)}` };
  }
  const result = message.result;
  if (result === null || typeof result !== "object") {
    throw new ProtocolError("agent.execute reply has neither result nor error");
  }
  const fields = result as Record<string, unknown>;
  return {
    status: String(fields.status ?? ""),
    output: String(fields.output ?? ""),
    error: typeof fields.error === "string" ? fields.error : undefined,
  };
}
