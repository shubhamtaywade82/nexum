import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLockTimeoutError, withFileLock } from "../../src/tools/mutations/file-lock.js";

let dir: string;
let target: string;
const lockDir = () => `${target}.cas.lock`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-lock-"));
  target = join(dir, "a.txt");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("serializes holders: the second runs only after the first has finished", async () => {
    const order: string[] = [];
    let enteredFirst!: () => void;
    const insideFirst = new Promise<void>((resolve) => (enteredFirst = resolve));
    const first = withFileLock(target, async () => {
      order.push("first:start");
      enteredFirst();
      await new Promise((r) => setTimeout(r, 60));
      order.push("first:end");
    });
    // Start the second only once the first holds the lock: the two calls' filesystem steps can complete in either order.
    await insideFirst;
    const second = withFileLock(target, async () => {
      order.push("second:start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the lock when the critical section throws", async () => {
    await expect(
      withFileLock(target, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withFileLock(target, async () => "again")).resolves.toBe("again");
  });

  it("reclaims a lock whose owner process is gone", async () => {
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ pid: 2147483646, acquiredAt: Date.now() }));
    await expect(withFileLock(target, async () => "ran")).resolves.toBe("ran");
  });

  it("reclaims a lock older than the stale age even when its owner pid is alive", async () => {
    mkdirSync(lockDir());
    writeFileSync(
      join(lockDir(), "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 5 * 60_000 }),
    );
    await expect(withFileLock(target, async () => "ran")).resolves.toBe("ran");
  });

  it("fails closed with a named error when a live, fresh holder keeps the lock past the timeout", async () => {
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    await expect(withFileLock(target, async () => "never", 80)).rejects.toThrow(FileLockTimeoutError);
    expect(readFileSync(join(lockDir(), "owner.json"), "utf8")).toContain(String(process.pid));
  });
});
