import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadFileTool, WriteFileTool, PathEscapeError } from "../../src/tools/filesystem.js";

describe("ReadFileTool", () => {
  it("reads a file inside the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello");
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: "a.txt" });

    expect(result.content).toBe("hello");
  });

  it("returns the whole file and truncated:false when under the ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello");
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: "a.txt" });

    expect(result.truncated).toBe(false);
    expect(result.bytesRead).toBe(5);
    expect(result.totalBytes).toBe(5);
  });

  // The system prompt tells the model "if read_file returns `truncated`, that
  // is a content ceiling" -- but the flag used to be hardcoded false and the
  // whole file was read, so one read_file on a large file could blow the
  // context window.
  it("truncates a file past the ceiling and reports it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const big = "x".repeat(ReadFileTool.MAX_CONTENT_BYTES + 5000);
    await writeFile(join(dir, "big.txt"), big);
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: "big.txt" });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(ReadFileTool.MAX_CONTENT_BYTES);
    expect(result.totalBytes).toBe(big.length);
    expect((result.content as string).length).toBe(ReadFileTool.MAX_CONTENT_BYTES);
  });

  it("cuts on a byte boundary without throwing on a split multi-byte character", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    // 3-byte characters do not divide evenly into the ceiling, so the cut
    // lands mid-character.
    const content = "\u65e5".repeat(ReadFileTool.MAX_CONTENT_BYTES);
    await writeFile(join(dir, "cjk.txt"), content);
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: "cjk.txt" });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(ReadFileTool.MAX_CONTENT_BYTES);
    expect(Buffer.byteLength(result.content as string, "utf-8")).toBeLessThanOrEqual(
      ReadFileTool.MAX_CONTENT_BYTES + 3,
    );
  });

  it("rejects a path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "../../etc/passwd" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("reads an absolute path that is inside the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "a.txt"), "hello from absolute");
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: join(dir, "a.txt") });

    expect(result.content).toBe("hello from absolute");
  });

  it("rejects an absolute path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "/etc/passwd" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects reads through symlinks that escape the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(dir, "outside"));
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "outside/secret.txt" })).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe("WriteFileTool", () => {
  it("writes atomically, creating parent directories as needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await tool.call({ path: "out/b.txt", content: "data" });

    expect(await readFile(join(dir, "out/b.txt"), "utf-8")).toBe("data");
  });

  it("leaves no temp file behind after a successful write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await tool.call({ path: "c.txt", content: "data" });

    const files = await readdir(dir);
    expect(files.some((f) => f.includes(".tmp."))).toBe(false);
  });

  it("rejects a path that escapes the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await expect(tool.call({ path: "../outside.txt", content: "x" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects writes through symlinked directories that escape the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await symlink(outside, join(dir, "outside"));
    const tool = new WriteFileTool(dir);

    await expect(tool.call({ path: "outside/new.txt", content: "x" })).rejects.toBeInstanceOf(PathEscapeError);
  });
});
