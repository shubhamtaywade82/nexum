/**
 * An advisory lock for a file's compare-and-swap window: an atomic mkdir beside the file, the mechanism the
 * harness switch lock already uses. Taking it serializes Nexum's own edits to the file. It does not stop a
 * process outside Nexum, which is why the commit-time hash check stays in place.
 *
 * The lock records its owner. It is reclaimed when its owner is gone (the pid is dead) or when it is older than
 * STALE_MS, so a crashed edit cannot block every later edit. A live owner that holds it past the timeout fails
 * the caller closed, with an error that names the lock.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class FileLockTimeoutError extends Error {
  constructor(lockDir: string) {
    super(`timed out waiting for ${lockDir}; another edit holds it and is still running`);
    this.name = "FileLockTimeoutError";
  }
}

const STALE_MS = 30_000;
const POLL_MS = 20;

interface Owner {
  pid: number;
  acquiredAt: number;
}

async function ownerIsGone(lockDir: string): Promise<boolean> {
  let owner: Owner | undefined;
  try {
    owner = JSON.parse(await readFile(`${lockDir}/owner.json`, "utf8")) as Owner;
  } catch {
    // No owner record: the holder crashed between mkdir and writing it. Judge by the directory's age.
    const created = await stat(lockDir)
      .then((s) => s.mtimeMs)
      .catch(() => Date.now());
    return Date.now() - created > STALE_MS;
  }
  if (Date.now() - owner.acquiredAt > STALE_MS) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function acquire(lockDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(`${lockDir}/owner.json`, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await ownerIsGone(lockDir)) {
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockDir);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Runs `fn` while holding the lock for `target`. The lock is released whether `fn` returns or throws. */
export async function withFileLock<T>(target: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const lockDir = `${target}.cas.lock`;
  await mkdir(dirname(target), { recursive: true });
  await acquire(lockDir, timeoutMs);
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
