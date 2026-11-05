/**
 * Strict plugin-artifact extractor: only regular files and directories,
 * nothing outside the target, bounded size, and a deterministic writer.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { extractTar, packDirectory, readTar, TarError } from "../../src/marketplace/tar.js";

let base: string;
let src: string;
let out: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "nexum-tar-"));
  src = join(base, "src");
  out = join(base, "out");
  mkdirSync(src);
  mkdirSync(out);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Build an archive with the system tar (GNU/bsdtar) for inputs the writer refuses to create. */
function systemTar(args: string[]): Buffer {
  const file = join(base, "sys.tar");
  const r = spawnSync("tar", ["-cf", file, ...args], { cwd: src });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return readFileSync(file);
}

describe("packDirectory", () => {
  it("is deterministic and skips .git", () => {
    writeFileSync(join(src, "b.js"), "b");
    mkdirSync(join(src, "lib"));
    writeFileSync(join(src, "lib", "a.js"), "a");
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git", "config"), "x");
    const one = packDirectory(src);
    const two = packDirectory(src);
    expect(one.equals(two)).toBe(true);
    expect(readTar(one).map((e) => e.path)).toEqual(["b.js", "lib", "lib/a.js"]);
  });

  it("round-trips long paths via pax headers, readable by system tar too", () => {
    const deep = join(src, "a".repeat(60), "b".repeat(60));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "file.js"), "deep");
    writeFileSync(join(src, "package.json"), "{}"); // top-level file: no root stripping
    const archive = packDirectory(src);
    extractTar(archive, out);
    expect(readFileSync(join(out, "a".repeat(60), "b".repeat(60), "file.js"), "utf8")).toBe("deep");

    const sysOut = join(base, "sys");
    mkdirSync(sysOut);
    writeFileSync(join(base, "p.tar"), archive);
    expect(spawnSync("tar", ["-xf", join(base, "p.tar"), "-C", sysOut]).status).toBe(0);
    expect(readFileSync(join(sysOut, "a".repeat(60), "b".repeat(60), "file.js"), "utf8")).toBe("deep");
  });

  it("refuses to pack symlinks", () => {
    symlinkSync("/etc/passwd", join(src, "link"));
    expect(() => packDirectory(src)).toThrow(TarError);
  });
});

describe("extractTar", () => {
  it("extracts gzip archives from system tar and strips npm's package/ root", () => {
    mkdirSync(join(src, "package", "lib"), { recursive: true });
    writeFileSync(join(src, "package", "package.json"), "{}");
    writeFileSync(join(src, "package", "lib", "x.js"), "x");
    const files = extractTar(gzipSync(systemTar(["package"])), out);
    expect(files.sort()).toEqual(["lib/x.js", "package.json"]);
    expect(readFileSync(join(out, "lib", "x.js"), "utf8")).toBe("x");
  });

  it("rejects symlinks and hardlinks", () => {
    writeFileSync(join(src, "a"), "a");
    symlinkSync("/etc/passwd", join(src, "link"));
    expect(() => extractTar(systemTar(["a", "link"]), out)).toThrow(/symlink entries are not allowed/);

    rmSync(join(src, "link"));
    spawnSync("ln", [join(src, "a"), join(src, "hard")]);
    expect(() => extractTar(systemTar(["a", "hard"]), out)).toThrow(/hardlink entries are not allowed/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("rejects absolute paths and .. components", () => {
    writeFileSync(join(src, "x"), "x");
    const archive = systemTar(["x"]);
    const evil = (name: string): Buffer => {
      const copy = Buffer.from(archive);
      copy.fill(0, 0, 100);
      copy.write(name, 0, "utf8");
      // recompute the header checksum so only the path is "wrong"
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : copy[i];
      copy.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
      return copy;
    };
    expect(() => extractTar(evil("../escape.js"), out)).toThrow(/escapes the archive/);
    expect(() => extractTar(evil("a/../../escape.js"), out)).toThrow(/escapes the archive/);
    expect(() => extractTar(evil("/etc/cron.d/x"), out)).toThrow(/absolute path/);
    expect(existsSync(join(base, "escape.js"))).toBe(false);
  });

  it("rejects corrupted headers, truncation and oversized content", () => {
    writeFileSync(join(src, "x"), "x".repeat(2000));
    const archive = packDirectory(src);
    const corrupted = Buffer.from(archive);
    corrupted[10] ^= 0xff;
    expect(() => readTar(corrupted)).toThrow(/checksum mismatch/);
    expect(() => readTar(archive.subarray(0, 1024))).toThrow(/truncated/);
    expect(() => readTar(archive, { maxFileBytes: 1000 })).toThrow(/larger than 1000 bytes/);
    expect(() => readTar(gzipSync(archive), { maxTotalBytes: 1000 })).toThrow();
  });

  it("refuses a non-empty target directory", () => {
    writeFileSync(join(src, "x"), "x");
    writeFileSync(join(out, "existing"), "");
    expect(() => extractTar(packDirectory(src), out)).toThrow(/not empty/);
  });
});
