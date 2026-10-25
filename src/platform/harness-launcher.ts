import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { globalStateDir } from "./paths.js";

/**
 * Runs the activated harness.
 *
 * Harness evolution activates an accepted candidate by writing an
 * `activeHarness` pointer ({ id, commitSha }) into `nexum.harness.json` at the
 * root of the harness repository, which is a Nexum checkout. This module is the
 * consumer of that pointer. When `nexum` starts from that checkout for a command
 * that runs the agent, and the pointer names a commit other than the checkout's
 * HEAD, it materializes that commit once and runs the same command there, with
 * the same arguments and terminal. An accepted candidate therefore becomes the
 * code the agent actually runs from its next start.
 *
 * - Control commands (evolve, doctor, trust, …) always run the installed code:
 *   the evaluator must not be the harness it judges.
 * - A `frozen` marker (a rollback in flight) makes agent commands refuse to
 *   start until the rollback lands.
 * - Materialization failures fail closed. NEXUM_HARNESS=current is the explicit
 *   escape hatch to run the installed code instead.
 * - A process already running keeps its code. The pointer takes effect on the
 *   next start.
 */

export const HARNESS_MANIFEST = "nexum.harness.json";
/** Set on the child process so it runs in place instead of switching again. */
export const ACTIVE_HARNESS_ENV = "NEXUM_HARNESS_ACTIVE";
/** NEXUM_HARNESS=current runs the installed code, ignoring the pointer. */
export const HARNESS_OVERRIDE_ENV = "NEXUM_HARNESS";
/** Exit code for a refused start while a rollback is in flight (EX_TEMPFAIL). */
export const FROZEN_EXIT_CODE = 75;

const READY_MARKER = ".nexum-harness-ready";

/** Commands that never switch: they manage, inspect or evaluate the harness rather than run it. */
const CONTROL_COMMANDS = new Set([
  "evolve",
  "doctor",
  "trust",
  "migrate",
  "asl",
  "plugins",
  "marketplace",
  "mcp",
  "credentials",
  "capabilities",
  "session",
  "chat",
  "--help",
  "-h",
  "--version",
  "-v",
]);

export interface ActivePointer {
  id: string;
  commitSha: string;
}

export type LaunchDecision =
  | { kind: "in-place"; reason: string }
  | { kind: "frozen"; reason: string }
  | { kind: "switch"; pointer: ActivePointer };

export function isAgentCommand(command: string | undefined): boolean {
  return command === undefined || !CONTROL_COMMANDS.has(command);
}

/** Reads the pointer and freeze marker; null when there is no manifest. Throws on a malformed manifest. */
export function readManifest(packageRoot: string): { pointer: ActivePointer | null; frozen: boolean } | null {
  const path = join(packageRoot, HARNESS_MANIFEST);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const raw = manifest.activeHarness as Partial<ActivePointer> | undefined;
  const pointer =
    raw && typeof raw.id === "string" && typeof raw.commitSha === "string" && /^[0-9a-f]{7,40}$/i.test(raw.commitSha)
      ? { id: raw.id, commitSha: raw.commitSha.toLowerCase() }
      : null;
  return { pointer, frozen: manifest.frozen !== undefined };
}

/** Decides whether this start runs in place, refuses, or switches to the activated harness. Pure. */
export function decideLaunch(input: {
  command: string | undefined;
  env: NodeJS.ProcessEnv;
  manifest: { pointer: ActivePointer | null; frozen: boolean } | null;
  currentCommit: string | null;
}): LaunchDecision {
  if (input.env[ACTIVE_HARNESS_ENV]) return { kind: "in-place", reason: "already running the activated harness" };
  if (input.env[HARNESS_OVERRIDE_ENV] === "current") return { kind: "in-place", reason: "NEXUM_HARNESS=current" };
  if (!isAgentCommand(input.command)) return { kind: "in-place", reason: "control command" };
  if (!input.manifest) return { kind: "in-place", reason: "no harness manifest" };
  if (input.manifest.frozen) {
    return { kind: "frozen", reason: "a harness rollback is in flight; retry once it completes" };
  }
  const pointer = input.manifest.pointer;
  if (!pointer) return { kind: "in-place", reason: "no activated harness" };
  if (input.currentCommit && sameCommit(input.currentCommit, pointer.commitSha)) {
    return { kind: "in-place", reason: "the checkout is already on the activated commit" };
  }
  return { kind: "switch", pointer };
}

function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ exitCode: number; output: string }>;

const execFileAsync = promisify(execFile);

const defaultRunner: CommandRunner = async (command, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`,
    };
  }
};

export function harnessStoreDir(home?: string): string {
  return join(globalStateDir(home), "harnesses");
}

/**
 * Makes `pointer.commitSha` runnable under the store and returns its directory.
 * A git worktree of the checkout at that commit, with dependencies and a build;
 * done once per commit. Install scripts are not run. A failed step leaves no
 * ready marker, so the next start retries from scratch.
 */
export async function materializeHarness(input: {
  packageRoot: string;
  pointer: ActivePointer;
  storeDir: string;
  run?: CommandRunner;
  log?: (line: string) => void;
  /** How long a concurrent start waits for another to finish preparing the same commit. */
  lockTimeoutMs?: number;
}): Promise<string> {
  const run = input.run ?? defaultRunner;
  const log = input.log ?? (() => undefined);
  const sha = input.pointer.commitSha;
  const root = join(input.storeDir, sha);
  const marker = join(root, READY_MARKER);
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === sha) return root;

  const step = async (label: string, command: string, args: string[], cwd: string): Promise<void> => {
    log(`${label}…`);
    const result = await run(command, args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`${label} failed (exit ${result.exitCode}): ${result.output.trim().slice(-2000)}`);
    }
  };

  mkdirSync(input.storeDir, { recursive: true });
  const lockDir = `${root}.lock`;
  if (!tryLock(lockDir)) {
    log(`another start is preparing harness ${input.pointer.id}; waiting…`);
    await waitFor(() => existsSync(marker) || !existsSync(lockDir), input.lockTimeoutMs ?? 15 * 60_000);
    if (existsSync(marker)) return root;
    if (!tryLock(lockDir))
      throw new Error(`timed out waiting for another start to prepare harness ${input.pointer.id}`);
  }
  try {
    return await build();
  } finally {
    rmdirSync(lockDir);
  }

  async function build(): Promise<string> {
    if (existsSync(root)) {
      // A half-built harness from an interrupted start: rebuild it from scratch.
      await run("git", ["worktree", "remove", "--force", root], input.packageRoot);
      rmSync(root, { recursive: true, force: true });
      await run("git", ["worktree", "prune"], input.packageRoot);
    }
    await step(
      `checking out harness ${input.pointer.id} @ ${sha.slice(0, 12)}`,
      "git",
      ["worktree", "add", "--detach", root, sha],
      input.packageRoot,
    );

    const lock = (dir: string) => {
      const path = join(dir, "package-lock.json");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    const sharedModules = join(input.packageRoot, "node_modules");
    if (lock(root) !== null && lock(root) === lock(input.packageRoot) && existsSync(sharedModules)) {
      symlinkSync(sharedModules, join(root, "node_modules"), "junction");
    } else if (lock(root) !== null) {
      await step("installing its dependencies", "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
    }
    await step("building it", "npm", ["run", "build"], root);

    writeFileSync(marker, `${sha}\n`);
    return root;
  }
}

/** mkdir is atomic, so the directory doubles as a cross-process lock. */
function tryLock(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The checkout's HEAD commit, or null when the package is not a git checkout. */
export async function currentCommit(packageRoot: string, run: CommandRunner = defaultRunner): Promise<string | null> {
  if (!existsSync(join(packageRoot, ".git"))) return null;
  const result = await run("git", ["rev-parse", "HEAD"], packageRoot);
  return result.exitCode === 0 ? result.output.trim().split("\n")[0] : null;
}

/**
 * The CLI entry point's hook. Returns null to continue in place, or an exit code
 * once the activated harness (or a refusal) has handled the command.
 */
export async function runActiveHarness(input: {
  command: string | undefined;
  argv: string[];
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  storeDir?: string;
  run?: CommandRunner;
  stdio?: "inherit" | "pipe";
  onOutput?: (chunk: string) => void;
  log?: (line: string) => void;
}): Promise<number | null> {
  const env = input.env ?? process.env;
  const log = input.log ?? ((line: string) => process.stderr.write(`[nexum] ${line}\n`));
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifest(input.packageRoot);
  } catch (err) {
    log(`${HARNESS_MANIFEST} is not valid JSON (${(err as Error).message}); fix it or set NEXUM_HARNESS=current.`);
    return 1;
  }

  const decision = decideLaunch({
    command: input.command,
    env,
    manifest,
    currentCommit: manifest?.pointer ? await currentCommit(input.packageRoot, input.run) : null,
  });
  if (decision.kind === "in-place") return null;
  if (decision.kind === "frozen") {
    log(`${decision.reason}.`);
    return FROZEN_EXIT_CODE;
  }

  const { pointer } = decision;
  let root: string;
  try {
    root = await materializeHarness({
      packageRoot: input.packageRoot,
      pointer,
      storeDir: input.storeDir ?? harnessStoreDir(),
      run: input.run,
      log,
    });
  } catch (err) {
    log(`could not prepare the activated harness ${pointer.id}: ${(err as Error).message}`);
    log("Fix the cause, or run the installed code with NEXUM_HARNESS=current.");
    return 1;
  }

  log(`running activated harness ${pointer.id} @ ${pointer.commitSha.slice(0, 12)}`);
  return runChild({
    entry: join(root, "bin", "cli.js"),
    argv: input.argv,
    env: { ...env, [ACTIVE_HARNESS_ENV]: pointer.commitSha },
    stdio: input.stdio ?? "inherit",
    onOutput: input.onOutput,
  });
}

function runChild(input: {
  entry: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdio: "inherit" | "pipe";
  onOutput?: (chunk: string) => void;
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [input.entry, ...input.argv], {
      cwd: process.cwd(),
      env: input.env,
      stdio: input.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => input.onOutput?.(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => input.onOutput?.(chunk.toString("utf8")));
    // The child owns the terminal; pass the user's signals through rather than dying first.
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    const done = (code: number) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code);
    };
    child.on("error", () => done(1));
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + signalNumber(signal) : 1)));
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : signal === "SIGKILL" ? 9 : 1;
}
