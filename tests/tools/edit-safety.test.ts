import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGuard } from "../../src/core/fs/workspace-guard.js";
import { CasEditor, contentHash } from "../../src/tools/mutations/cas-editor.js";
import { ApplyPatchTool, AppendTool, EditFileLinesTool, PatchTool } from "../../src/tools/edit-tools.js";
import { WriteFileTool } from "../../src/tools/filesystem.js";
import { checkEditSyntax } from "../../src/validation/edit-check.js";

const ws = () => mkdtempSync(join(tmpdir(), "edit-safety-"));

describe("checkEditSyntax", () => {
  it("rejects invalid JSON for new and previously valid files", () => {
    expect(checkEditSyntax("a.json", null, "{bad").reject).toMatch(/invalid JSON/);
    expect(checkEditSyntax("a.json", '{"a":1}', '{"a":').reject).toBeDefined();
  });
  it("does not blame an edit for a file that was already broken", () => {
    expect(checkEditSyntax("a.json", "{bad", "{still bad")).toEqual({});
    expect(checkEditSyntax("a.ts", "function f() {", "function f() { return 1;")).toEqual({});
  });
  it("warns (does not reject) when a heuristic language loses balance", () => {
    const v = checkEditSyntax("a.ts", "function f() {}\n", "function f() {\n");
    expect(v.reject).toBeUndefined();
    expect(v.warning).toMatch(/introduced a structural problem/);
  });
  it("passes valid edits and unknown file types", () => {
    expect(checkEditSyntax("a.ts", "const a = 1;", "const a = [1];")).toEqual({});
    expect(checkEditSyntax("notes.md", "x", "(((")).toEqual({});
  });
});

describe("file tools enforce edit syntax", () => {
  it("write_file refuses invalid JSON and leaves the file untouched", async () => {
    const dir = ws();
    writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    await expect(new WriteFileTool(dir).call({ path: "package.json", content: '{"name":' })).rejects.toThrow(
      /refused to write invalid content/,
    );
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe('{"name":"x"}');
  });

  it("write_file reports a syntax warning but still writes", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "export function f() {}\n");
    const res = await new WriteFileTool(dir).call({ path: "a.ts", content: "export function f() {\n" });
    expect(res.syntaxWarning).toMatch(/unclosed/);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export function f() {\n");
  });

  it("patch_file and append_file run the same check", async () => {
    const dir = ws();
    writeFileSync(join(dir, "c.json"), '{"a":1}');
    await expect(new PatchTool(dir).call({ path: "c.json", find: "1}", replace: "1" })).rejects.toThrow();
    await expect(new AppendTool(dir).call({ path: "c.json", content: "," })).rejects.toThrow();
    expect(readFileSync(join(dir, "c.json"), "utf8")).toBe('{"a":1}');
  });
});

describe("CAS tools", () => {
  it("apply_patch dry_run validates and diffs without writing (regression: it used to write)", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    const tool = new ApplyPatchTool(new CasEditor({ guard: new WorkspaceGuard({ root: dir }) }));
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
    const res = await tool.call({ path: "a.txt", patch, expected_hash: contentHash("one\ntwo\n"), dry_run: true });
    expect(res.dry_run).toBe(true);
    expect(res.diff).toContain("+TWO");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("edit_file_lines dry_run does not write; a real edit that breaks JSON is refused", async () => {
    const dir = ws();
    const json = '{\n  "a": 1\n}';
    writeFileSync(join(dir, "c.json"), json);
    const tool = new EditFileLinesTool(new CasEditor({ guard: new WorkspaceGuard({ root: dir }) }));
    const base = { path: "c.json", from_line: 2, to_line: 2, expected_hash: contentHash(json) };
    await tool.call({ ...base, new_lines: ['  "a": 2'], dry_run: true });
    expect(readFileSync(join(dir, "c.json"), "utf8")).toBe(json);
    const res = await tool.call({ ...base, new_lines: ['  "a": '] });
    expect(res.error).toBe("EditSyntaxError");
    expect(readFileSync(join(dir, "c.json"), "utf8")).toBe(json);
  });
});
