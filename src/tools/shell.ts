import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Tool } from "./tool.js";
import { BRAND } from "../platform/brand.js";
import type { ToolCallContext } from "../core/tools/tool-contract.js";
import { ShellExecutionAccountant } from "./shell-accounting.js";

export interface ShellToolOptions {
  workspaceRoot: string;
  image?: string;
  timeoutSec?: number;
  memory?: string;
  cpus?: string;
  logger?: Pick<Console, "info" | "warn">;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Lifecycle/resource accounting (review item 27): tracks container ID,
   * CPU/memory/PIDs limits + live samples, network mode, duration, output
   * bytes, exit status — and persists each execution's metadata.
   */
  accountant?: ShellExecutionAccountant;
  /** Whether to execute inside a Docker sandbox (default: true). Set false for direct host execution. */
  sandbox?: boolean;
}

export class ShellTool extends Tool {
  // Output feeds straight into the chat context as a tool-result message —
  // capped well below a byte size that alone could blow a model's context
  // window on a single tool call (unlike raw capture, this isn't for storage).
  static readonly MAX_OUTPUT_BYTES = 32 * 1024;
  static readonly DEFAULT_TIMEOUT_SEC = 30;
  static readonly DEFAULT_IMAGE = BRAND.sandboxImage;
  static readonly KILL_POLL_INTERVAL_MS = 300;
  static readonly KILL_ESCALATION_MS = 3000;

  readonly sandbox: boolean;
  private readonly root: string;
  private readonly image: string;
  private readonly timeoutSec: number;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly logger: Pick<Console, "info" | "warn">;
  private readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  private readonly accountant?: ShellExecutionAccountant;
  /** In-flight probe, so concurrent calls share one result instead of the
   * second racing past a half-finished check. */
  private dockerProbe: Promise<boolean> | null = null;
  private dockerAvailable: boolean | null = null;

  /** Upper bound on a model-supplied timeoutSec. Without a ceiling the model
   * could hand back a value that disables the sandbox's own time budget. */
  static readonly MAX_TIMEOUT_SEC = 1800;

  constructor(opts: ShellToolOptions) {
    super();
    this.sandbox = opts.sandbox ?? true;
    this.root = opts.workspaceRoot;
    this.image = opts.image ?? ShellTool.DEFAULT_IMAGE;
    this.timeoutSec = opts.timeoutSec ?? ShellTool.DEFAULT_TIMEOUT_SEC;
    this.memory = opts.memory ?? "512m";
    this.cpus = opts.cpus ?? "1";
    this.logger = opts.logger ?? console;
    this.onOutput = opts.onOutput;
    this.accountant = opts.accountant;
  }

  get name(): string {
    return "run_shell";
  }

  get description(): string {
    return this.sandbox
      ? "Run a shell command inside an isolated Docker sandbox rooted at the workspace."
      : "Run a shell command on the host rooted at the workspace.";
  }

  override get capabilities(): string[] {
    return ["Terminal"];
  }

  override get tags(): string[] {
    return ["execute", "run", "bash", "sh", "cmd", "command", "shell", "terminal"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutSec: { type: "number" },
      },
      required: ["command"],
    };
  }

  private ensureDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return Promise.resolve(this.dockerAvailable);
    // Share the in-flight probe rather than flipping a "checked" flag before
    // awaiting: that let a concurrent second call read the not-yet-written
    // default and skip the check entirely.
    if (this.dockerProbe) return this.dockerProbe;

    this.dockerProbe = new Promise<boolean>((resolveCheck) => {
      const probe = spawn("docker", ["info"]);
      probe.on("close", (code) => resolveCheck(code === 0));
      probe.on("error", () => resolveCheck(false));
    })
      .then((available) => {
        this.dockerAvailable = available;
        if (!available) {
          this.logger.warn("[ShellTool] docker is not available — run_shell will fail until it is");
        }
        return available;
      })
      .finally(() => {
        this.dockerProbe = null;
      });
    return this.dockerProbe;
  }

  /** Coerces a model-supplied timeoutSec into a usable number. It arrives as
   * untyped JSON: a string "30" made `(timeoutSec + 15) * 1000` evaluate to
   * 3015000 (50 minutes instead of 45s), and a non-numeric value produced NaN,
   * which makes setTimeout fire immediately so *every* run_shell returned
   * "sandbox exceeded hard timeout". */
  private resolveTimeoutSec(raw: unknown): number {
    const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(n) || n <= 0) return this.timeoutSec;
    return Math.min(Math.floor(n), ShellTool.MAX_TIMEOUT_SEC);
  }

  async call(args: Record<string, unknown>, callCtx?: ToolCallContext): Promise<Record<string, unknown>> {
    const command = args.command as string;
    const timeoutSec = this.resolveTimeoutSec(args.timeoutSec);

    if ((command ?? "").trim().length === 0) {
      return { exitCode: -1, stdout: "", stderr: "empty command", truncated: false, error: "EmptyCommandError" };
    }

    // Stay synchronous once the answer is known, so the child's listeners are
    // attached in the same tick as the call rather than a microtask later.
    if (this.sandbox) {
      const known = this.dockerAvailable;
      const dockerAvailable = known !== null ? known : await this.ensureDockerAvailable();
      if (!dockerAvailable) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: "docker is not available: dockerd is not reachable (is Docker running?)",
          truncated: false,
          error: "DockerUnavailableError",
        };
      }
    }

    const container = this.sandbox ? `nexum-${randomBytes(4).toString("hex")}` : undefined;

    // lifecycle accounting (review item 27): limits + live samples + duration
    // + output bytes + exit status, persisted on completion
    const record = this.accountant?.begin({
      containerId: container ?? "host",
      runId: callCtx?.runId,
      agentId: callCtx?.agentId,
      toolCallId: callCtx?.invocation?.id,
      command: String(command).slice(0, 500),
      cpuLimit: this.sandbox ? this.cpus : "host",
      memoryLimitMb: this.sandbox ? this.memory : "host",
      pidsLimit: 128,
      networkMode: this.sandbox ? "none" : "host",
      image: this.sandbox ? this.image : "host",
      timeoutSec,
    });
    const stopSampling = record && container ? this.accountant!.sampleContainer(record) : undefined;

    return new Promise((resolvePromise) => {
      const child = this.sandbox
        ? spawn("docker", this.dockerArgs(container!, command, timeoutSec))
        : spawn("sh", ["-c", command], { cwd: this.root });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let killedForOverflow = false;

      const killChild = () => {
        child.kill("SIGKILL");
        if (container) void this.escalateKill(container);
      };

      // cancellation reaches the process (review item 16): aborting the run's
      // signal kills the container/process instead of leaving it running to timeout
      const onAbort = () => {
        if (settled) return;
        killChild();
      };
      if (callCtx?.signal) {
        if (callCtx.signal.aborted) onAbort();
        else callCtx.signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        callCtx?.signal?.removeEventListener("abort", onAbort);
        if (record && this.accountant) {
          record.stdoutBytes = stdout.byteLength;
          record.stderrBytes = stderr.byteLength;
          this.accountant.complete(record, (payload.exitCode as number) ?? -1, payload.error as string | undefined);
          payload.execution = this.accountant.summarize(record);
        }
        stopSampling?.();
        resolvePromise(payload);
      };

      const checkOverflow = () => {
        if (killedForOverflow) return;
        if (stdout.byteLength + stderr.byteLength <= ShellTool.MAX_OUTPUT_BYTES) return;

        killedForOverflow = true;
        killChild();
        this.logger.warn(`[ShellTool] ${container ?? "host"} exceeded output ceiling — SIGKILL issued`);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        this.onOutput?.("stdout", chunk.toString("utf-8"));
        checkOverflow();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
        this.onOutput?.("stderr", chunk.toString("utf-8"));
        checkOverflow();
      });
      void record; // bytes are read from the closure buffers in finish()

      const hardTimeout = setTimeout(
        () => {
          if (settled) return;
          this.logger.warn(`[ShellTool] hard timeout on ${container ?? "host"}`);
          killChild();
          finish({
            exitCode: -1,
            stdout: stdout.subarray(0, ShellTool.MAX_OUTPUT_BYTES).toString("utf-8"),
            stderr:
              stderr.subarray(0, ShellTool.MAX_OUTPUT_BYTES).toString("utf-8") +
              `\n[exceeded hard timeout after ${timeoutSec}s]`,
            truncated:
              stdout.byteLength > ShellTool.MAX_OUTPUT_BYTES || stderr.byteLength > ShellTool.MAX_OUTPUT_BYTES,
            timeoutSec,
            error: "TimeoutError",
          });
        },
        (timeoutSec + 15) * 1000,
      );

      child.on("close", (exitCode) => {
        if (killedForOverflow) {
          finish({
            exitCode: exitCode ?? -1,
            stdout: stdout.subarray(0, ShellTool.MAX_OUTPUT_BYTES).toString("utf-8"),
            stderr: "output exceeded buffer ceiling; process killed",
            truncated: true,
            error: "BufferExceededError",
          });
          return;
        }

        this.logger.info(`[ShellTool] ${container ?? "host"} exited ${exitCode}`);
        finish({
          exitCode,
          stdout: stdout.subarray(0, ShellTool.MAX_OUTPUT_BYTES).toString("utf-8"),
          stderr: stderr.subarray(0, ShellTool.MAX_OUTPUT_BYTES).toString("utf-8"),
          truncated: stdout.byteLength > ShellTool.MAX_OUTPUT_BYTES || stderr.byteLength > ShellTool.MAX_OUTPUT_BYTES,
          timeoutSec,
        });
      });

      child.on("error", (err) => {
        finish({ exitCode: -1, stdout: "", stderr: `failed to spawn ${this.sandbox ? "docker" : "process"}: ${err.message}`, truncated: false });
      });
    });
  }

  private async escalateKill(container: string): Promise<void> {
    await this.runDocker(["kill", container]);

    const deadline = Date.now() + ShellTool.KILL_ESCALATION_MS;
    while (Date.now() < deadline) {
      if (!(await this.containerRunning(container))) return;
      await new Promise((r) => setTimeout(r, ShellTool.KILL_POLL_INTERVAL_MS));
    }

    if (await this.containerRunning(container)) {
      this.logger.warn(`[ShellTool] ${container} survived docker kill — escalating to rm -f`);
      await this.runDocker(["rm", "-f", container]);
    }
  }

  private runDocker(args: string[]): Promise<void> {
    return new Promise((resolveRun) => {
      const proc = spawn("docker", args);
      proc.on("close", () => resolveRun());
      proc.on("error", () => resolveRun());
    });
  }

  private containerRunning(container: string): Promise<boolean> {
    return new Promise((resolveCheck) => {
      const check = spawn("docker", ["inspect", "-f", "{{.State.Running}}", container]);
      let out = "";
      check.stdout.on("data", (c: Buffer) => (out += c.toString()));
      check.on("close", (code) => resolveCheck(code === 0 && out.trim() === "true"));
      check.on("error", () => resolveCheck(false));
    });
  }

  private dockerArgs(container: string, command: string, timeoutSec?: number): string[] {
    const effective = timeoutSec ?? this.timeoutSec;
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const wrappedCommand = `chown -R ${uid}:${gid} /workspace >/dev/null 2>&1 || true; ${command}`;
    return [
      "run",
      "--rm",
      "--name",
      container,
      "--network=none",
      `--memory=${this.memory}`,
      `--cpus=${this.cpus}`,
      "--pids-limit=128",
      "-v",
      `${resolve(this.root)}:/workspace:rw`,
      "-w",
      "/workspace",
      this.image,
      "timeout",
      String(effective),
      "sh",
      "-c",
      wrappedCommand,
    ];
  }
}
