/**
 * CONTRACT TESTS — filesystem isolation (WorkspaceGuard, review items 9, 37)
 * + CAS editing (apply_patch / edit_file_lines, review items 10, 11, 37).
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGuard } from "../../src/core/fs/workspace-guard.js";
import { CasEditor, contentHash, ExpectedHashMismatchError } from "../../src/tools/mutations/cas-editor.js";
import { WorkspacePathError } from "../../src/core/fs/workspace-guard.js";

describe("WorkspaceGuard contract (filesystem isolation, item 9)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nexum-ws-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows read/write/delete/move/copy/patch/watch inside the root", () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const guard = new WorkspaceGuard({ root });
    for (const op of ["read", "write", "delete", "move", "copy", "patch", "watch"] as const) {
      const verdict = guard.check(op, "a.txt");
      expect(verdict.allowed).toBe(true);
      expect(verdict.code).toBe("ok");
    }
  });

  it("rejects paths escaping the root with ..", () => {
    const guard = new WorkspaceGuard({ root });
    const verdict = guard.check("read", "../outside.txt");
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("escape");
  });

  it("rejects absolute paths outside the root", () => {
    const guard = new WorkspaceGuard({ root });
    const verdict = guard.check("read", "/etc/passwd");
    expect(verdict.allowed).toBe(false);
    expect(["escape", "not_a_file", "not_found"]).toContain(verdict.code);
  });

  it("rejects symlink escape (item 9)", () => {
    const outside = mkdtempSync(join(tmpdir(), "nexum-out-"));
    try {
      mkdirSync(join(root, "linked"));
      symlinkSync(outside, join(root, "linked", "leak"));
      const guard = new WorkspaceGuard({ root });
      const verdict = guard.check("read", "linked/leak/secret.txt");
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe("symlink_escape");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("handles non-existent targets with structured not_found (item 9)", () => {
    const guard = new WorkspaceGuard({ root });
    const read = guard.check("read", "missing.txt");
    expect(read.allowed).toBe(false);
    expect(read.code).toBe("not_found");
    // writes to a not-yet-existing path are fine (create)
    const write = guard.check("write", "new/deep/file.txt");
    expect(write.allowed).toBe(true);
    expect(write.resolvedPath).toContain("new");
  });

  it("blocks sensitive paths for mutations, allows reads (item 9)", () => {
    writeFileSync(join(root, ".env"), "SECRET=1");
    const guard = new WorkspaceGuard({ root });
    const write = guard.check("write", ".env");
    expect(write.allowed).toBe(false);
    expect(write.code).toBe("sensitive_path");
    const read = guard.check("read", ".env");
    expect(read.allowed).toBe(true);
  });

  it("enforces the write scope when narrower than the root (item 9)", () => {
    mkdirSync(join(root, "scoped"), { recursive: true });
    writeFileSync(join(root, "root.txt"), "x");
    const guard = new WorkspaceGuard({ root, writeScope: join(root, "scoped") });
    expect(guard.check("write", "scoped/fine.txt").allowed).toBe(true);
    const denied = guard.check("write", "root.txt");
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("outside_write_scope");
    // reads outside the scope are still allowed
    expect(guard.check("read", "root.txt").allowed).toBe(true);
  });

  it("protectSensitiveReads gates content-revealing ops only (read, copy, search)", () => {
    writeFileSync(join(root, ".env"), "SECRET=1");
    mkdirSync(join(root, "secrets"));
    const guard = new WorkspaceGuard({ root, protectSensitiveReads: true });
    for (const op of ["read", "copy", "search"] as const) {
      expect(guard.check(op, ".env").code).toBe("sensitive_path");
    }
    expect(guard.check("watch", ".env").allowed).toBe(true);
    expect(guard.check("list", "secrets").allowed).toBe(true);
  });

  it("judges sensitivity on the resolved path, so a symlink alias of a secret is the secret", () => {
    writeFileSync(join(root, ".env"), "SECRET=1");
    symlinkSync(join(root, ".env"), join(root, "alias.txt"));
    const guard = new WorkspaceGuard({ root, protectSensitiveReads: true });
    expect(guard.check("read", "alias.txt").code).toBe("sensitive_path");
    expect(guard.check("write", "alias.txt").code).toBe("sensitive_path");
  });

  it("refuses to delete or move the workspace root, and secret directories", () => {
    mkdirSync(join(root, "secrets"));
    const guard = new WorkspaceGuard({ root });
    expect(guard.check("delete", ".").code).toBe("invalid_path");
    expect(guard.check("move", ".").code).toBe("invalid_path");
    expect(guard.check("delete", "secrets").code).toBe("sensitive_path");
  });

  it("applies security rules before existence checks; existence verdicts carry the resolved path", () => {
    const guard = new WorkspaceGuard({ root, protectSensitiveReads: true });
    expect(guard.check("read", ".env").code).toBe("sensitive_path"); // missing, but still a secret
    const missing = guard.check("read", "missing.txt");
    expect(missing.code).toBe("not_found");
    expect(missing.resolvedPath).toBe(join(guard.root, "missing.txt"));
    expect(guard.check("list", "missing-dir").code).toBe("not_found");
  });

  it("requireAllowed throws WorkspacePathError with the verdict", () => {
    const guard = new WorkspaceGuard({ root });
    try {
      guard.requireAllowed("write", "../x");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspacePathError);
      expect((e as WorkspacePathError).verdict.code).toBe("escape");
    }
  });
});

describe("CasEditor contract (items 10, 11)", () => {
  let root: string;
  let editor: CasEditor;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nexum-cas-"));
    editor = new CasEditor({ guard: new WorkspaceGuard({ root }) });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("read returns content + hash (the CAS token)", async () => {
    writeFileSync(join(root, "f.txt"), "line1\nline2\n");
    const { content, hash } = await editor.read("f.txt");
    expect(content).toContain("line1");
    expect(hash).toBe(contentHash(content));
  });

  it("edit_file_lines verifies the observed hash, applies atomically, returns diff (item 10)", async () => {
    writeFileSync(join(root, "f.txt"), "alpha\nbeta\ngamma\n");
    const { hash } = await editor.read("f.txt");
    const result = await editor.editLines("f.txt", hash, (lines) => {
      lines[1] = "BETA";
      return lines;
    });
    expect(result.applied).toBe(true);
    expect(result.newHash).not.toBe(result.previousHash);
    expect(result.diff).toContain("-beta");
    expect(result.diff).toContain("+BETA");
    const after = await editor.read("f.txt");
    expect(after.content).toBe("alpha\nBETA\ngamma\n");
  });

  it("concurrent modification fails with ExpectedHashMismatch (item 10)", async () => {
    writeFileSync(join(root, "f.txt"), "v1\n");
    const { hash } = await editor.read("f.txt");
    writeFileSync(join(root, "f.txt"), "v2-changed-by-someone-else\n"); // human/other agent edits
    await expect(editor.editLines("f.txt", hash, (l) => l)).rejects.toBeInstanceOf(ExpectedHashMismatchError);
  });

  it("apply_patch is the primary primitive: unified diff + CAS (item 11)", async () => {
    writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\n");
    const { hash } = await editor.read("f.txt");
    const patch = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");
    const result = await editor.applyUnifiedDiff("f.txt", hash, patch);
    expect(result.applied).toBe(true);
    expect(result.diff).toContain("+TWO");
    const after = await editor.read("f.txt");
    expect(after.content).toBe("one\nTWO\nthree\n");
  });

  it("dry-run shape: hash mismatches never write (item 10)", async () => {
    writeFileSync(join(root, "f.txt"), "original\n");
    const staleHash = contentHash("something-else");
    await expect(editor.applyUnifiedDiff("f.txt", staleHash, "@@ -1 +1 @@\n-original\n+evil\n")).rejects.toBeInstanceOf(
      ExpectedHashMismatchError,
    );
    const after = await editor.read("f.txt");
    expect(after.content).toBe("original\n");
  });
});
