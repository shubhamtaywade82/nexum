/**
 * Minimal, strict tar reader/writer for plugin artifacts.
 *
 * Reader (`extractTar`): accepts ustar/pax/GNU archives, optionally gzip
 * compressed, and extracts ONLY regular files and directories into a fresh
 * directory. Everything else is rejected, not skipped: symlinks, hardlinks,
 * devices and FIFOs, absolute paths, `..` components, duplicate paths,
 * header checksum mismatches, and archives over the size/entry limits. A
 * single top-level directory shared by every entry (npm's `package/`) is
 * stripped. File modes from the archive are ignored.
 *
 * Writer (`packDirectory`): deterministic uncompressed ustar of a directory
 * (sorted, mtime 0, uid/gid 0, fixed modes, `.git` skipped, symlinks
 * rejected). The same tree always yields the same bytes, so publishers can
 * sign the sha256 of a git-sourced plugin. It is left uncompressed on
 * purpose: deflate output is not guaranteed identical across zlib builds.
 */

import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface TarLimits {
  /** Max number of entries (default 10_000). */
  maxEntries?: number;
  /** Max bytes of one file (default 20 MiB). */
  maxFileBytes?: number;
  /** Max bytes of all files together, and of the decompressed archive (default 100 MiB). */
  maxTotalBytes?: number;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const BLOCK = 512;
const DEFAULTS: Required<TarLimits> = {
  maxEntries: 10_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

interface RawEntry {
  path: string;
  type: "file" | "dir";
  data: Buffer;
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? length : nul).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, length: number, field: string): number {
  const first = buf[offset];
  if (first & 0x80) throw new TarError(`base-256 ${field} fields are not supported`);
  const text = readString(buf, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`malformed ${field} field "${text}"`);
  return parseInt(text, 8);
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new TarError("malformed pax header");
    const len = parseInt(data.subarray(pos, space).toString("ascii"), 10);
    if (!Number.isInteger(len) || len <= 0 || pos + len > data.length) throw new TarError("malformed pax header");
    const record = data.subarray(space + 1, pos + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Validate and normalize an archive path to forward-slash relative segments. */
function safePath(raw: string): string {
  if (raw.includes("\0") || raw.includes("\\")) throw new TarError(`unsafe path "${raw}"`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new TarError(`absolute path "${raw}"`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new TarError(`path escapes the archive: "${raw}"`);
  return parts.join("/");
}

function decompress(archive: Buffer, maxBytes: number): Buffer {
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
    try {
      return gunzipSync(archive, { maxOutputLength: maxBytes + 64 * BLOCK });
    } catch (err) {
      throw new TarError(`gzip: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return archive;
}

/** Parse an archive into validated entries (no filesystem access). */
export function readTar(archive: Buffer, limits: TarLimits = {}): RawEntry[] {
  const lim = { ...DEFAULTS, ...limits };
  const buf = decompress(archive, lim.maxTotalBytes);
  const entries: RawEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pos = 0;
  let pax: Record<string, string> = {};
  let longName: string | undefined;

  while (pos + BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const stored = readOctal(header, 148, 8, "checksum");
    if (stored !== checksum(header)) throw new TarError(`header checksum mismatch at offset ${pos}`);
    const size = readOctal(header, 124, 12, "size");
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError("truncated archive");
    const data = buf.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "x") {
      pax = parsePax(data);
      continue;
    }
    if (typeflag === "g") continue; // global pax header: ignored (only affects metadata)
    if (typeflag === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }

    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const rawPath = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    pax = {};
    longName = undefined;

    let type: RawEntry["type"];
    if (typeflag === "0" || typeflag === "7") type = "file";
    else if (typeflag === "5") type = "dir";
    else {
      const kind = typeflag === "1" ? "hardlink" : typeflag === "2" ? "symlink" : `type "${typeflag}"`;
      throw new TarError(`${kind} entries are not allowed ("${rawPath}")`);
    }

    const path = safePath(rawPath);
    if (path === "") {
      if (type === "dir") continue; // "./" root entry
      throw new TarError("file entry with an empty path");
    }
    if (seen.has(path)) throw new TarError(`duplicate entry "${path}"`);
    seen.add(path);
    if (entries.length >= lim.maxEntries) throw new TarError(`more than ${lim.maxEntries} entries`);
    if (type === "file") {
      if (size > lim.maxFileBytes) throw new TarError(`"${path}" is larger than ${lim.maxFileBytes} bytes`);
      total += size;
      if (total > lim.maxTotalBytes) throw new TarError(`archive expands past ${lim.maxTotalBytes} bytes`);
    }
    entries.push({ path, type, data: type === "file" ? data : Buffer.alloc(0) });
  }
  return entries;
}

/** Drop a directory component shared by every entry (npm's `package/`). */
function stripCommonRoot(entries: RawEntry[]): RawEntry[] {
  const files = entries.filter((e) => e.type === "file");
  if (files.length === 0) return entries;
  const first = files[0].path.split("/")[0];
  const allUnder = entries.every((e) => e.path === first || e.path.startsWith(`${first}/`));
  if (!allUnder || files.some((f) => f.path === first)) return entries;
  return entries.filter((e) => e.path !== first).map((e) => ({ ...e, path: e.path.slice(first.length + 1) }));
}

/**
 * Extract an archive into `destDir`, which must exist and be empty (callers
 * create it fresh, so no pre-existing symlink can redirect a write).
 * Returns the extracted relative file paths.
 */
export function extractTar(archive: Buffer, destDir: string, limits: TarLimits = {}): string[] {
  if (readdirSync(destDir).length > 0) throw new TarError(`extraction target is not empty: ${destDir}`);
  const entries = stripCommonRoot(readTar(archive, limits));
  const written: string[] = [];
  for (const entry of entries) {
    const target = join(destDir, ...entry.path.split("/"));
    if (entry.type === "dir") {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    const parts = entry.path.split("/");
    if (parts.length > 1) mkdirSync(join(destDir, ...parts.slice(0, -1)), { recursive: true, mode: 0o755 });
    // "wx": never follow or replace anything already at the target
    const fd = openSync(target, "wx", 0o644);
    try {
      let off = 0;
      while (off < entry.data.length) off += writeSync(fd, entry.data, off);
    } finally {
      closeSync(fd);
    }
    written.push(entry.path);
  }
  return written;
}

// ── Writer ──────────────────────────────────────────────────────────────────

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

function headerBlock(name: string, size: number, type: "0" | "5" | "x"): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(checksum(header).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

function entryBlocks(path: string, type: "0" | "5", data: Buffer): Buffer[] {
  const blocks: Buffer[] = [];
  if (Buffer.byteLength(path) > 99) {
    // pax "path" record: "<len> path=<value>\n", where <len> counts itself
    const body = ` path=${path}\n`;
    let len = Buffer.byteLength(body) + 1;
    while (String(len).length + Buffer.byteLength(body) !== len) len++;
    const record = Buffer.from(`${len}${body}`, "utf8");
    blocks.push(headerBlock("PaxHeader", record.length, "x"), ...padded(record));
  }
  blocks.push(headerBlock(path.slice(0, 99), data.length, type), ...padded(data));
  return blocks;
}

/** Deterministic ustar of `srcDir` (see module doc). */
export function packDirectory(srcDir: string, limits: TarLimits = {}): Buffer {
  const lim = { ...DEFAULTS, ...limits };
  const blocks: Buffer[] = [];
  let count = 0;
  let total = 0;
  const walk = (rel: string): void => {
    const names = readdirSync(rel ? join(srcDir, rel) : srcDir).sort();
    for (const name of names) {
      if (!rel && name === ".git") continue;
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(srcDir, relPath));
      if (++count > lim.maxEntries) throw new TarError(`more than ${lim.maxEntries} entries`);
      if (st.isDirectory()) {
        blocks.push(...entryBlocks(`${relPath}/`, "5", Buffer.alloc(0)));
        walk(relPath);
      } else if (st.isFile()) {
        if (st.size > lim.maxFileBytes) throw new TarError(`"${relPath}" is larger than ${lim.maxFileBytes} bytes`);
        total += st.size;
        if (total > lim.maxTotalBytes) throw new TarError(`directory is larger than ${lim.maxTotalBytes} bytes`);
        blocks.push(...entryBlocks(relPath, "0", readFileSync(join(srcDir, relPath))));
      } else {
        throw new TarError(`"${relPath}" is not a regular file or directory (symlinks are not packed)`);
      }
    }
  };
  walk("");
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}
