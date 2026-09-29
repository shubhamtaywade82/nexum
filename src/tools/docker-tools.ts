import { execFile, spawn } from "node:child_process";
import { relative } from "node:path";
import { Tool } from "./tool.js";
import { agentWorkspaceGuard } from "./path-utils.js";
import { findSensitivePaths, SensitiveScanLimitError } from "../core/fs/sensitive-scan.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";

/**
 * Access to the Docker daemon is root-equivalent on the host, so this tool is
 * an allowlist, not a blocklist:
 *   - everything it creates is labelled AGENT_LABEL, and stop/logs/inspect/
 *     exec/rm only touch labelled containers/images (ps/images are filtered);
 *   - `run`/`exec` accept only allowlisted flags: no bind mounts, host
 *     namespaces, devices, capabilities, env-file or host env pass-through;
 *   - `build` needs a workspace context without secrets and no host outputs
 *     (-o, --iidfile, cache export), secrets or SSH forwarding;
 *   - compose and cp are not offered (compose files can declare anything);
 *   - no egress by default: containers join AGENT_NETWORK (an --internal
 *     network — agent containers reach each other, nothing reaches out) and
 *     builds run with --network=none. `egress` opts back into bridge
 *     networking and loopback-only port publishing.
 */
export const AGENT_LABEL = "nexum.agent=true";
const AGENT_LABEL_KEY = "nexum.agent";
/** Internal (no-egress) network agent containers join by default. */
export const AGENT_NETWORK = "nexum-agent";

const SUBCOMMANDS = ["run", "build", "ps", "images", "logs", "inspect", "stop", "rm", "exec"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

type Plan =
  { ok: true; args: string[]; targets: string[]; needsAgentNetwork?: boolean } | { ok: false; message: string };

interface FlagSpec {
  /** Flag takes a value. */
  value?: boolean;
  /** Validates the value; returns an error message or null. */
  check?: (value: string) => string | null;
}

const NAMED_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function envCheck(v: string): string | null {
  return v.includes("=") ? null : `-e ${v}: pass NAME=VALUE (bare names copy the host's environment variable)`;
}

function volumeCheck(v: string): string | null {
  if (!v.includes(":")) return v.startsWith("/") ? null : `-v ${v}: use a named volume or an anonymous container path`;
  const source = v.split(":")[0];
  return NAMED_VOLUME.test(source) ? null : `-v ${v}: bind mounts of host paths are not allowed; use a named volume`;
}

function mountCheck(v: string): string | null {
  const fields = Object.fromEntries(
    v.split(",").map((f) => {
      const [k, ...rest] = f.split("=");
      return [k.trim().toLowerCase(), rest.join("=")];
    }),
  );
  const type = fields.type ?? "volume";
  if (type !== "volume" && type !== "tmpfs") return `--mount ${v}: only type=volume or type=tmpfs is allowed`;
  const source = fields.source ?? fields.src;
  if (source !== undefined && source !== "" && !NAMED_VOLUME.test(source)) {
    return `--mount ${v}: volume source must be a volume name`;
  }
  return null;
}

function publishCheck(v: string): string | null {
  return v.startsWith("127.0.0.1:") ? null : `-p ${v}: publish on loopback only, e.g. 127.0.0.1:8080:80`;
}

function networkCheck(v: string): string | null {
  return v === "host" || v.startsWith("container:")
    ? `--network ${v}: host and container network modes are not allowed`
    : null;
}

const RUN_FLAGS: Record<string, FlagSpec> = {
  "--rm": {},
  "-d": {},
  "--detach": {},
  "-i": {},
  "--interactive": {},
  "-t": {},
  "--tty": {},
  "--init": {},
  "--read-only": {},
  "--name": { value: true },
  "-e": { value: true, check: envCheck },
  "--env": { value: true, check: envCheck },
  "-l": { value: true },
  "--label": { value: true },
  "-p": { value: true, check: publishCheck },
  "--publish": { value: true, check: publishCheck },
  "-v": { value: true, check: volumeCheck },
  "--volume": { value: true, check: volumeCheck },
  "--mount": { value: true, check: mountCheck },
  "--network": { value: true, check: networkCheck },
  "--net": { value: true, check: networkCheck },
  "-w": { value: true },
  "--workdir": { value: true },
  "--entrypoint": { value: true },
  "-u": { value: true },
  "--user": { value: true },
  "-h": { value: true },
  "--hostname": { value: true },
  "-m": { value: true },
  "--memory": { value: true },
  "--cpus": { value: true },
  "--pids-limit": { value: true },
  "--platform": { value: true },
  "--restart": { value: true },
  "--stop-timeout": { value: true },
  "--shm-size": { value: true },
  "--pull": { value: true },
};

const EXEC_FLAGS: Record<string, FlagSpec> = {
  "-d": {},
  "--detach": {},
  "-i": {},
  "--interactive": {},
  "-t": {},
  "--tty": {},
  "-e": { value: true, check: envCheck },
  "--env": { value: true, check: envCheck },
  "-w": { value: true },
  "--workdir": { value: true },
  "-u": { value: true },
  "--user": { value: true },
};

const BUILD_FLAGS: Record<string, FlagSpec> = {
  "-t": { value: true },
  "--tag": { value: true },
  "-f": { value: true },
  "--file": { value: true },
  "--build-arg": {
    value: true,
    check: (v) => (v.includes("=") ? null : `--build-arg ${v}: pass NAME=VALUE (bare names copy the host's variable)`),
  },
  "--target": { value: true },
  "--platform": { value: true },
  "--label": { value: true },
  "--progress": { value: true },
  "--no-cache": {},
  "--pull": {},
  "-q": {},
  "--quiet": {},
};

const STOP_FLAGS: Record<string, FlagSpec> = {
  "-t": { value: true },
  "--time": { value: true },
  "-s": { value: true },
  "--signal": { value: true },
};
const RM_FLAGS: Record<string, FlagSpec> = { "-f": {}, "--force": {}, "-v": {}, "--volumes": {} };
const LOGS_FLAGS: Record<string, FlagSpec> = {
  "-n": { value: true },
  "--tail": { value: true },
  "--since": { value: true },
  "--until": { value: true },
  "-t": {},
  "--timestamps": {},
};
const INSPECT_FLAGS: Record<string, FlagSpec> = {
  "-f": { value: true },
  "--format": { value: true },
  "-s": {},
  "--size": {},
  "--type": { value: true },
};

const TARGET_FLAGS: Record<"stop" | "rm" | "logs" | "inspect", Record<string, FlagSpec>> = {
  stop: STOP_FLAGS,
  rm: RM_FLAGS,
  logs: LOGS_FLAGS,
  inspect: INSPECT_FLAGS,
};

/**
 * Parse `args` against an allowlist. Returns the positional arguments that
 * precede the first one `stopAtPositional` asks to stop at (run/exec stop at
 * the image/container, after which the container command follows).
 */
function parseFlags(
  subcommand: string,
  args: string[],
  flags: Record<string, FlagSpec>,
  stopAfterPositionals = Infinity,
):
  | { ok: true; positionals: string[]; rest: string[]; values: Array<[string, string]> }
  | { ok: false; message: string } {
  const positionals: string[] = [];
  const values: Array<[string, string]> = [];
  let i = 0;
  for (; i < args.length && positionals.length < stopAfterPositionals; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      positionals.push(...args.slice(i + 1, i + 1 + (stopAfterPositionals - positionals.length)));
      i = args.length;
      break;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq === -1 ? arg : arg.slice(0, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      // short flags: a cluster of booleans (-it) or a flag with a stuck value (-p8080:80)
      const letters = arg.slice(1);
      const valued = [...letters].findIndex((c) => flags[`-${c}`]?.value);
      if (valued === -1) {
        for (const c of letters) {
          if (!flags[`-${c}`]) return { ok: false, message: `docker ${subcommand}: -${c} is not an allowed flag` };
        }
        continue;
      }
      for (const c of letters.slice(0, valued)) {
        if (!flags[`-${c}`] || flags[`-${c}`].value) {
          return { ok: false, message: `docker ${subcommand}: -${c} is not an allowed flag` };
        }
      }
      name = `-${letters[valued]}`;
      const stuck = letters.slice(valued + 1);
      inline = stuck === "" ? undefined : stuck.replace(/^=/, "");
    }
    const spec = flags[name];
    if (!spec) {
      return {
        ok: false,
        message: `docker ${subcommand}: ${name} is not an allowed flag (allowed: ${Object.keys(flags).join(", ")})`,
      };
    }
    if (!spec.value) {
      if (inline !== undefined) return { ok: false, message: `docker ${subcommand}: ${name} takes no value` };
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) return { ok: false, message: `docker ${subcommand}: ${name} needs a value` };
    const problem = spec.check?.(value);
    if (problem) return { ok: false, message: `docker ${subcommand}: ${problem}` };
    values.push([name, value]);
  }
  return { ok: true, positionals, rest: args.slice(i), values };
}

export interface DockerToolOptions {
  /** Label lookup for ownership checks (tests inject a fake; default asks the daemon). */
  labelOf?: (target: string) => Promise<string | undefined>;
  /** Allow network egress (bridge networking, loopback port publishing). Default false. */
  egress?: boolean;
  /** Ensures AGENT_NETWORK exists and is internal (tests inject a fake; default asks the daemon). */
  ensureAgentNetwork?: () => Promise<void>;
}

export class DockerTool extends Tool {
  private readonly guard: WorkspaceGuard;
  private readonly labelOf: (target: string) => Promise<string | undefined>;
  private readonly egress: boolean;
  private readonly ensureAgentNetwork: () => Promise<void>;

  constructor(
    private readonly root: string,
    opts: DockerToolOptions = {},
  ) {
    super();
    this.guard = agentWorkspaceGuard(root);
    this.labelOf = opts.labelOf ?? defaultLabelOf(root);
    this.egress = opts.egress ?? false;
    this.ensureAgentNetwork = opts.ensureAgentNetwork ?? defaultEnsureAgentNetwork(root);
  }

  get name(): string {
    return "docker";
  }

  get description(): string {
    const network = this.egress
      ? "Containers use bridge networking; -p on 127.0.0.1 only."
      : `No network egress: containers join the internal "${AGENT_NETWORK}" network (they reach each other by name, nothing outside) and builds run without network; -p is unavailable.`;
    return (
      "Run a docker subcommand (run, build, ps, images, logs, inspect, stop, rm, exec) on containers this agent creates. " +
      "No host bind mounts (use named volumes), no host network/devices/capabilities, env as NAME=VALUE only; " +
      `build contexts must be inside the workspace and free of secrets. ${network}`
    );
  }

  get tags(): string[] {
    return ["docker", "container", "infra"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  /** Validate and rewrite a docker invocation (labels/filters injected). Pure: no daemon calls. */
  plan(dockerArgs: string[]): Plan {
    const [subcommand, ...args] = dockerArgs;
    if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      return { ok: false, message: `docker ${subcommand} is not on the allowlist (${SUBCOMMANDS.join(", ")})` };
    }
    switch (subcommand as Subcommand) {
      case "ps":
      case "images":
        // listing is harmless beyond disclosure; scope it to agent-owned objects
        return { ok: true, args: [subcommand, ...args, "--filter", `label=${AGENT_LABEL}`], targets: [] };
      case "run": {
        const parsed = parseFlags("run", args, RUN_FLAGS, 1);
        if (!parsed.ok) return parsed;
        if (parsed.positionals.length === 0) return { ok: false, message: "docker run: missing image" };
        return this.planRunNetwork(args, parsed.values);
      }
      case "exec": {
        const parsed = parseFlags("exec", args, EXEC_FLAGS, 1);
        if (!parsed.ok) return parsed;
        if (parsed.positionals.length === 0) return { ok: false, message: "docker exec: missing container" };
        return { ok: true, args: ["exec", ...args], targets: parsed.positionals };
      }
      case "build":
        return this.planBuild(args);
      case "stop":
      case "rm":
      case "logs":
      case "inspect": {
        const flags = TARGET_FLAGS[subcommand as keyof typeof TARGET_FLAGS];
        const parsed = parseFlags(subcommand, args, flags);
        if (!parsed.ok) return parsed;
        if (parsed.positionals.length === 0) return { ok: false, message: `docker ${subcommand}: missing target` };
        return { ok: true, args: [subcommand, ...args], targets: parsed.positionals };
      }
    }
  }

  /** Egress policy for `run`: internal network by default, bridge/-p only when egress is enabled. */
  private planRunNetwork(args: string[], values: Array<[string, string]>): Plan {
    const base = ["run", "--label", AGENT_LABEL];
    if (this.egress) return { ok: true, args: [...base, ...args], targets: [] };
    if (values.some(([name]) => name === "-p" || name === "--publish")) {
      return {
        ok: false,
        message: `docker run: port publishing needs network egress enabled (dockerEgress); containers run on the internal "${AGENT_NETWORK}" network`,
      };
    }
    const networks = values.filter(([name]) => name === "--network" || name === "--net").map(([, v]) => v);
    const disallowed = networks.find((n) => n !== "none" && n !== AGENT_NETWORK);
    if (disallowed !== undefined) {
      return {
        ok: false,
        message: `docker run: network "${disallowed}" allows egress; use "${AGENT_NETWORK}" (internal) or "none", or enable dockerEgress`,
      };
    }
    if (networks.length === 0) {
      return { ok: true, args: [...base, "--network", AGENT_NETWORK, ...args], targets: [], needsAgentNetwork: true };
    }
    return { ok: true, args: [...base, ...args], targets: [], needsAgentNetwork: networks.includes(AGENT_NETWORK) };
  }

  private planBuild(args: string[]): Plan {
    const parsed = parseFlags("build", args, BUILD_FLAGS);
    if (!parsed.ok) return parsed;
    if (parsed.positionals.length !== 1)
      return { ok: false, message: "docker build: pass exactly one context directory" };
    const context = parsed.positionals[0];
    if (context === "-" || /^[a-z]+:\/\//i.test(context) || context.startsWith("git@")) {
      return { ok: false, message: "docker build: the context must be a directory inside the workspace" };
    }
    const contextVerdict = this.guard.check("list", context);
    if (!contextVerdict.allowed || !contextVerdict.resolvedPath) {
      return { ok: false, message: `docker build: context ${context}: ${contextVerdict.message}` };
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const file = arg === "-f" || arg === "--file" ? args[i + 1] : /^(-f|--file=)(.+)$/.exec(arg)?.[2];
      if (file !== undefined) {
        const verdict = this.guard.check("read", file);
        if (!verdict.allowed) return { ok: false, message: `docker build: Dockerfile ${file}: ${verdict.message}` };
      }
    }
    try {
      const secrets = findSensitivePaths(this.guard.root, contextVerdict.resolvedPath);
      if (secrets.length > 0) {
        const sample = secrets.slice(0, 3).map((s) => relative(this.guard.root, s.path));
        return {
          ok: false,
          message:
            `docker build: context ${context} contains secret files (${sample.join(", ")}${secrets.length > 3 ? ", …" : ""}) ` +
            "that would be sent to the daemon; build from a directory without them",
        };
      }
    } catch (e) {
      if (e instanceof SensitiveScanLimitError) {
        return { ok: false, message: `docker build: context ${context} is too large to check for secrets` };
      }
      throw e;
    }
    const network = this.egress ? [] : ["--network=none"];
    return { ok: true, args: ["build", "--label", AGENT_LABEL, ...network, ...args], targets: [] };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dockerArgs = args.args as string[];
    if (!Array.isArray(dockerArgs) || dockerArgs.length === 0 || dockerArgs.some((a) => typeof a !== "string")) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }

    const plan = this.plan(dockerArgs);
    if (!plan.ok) return { error: "DisallowedDockerCommandError", message: plan.message };

    if (plan.needsAgentNetwork) {
      try {
        await this.ensureAgentNetwork();
      } catch (e) {
        return { error: "DockerNetworkError", message: e instanceof Error ? e.message : String(e) };
      }
    }

    for (const target of plan.targets) {
      if ((await this.labelOf(target)) !== "true") {
        return {
          error: "DisallowedDockerCommandError",
          message: `docker ${dockerArgs[0]}: "${target}" was not created by this agent (missing label ${AGENT_LABEL})`,
        };
      }
    }

    return new Promise((resolvePromise) => {
      const child = spawn("docker", plan.args, { cwd: this.root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        resolvePromise({ command: `docker ${plan.args.join(" ")}`, exitCode: exitCode ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `docker ${plan.args.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}

function defaultLabelOf(root: string): (target: string) => Promise<string | undefined> {
  return (target) =>
    new Promise((resolvePromise) => {
      execFile(
        "docker",
        ["inspect", "--format", `{{index .Config.Labels "${AGENT_LABEL_KEY}"}}`, "--", target],
        { cwd: root, timeout: 15_000 },
        (err, stdout) => resolvePromise(err ? undefined : stdout.toString().trim()),
      );
    });
}

/**
 * Create AGENT_NETWORK as an --internal network if missing, and refuse to use
 * an existing one that is not internal (it would give containers egress).
 */
function defaultEnsureAgentNetwork(root: string): () => Promise<void> {
  const docker = (args: string[]) =>
    new Promise<{ ok: boolean; out: string }>((resolvePromise) => {
      execFile("docker", args, { cwd: root, timeout: 15_000 }, (err, stdout, stderr) =>
        resolvePromise({ ok: !err, out: `${stdout}${stderr}`.trim() }),
      );
    });
  let ready: Promise<void> | null = null;
  return () => {
    ready ??= (async () => {
      const inspected = await docker(["network", "inspect", "--format", "{{.Internal}}", AGENT_NETWORK]);
      if (inspected.ok) {
        if (inspected.out !== "true") {
          throw new Error(
            `docker network "${AGENT_NETWORK}" exists but is not --internal; remove it so the agent can recreate it`,
          );
        }
        return;
      }
      const created = await docker(["network", "create", "--internal", "--label", AGENT_LABEL, AGENT_NETWORK]);
      if (!created.ok) throw new Error(`could not create docker network "${AGENT_NETWORK}": ${created.out}`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
    return ready;
  };
}
