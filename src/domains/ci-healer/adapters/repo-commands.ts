import { randomUUID } from "node:crypto";
import type { CommandPort, CommandResult, RepoCommandOptions, RepoCommandPort } from "../application/ports.js";
import { ConfigError, TimeoutError } from "../errors.js";
import { repoCommandEnv } from "./agent-env.js";

export interface SandboxSettings {
  mode: "docker" | "host";
  image: string;
  memory: string;
  cpus: string;
  pids_limit: number;
  setup_network: "bridge" | "none";
}

export interface DockerRunInput {
  name: string;
  /** Host path of the worktree. It is the only host path mounted into the container. */
  worktree: string;
  command: string;
  network: "none" | "bridge";
  timeoutSec: number;
  uid: number;
  gid: number;
  /** Allowlisted variables passed with -e. Nothing else from the daemon's environment crosses. */
  env: Record<string, string>;
  settings: SandboxSettings;
}

/** Variables the container may receive. Locale and terminal only. */
const CONTAINER_ENV = /^(LANG|LC_[A-Z_]+|TZ|TERM)$/;

/**
 * Argument vector for `docker run`. Hardening matches nexum's ShellTool: no network
 * for verify, all capabilities dropped, no-new-privileges, read-only root filesystem,
 * a writable tmpfs /tmp, a host uid rather than root, and CPU, memory, and PID limits.
 * The only host mount is the worktree.
 */
export function buildDockerRunArgs(input: DockerRunInput): string[] {
  if (input.worktree.includes(",")) {
    throw new ConfigError("the worktree path may not contain a comma (it breaks docker --mount syntax)");
  }
  const envFlags = Object.entries(input.env)
    .filter(([name]) => CONTAINER_ENV.test(name))
    .flatMap(([name, value]) => ["-e", `${name}=${value}`]);

  return [
    "run",
    "--rm",
    "--name",
    input.name,
    `--network=${input.network}`,
    `--memory=${input.settings.memory}`,
    `--cpus=${input.settings.cpus}`,
    `--pids-limit=${input.settings.pids_limit}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=512m",
    "--user",
    `${input.uid}:${input.gid}`,
    "-e",
    "HOME=/tmp",
    ...envFlags,
    "--mount",
    `type=bind,source=${input.worktree},target=/workspace`,
    "-w",
    "/workspace",
    input.settings.image,
    "timeout",
    String(input.timeoutSec),
    "sh",
    "-c",
    input.command,
  ];
}

/** Runs repo commands in a fresh container per command. */
export class DockerRepoCommands implements RepoCommandPort {
  constructor(
    private readonly command: CommandPort,
    private readonly settings: SandboxSettings,
  ) {}

  async run(command: string, options: RepoCommandOptions): Promise<CommandResult> {
    const name = `ci-healer-${randomUUID()}`;
    const network = options.phase === "setup" ? this.settings.setup_network : "none";
    const timeoutSec = Math.max(1, Math.ceil(options.timeoutMs / 1000));
    const argv = buildDockerRunArgs({
      name,
      worktree: options.cwd,
      command,
      network,
      timeoutSec,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      env: repoCommandEnv(),
      settings: this.settings,
    });
    try {
      return await this.command.run(["docker", ...argv], {
        timeoutMs: options.timeoutMs + 15_000,
        allowFailure: options.allowFailure,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        await this.command
          .run(["docker", "rm", "-f", name], { timeoutMs: 30_000, allowFailure: true })
          .catch(() => undefined);
      }
      throw error;
    }
  }
}

/**
 * Unsandboxed execution on the host. It runs only when the operator has set
 * sandbox.acknowledge_host_execution. The environment is still the allowlist.
 */
export class HostRepoCommands implements RepoCommandPort {
  constructor(private readonly command: CommandPort) {}

  run(command: string, options: RepoCommandOptions): Promise<CommandResult> {
    return this.command.run(["sh", "-c", command], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env: repoCommandEnv(),
      allowFailure: options.allowFailure,
    });
  }
}

export function buildRepoCommands(command: CommandPort, settings: SandboxSettings): RepoCommandPort {
  return settings.mode === "docker" ? new DockerRepoCommands(command, settings) : new HostRepoCommands(command);
}

/**
 * Fails closed before any tick. Docker mode without a reachable daemon or without
 * the image is a configuration error, not a reason to fall back to the host.
 */
export async function preflightSandbox(command: CommandPort, settings: SandboxSettings): Promise<void> {
  if (settings.mode === "host") return;
  try {
    await command.run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 });
  } catch {
    throw new ConfigError(
      "sandbox.mode=docker but the Docker daemon is not reachable. Start Docker, or set sandbox.mode=host with acknowledge_host_execution.",
    );
  }
  try {
    await command.run(["docker", "image", "inspect", settings.image], { timeoutMs: 30_000 });
  } catch {
    throw new ConfigError(
      `sandbox image ${settings.image} is missing. Build it with: docker build -t ${settings.image} docker/nexum-sandbox/`,
    );
  }
}
