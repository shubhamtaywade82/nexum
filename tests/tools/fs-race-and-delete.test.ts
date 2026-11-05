/**
 * Deleting directories that hold secrets, and symlink swaps between a guard
 * check and the actual syscall.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGuard } from "../../src/core/fs/workspace-guard.js";
import { DeleteFileTool } from "../../src/tools/directory-tools.js";
import { SensitivePathError, PathEscapeError } from "../../src/tools/filesystem.js";
import { guardPath } from "../../src/tools/path-utils.js";
import { readVerifiedWith, writeVerifiedWith } from "../../src/tools/verified-fs.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nexum-race-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "nexum-outside-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("delete_file and protected files inside directories", () => {
  it("refuses to delete a directory that contains a secret", async () => {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", ".env.production"), "KEY=1");
    writeFileSync(join(root, "config", "app.json"), "{}");
    await expect(new DeleteFileTool(root).call({ path: "config" })).rejects.toThrow(SensitivePathError);
    expect(existsSync(join(root, "config", ".env.production"))).toBe(true);
  });

  it("still deletes directories without secrets", async () => {
    mkdirSync(join(root, "tmp", "nested"), { recursive: true });
    writeFileSync(join(root, "tmp", "nested", "a.txt"), "x");
    await expect(new DeleteFileTool(root).call({ path: "tmp" })).resolves.toMatchObject({ removed: true });
    expect(existsSync(join(root, "tmp"))).toBe(false);
  });
});

describe("symlink swap between check and use", () => {
  function swapAfterFirstCheck(guard: WorkspaceGuard, op: "read" | "write", path: string): () => string {
    let first = true;
    return () => {
      const resolved = guardPath(guard, op, path);
      if (first) {
        first = false;
        // the attack: replace a checked directory with a symlink out of the workspace
        renameSync(join(root, "a"), join(root, "a-orig"));
        symlinkSync(outside, join(root, "a"));
      }
      return resolved;
    };
  }

  it("a read never returns bytes from outside the workspace", async () => {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "b.txt"), "workspace content");
    writeFileSync(join(outside, "b.txt"), "OUTSIDE SECRET");
    const guard = new WorkspaceGuard({ root, protectSensitiveReads: true });
    await expect(readVerifiedWith(swapAfterFirstCheck(guard, "read", "a/b.txt"), "a/b.txt")).rejects.toThrow(
      PathEscapeError,
    );
  });

  it("a read of a file swapped for a different one is refused (inode check)", async () => {
    writeFileSync(join(root, "one.txt"), "one");
    writeFileSync(join(root, "two.txt"), "two");
    const paths = [join(root, "one.txt"), join(root, "two.txt")];
    await expect(readVerifiedWith(() => paths.shift()!, "one.txt")).rejects.toThrow(/changed while being accessed/);
  });

  it("a read refuses a final-component symlink planted after the check", async () => {
    writeFileSync(join(outside, "secret"), "OUTSIDE SECRET");
    symlinkSync(join(outside, "secret"), join(root, "link"));
    await expect(readVerifiedWith(() => join(root, "link"), "link")).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("a write never lands content outside the workspace", async () => {
    mkdirSync(join(root, "a"));
    const guard = new WorkspaceGuard({ root });
    await expect(
      writeVerifiedWith(swapAfterFirstCheck(guard, "write", "a/out.txt"), "a/out.txt", "PAYLOAD"),
    ).rejects.toThrow(PathEscapeError);
    for (const name of readdirSync(outside)) {
      expect(readFileSync(join(outside, name), "utf8")).not.toContain("PAYLOAD");
    }
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
  });

  it("writes still succeed when nothing moves", async () => {
    mkdirSync(join(root, "a"));
    const guard = new WorkspaceGuard({ root });
    await writeVerifiedWith(() => guardPath(guard, "write", "a/ok.txt"), "a/ok.txt", "fine");
    expect(readFileSync(join(root, "a", "ok.txt"), "utf8")).toBe("fine");
    expect(readdirSync(join(root, "a"))).toEqual(["ok.txt"]);
  });
});
