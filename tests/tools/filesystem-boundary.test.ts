/**
 * The agent's filesystem tools share ONE boundary (WorkspaceGuard): no tool may
 * launder a secret into a readable path, and a write scope binds every
 * mutating tool, not just the CAS editor.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ReadFileTool, WriteFileTool, SensitivePathError, PathEscapeError } from "../../src/tools/filesystem.js";
import { CopyFileTool, DeleteFileTool, MoveFileTool, ListDirectoryTool } from "../../src/tools/directory-tools.js";
import { AppendTool, PatchTool } from "../../src/tools/edit-tools.js";
import { SnapshotBackupTool } from "../../src/tools/backup-tools.js";
import { SearchCodeTool } from "../../src/tools/search-tools.js";
import { SqliteQueryTool } from "../../src/tools/database-tools.js";
import { WorkspaceGuard } from "../../src/core/fs/workspace-guard.js";
import { filesystemPack } from "../../src/tools/packs/filesystem-pack.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nexum-boundary-"));
  writeFileSync(join(root, ".env"), "API_KEY=sk-live-secret\n");
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "token.txt"), "NEEDLE sk-live-secret\n");
  writeFileSync(join(root, "server.pem"), "NEEDLE -----BEGIN PRIVATE KEY-----\n");
  writeFileSync(join(root, "app.ts"), "const x = 'NEEDLE';\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("secrets cannot be laundered into a readable path", () => {
  it("move_file refuses to rename a secret", async () => {
    await expect(new MoveFileTool(root).call({ source: ".env", destination: "notes.txt" })).rejects.toThrow(
      SensitivePathError,
    );
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, "notes.txt"))).toBe(false);
  });

  it("copy_file refuses to copy a secret", async () => {
    await expect(new CopyFileTool(root).call({ source: ".env", destination: "copy.txt" })).rejects.toThrow(
      SensitivePathError,
    );
    expect(existsSync(join(root, "copy.txt"))).toBe(false);
  });

  it("read_file refuses a symlink alias of a secret", async () => {
    symlinkSync(join(root, ".env"), join(root, "notes.txt"));
    await expect(new ReadFileTool(root).call({ path: "notes.txt" })).rejects.toThrow(SensitivePathError);
  });

  it("snapshot_backup refuses to copy a secret into the backup store", async () => {
    await expect(new SnapshotBackupTool(root).call({ path: ".env" })).rejects.toThrow(SensitivePathError);
  });

  it("search_code never returns lines from secret files, even when a glob asks for them", async () => {
    const search = new SearchCodeTool(root);
    const all = (await search.call({ query: "NEEDLE" })) as { matches: Array<{ path: string }> };
    expect(all.matches.map((m) => m.path)).toEqual(["app.ts"]);
    const forced = (await search.call({ query: "NEEDLE", glob: "**/*.pem" })) as { matches: unknown[] };
    expect(forced.matches).toEqual([]);
    await expect(search.call({ query: "NEEDLE", path: "secrets/token.txt" })).rejects.toThrow(SensitivePathError);
  });

  it("sqlite_query refuses databases under a secret path", async () => {
    const db = new Database(join(root, "secrets", "vault.db"));
    db.exec("CREATE TABLE t (x TEXT)");
    db.close();
    const result = await new SqliteQueryTool(root).call({ dbPath: "secrets/vault.db", operation: "tables" });
    expect(result.error).toBe("SensitivePathError");
  });

  it("listing a directory reveals names only and stays allowed", async () => {
    const listing = (await new ListDirectoryTool(root).call({ path: "secrets" })) as {
      entries: Array<{ name: string }>;
    };
    expect(listing.entries.map((e) => e.name)).toEqual(["token.txt"]);
  });
});

describe("destructive operations", () => {
  it("delete_file refuses the workspace root and secret directories", async () => {
    const del = new DeleteFileTool(root);
    await expect(del.call({ path: "." })).rejects.toThrow(PathEscapeError);
    await expect(del.call({ path: "secrets" })).rejects.toThrow(SensitivePathError);
    expect(existsSync(join(root, "app.ts"))).toBe(true);
    expect(existsSync(join(root, "secrets", "token.txt"))).toBe(true);
  });

  it("append_file and patch_file refuse secrets", async () => {
    await expect(new AppendTool(root).call({ path: ".env", content: "X=1" })).rejects.toThrow(SensitivePathError);
    await expect(new PatchTool(root).call({ path: ".env", find: "API_KEY", replace: "K" })).rejects.toThrow(
      SensitivePathError,
    );
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("API_KEY=sk-live-secret\n");
  });
});

describe("one guard binds every mutating tool in the pack", () => {
  it("a write scope applies to write/append/delete/move/copy/mkdir and apply_patch alike", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "README.md"), "readme\n");
    const guard = new WorkspaceGuard({ root, writeScope: join(root, "src"), protectSensitiveReads: true });
    const pack = filesystemPack(guard);
    const tool = (name: string) => {
      const entry = pack.entries.find((e) => e.tool.name === name);
      if (!entry) throw new Error(`tool ${name} not in pack`);
      return entry.tool;
    };

    await expect(tool("write_file").call({ path: "src/ok.ts", content: "x" })).resolves.toMatchObject({
      path: "src/ok.ts",
    });
    const outside: Array<[string, Record<string, unknown>]> = [
      ["write_file", { path: "README.md", content: "pwned" }],
      ["append_file", { path: "README.md", content: "pwned" }],
      ["delete_file", { path: "README.md" }],
      ["move_file", { source: "src/ok.ts", destination: "moved.ts" }],
      ["copy_file", { source: "app.ts", destination: "copied.ts" }],
      ["make_directory", { path: "newdir" }],
    ];
    for (const [name, args] of outside) {
      await expect(tool(name).call(args)).rejects.toThrow(PathEscapeError);
    }
    const patch = await tool("apply_patch").call({
      path: "README.md",
      patch: "@@ -1 +1 @@\n-readme\n+pwned\n",
    });
    expect(JSON.stringify(patch)).toMatch(/outside_write_scope|write scope/);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("readme\n");
    expect(existsSync(join(root, "moved.ts"))).toBe(false);
    expect(existsSync(join(root, "copied.ts"))).toBe(false);
    expect(existsSync(join(root, "newdir"))).toBe(false);
    // reads outside the scope stay allowed
    await expect(tool("read_file").call({ path: "README.md" })).resolves.toMatchObject({ content: "readme\n" });
  });

  it("missing files still surface the native fs error", async () => {
    await expect(new ReadFileTool(root).call({ path: "missing.txt" })).rejects.toThrow(/ENOENT/);
    await expect(new WriteFileTool(root).call({ path: "../escape.txt", content: "x" })).rejects.toThrow(
      /escapes workspace root/,
    );
  });
});
