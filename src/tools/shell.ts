import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  findSensitivePaths,
  secretInodes,
  SensitiveScanLimitError,
  type SensitiveEntry,
} from "../core/fs/sensitive-scan.js";
import { Tool } from "./tool.js";
import { BRAND } from "../platform/brand.js";
import type { ToolCallContext } from "../core/tools/tool-contract.js";
import { ShellExecutionAccountant } from "./shell-accounting.js";
import { hostEnv } from "./command-runner.js";

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
  /**
   * Directory (inside the workspace) the sandbox may write to. When set, the
   * rest of the workspace is mounted read-only. Unset = whole workspace writable.
   */
  writeScope?: string;
}

export class SandboxScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxScanError";
  }
}

/** One `--mount` field, CSV-quoted as docker's --mount parser expects when it contains , or ". */
function mountField(key: string, value: string): string {
  const field = `${key}=${value}`;
  return /[",\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
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
  private readonly writeScope?: string;
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
    this.writeScope = opts.writeScope;
  }

  get name(): string {
    return "run_shell";
  }

  get description(): string {
    return this.sandbox
      ? "Run a shell command inside an isolated Docker sandbox (no network) rooted at the workspace. Secret files (.env, keys, secrets/) read as empty, and .git hooks/config are read-only."
      : "Run a shell command directly on the HOST (no sandbox) in the workspace. Every command needs human confirmation; credential environment variables are removed.";
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

    let dockerArgs: string[] | undefined;
    if (container) {
      try {
        dockerArgs = this.dockerArgs(container, command, timeoutSec);
      } catch (e) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          truncated: false,
          error: e instanceof SandboxScanError ? "SandboxScanError" : "SandboxSetupError",
        };
      }
    }

    return new Promise((resolvePromise) => {
      const child = dockerArgs
        ? spawn("docker", dockerArgs)
        : spawn("sh", ["-c", command], { cwd: this.root, env: hostEnv() });
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
            truncated: stdout.byteLength > ShellTool.MAX_OUTPUT_BYTES || stderr.byteLength > ShellTool.MAX_OUTPUT_BYTES,
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
        finish({
          exitCode: -1,
          stdout: "",
          stderr: `failed to spawn ${this.sandbox ? "docker" : "process"}: ${err.message}`,
          truncated: false,
        });
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

  /**
   * `docker run` arguments. Hardening: host uid (no root), all capabilities
   * dropped, no-new-privileges, read-only root filesystem, no network, and
   * workspace mounts that keep secrets and git hook/config out of reach.
   */
  private dockerArgs(container: string, command: string, timeoutSec?: number): string[] {
    const effective = timeoutSec ?? this.timeoutSec;
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    return [
      "run",
      "--rm",
      "--name",
      container,
      "--network=none",
      `--memory=${this.memory}`,
      `--cpus=${this.cpus}`,
      "--pids-limit=128",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=512m",
      "-e",
      "HOME=/tmp",
      ...(uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : []),
      ...this.workspaceMounts(),
      "-w",
      "/workspace",
      this.image,
      "timeout",
      String(effective),
      "sh",
      "-c",
      command,
    ];
  }

  /**
   * Mounts, in override order (later wins):
   *   1. the workspace — read-write, or read-only when a write scope is set
   *   2. the write scope — read-write
   *   3. .git/hooks and .git/config — read-only (a planted hook or
   *      core.fsmonitor would otherwise run on the HOST at the next git call)
   *   4. every sensitive file (masked with /dev/null) and directory (masked
   *      with an empty tmpfs), so `cat .env` in the sandbox reads nothing
   */
  private workspaceMounts(): string[] {
    const root = realOrResolved(this.root);
    const toContainer = (hostPath: string) => {
      const rel = relative(root, hostPath).split(sep).join("/");
      return rel ? posix.join("/workspace", rel) : "/workspace";
    };
    const bind = (source: string, target: string, readonly: boolean) => [
      "--mount",
      ["type=bind", mountField("source", source), mountField("target", target), ...(readonly ? ["readonly"] : [])].join(
        ",",
      ),
    ];

    const scope = this.writeScope ? realOrResolved(this.writeScope) : undefined;
    const scopeInside = scope !== undefined && isWithin(root, scope);
    const args = bind(root, "/workspace", scope !== undefined);
    if (scope && scopeInside && existsSync(scope)) args.push(...bind(scope, toContainer(scope), false));

    for (const internal of [join(root, ".git", "hooks"), join(root, ".git", "config")]) {
      if (existsSync(internal) && !lstatSync(internal).isSymbolicLink()) {
        args.push(...bind(internal, toContainer(internal), true));
      }
    }

    let secrets: SensitiveEntry[];
    try {
      secrets = findSensitivePaths(root, root, undefined, { aliasInodes: secretInodes(root) });
    } catch (e) {
      if (e instanceof SensitiveScanLimitError) {
        throw new SandboxScanError(
          `workspace has more than ${e.limit} entries; refusing to start the sandbox without a complete secret scan`,
        );
      }
      throw e;
    }
    for (const secret of secrets) {
      const target = toContainer(secret.path);
      if (secret.dir) {
        args.push(
          "--mount",
          ["type=tmpfs", mountField("target", target), "tmpfs-size=4096", "tmpfs-mode=0500"].join(","),
        );
      } else {
        args.push(...bind("/dev/null", target, true));
      }
    }
    return args;
  }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}
