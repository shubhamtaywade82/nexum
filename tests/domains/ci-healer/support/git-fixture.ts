import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, ...IDENTITY } });
  return stdout.trim();
}

export interface Fixture {
  origin: string;
  seed: string;
  work: string;
}

/** A bare origin, a seed repo that publishes commits, and the clone the healer operates on. */
export async function buildOriginAndClone(root: string): Promise<Fixture> {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  await git(["init", "--bare", "-q", "-b", "main", origin]);
  await git(["init", "-q", "-b", "main", seed]);
  await git(["remote", "add", "origin", origin], seed);
  await publish(seed, { branch: "main", file: "README.md", content: "app\n", base: null });
  await git(["clone", "-q", origin, work]);
  return { origin, seed, work };
}

/** Commits `content` to `file` on `branch` (created from `base` when given) and force-pushes it to origin. */
export async function publish(
  seed: string,
  options: { branch: string; file: string; content: string; base?: string | null },
): Promise<string> {
  const base = options.base === undefined ? "main" : options.base;
  await git(["checkout", "-q", "-B", options.branch, ...(base ? [base] : [])], seed);
  const path = join(seed, options.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, options.content);
  await git(["add", "-A"], seed);
  await git(["commit", "-q", "-m", `${options.branch}: ${options.file}`], seed);
  await git(["push", "-q", "-f", "origin", options.branch], seed);
  return git(["rev-parse", "HEAD"], seed);
}
