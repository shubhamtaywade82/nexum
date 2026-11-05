import { lstatSync, readdirSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { isSensitivePath } from "../../safety/path-policy.js";

/** Directories never scanned for secrets (dependency/build trees, VCS). */
const SCAN_SKIP_DIRS = new Set([".git", "node_modules", "vendor", ".venv", "venv", "dist", "build", "target", ".next"]);

/** Entries scanned before giving up; callers fail closed on overflow. */
export const MAX_SCAN_ENTRIES = 100_000;

export class SensitiveScanLimitError extends Error {
  constructor(readonly limit: number) {
    super(`more than ${limit} entries to scan for secrets`);
    this.name = "SensitiveScanLimitError";
  }
}

export interface SensitiveEntry {
  path: string;
  dir: boolean;
  /** A differently-named hardlink to a secret file (same device + inode). */
  alias?: boolean;
}

export interface ScanOptions {
  /** Also report regular files that are hardlinks to one of these inodes (see secretInodes). */
  aliasInodes?: ReadonlySet<string>;
}

/**
 * Sensitive files/directories under `dir`, judged by their path relative to
 * `root` (a sensitive directory is reported once, not descended into).
 * Symlinks are neither followed nor reported. Throws SensitiveScanLimitError
 * past `limit` entries so callers can fail closed.
 */
export function findSensitivePaths(
  root: string,
  dir: string = root,
  limit = MAX_SCAN_ENTRIES,
  opts: ScanOptions = {},
): SensitiveEntry[] {
  const found: SensitiveEntry[] = [];
  let scanned = 0;
  const walk = (current: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++scanned > limit) throw new SensitiveScanLimitError(limit);
      const full = join(current, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        if (isSensitivePath(`${rel}${sep}`)) found.push({ path: full, dir: true });
        else if (!SCAN_SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        if (isSensitivePath(rel)) found.push({ path: full, dir: false });
        else if (opts.aliasInodes?.size && isAliasOf(full, opts.aliasInodes))
          found.push({ path: full, dir: false, alias: true });
      }
    }
  };
  walk(dir);
  return found;
}

// ── hardlinks ───────────────────────────────────────────────────────────────

/** Credential stores outside any workspace that a hardlink could alias. */
export function defaultCredentialLocations(): string[] {
  const home = homedir();
  return [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".azure",
    join(".config", "gcloud"),
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
  ].map((p) => join(home, p));
}

export function inodeKey(st: Pick<Stats, "dev" | "ino">): string {
  return `${st.dev}:${st.ino}`;
}

function isAliasOf(path: string, inodes: ReadonlySet<string>): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.nlink > 1 && inodes.has(inodeKey(st));
  } catch {
    return false;
  }
}

/** Regular files under `dir` (bounded), for collecting secret inodes. */
function collectFiles(dir: string, into: Set<string>, budget: { left: number }): void {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (st.isFile()) {
    into.add(inodeKey(st));
    return;
  }
  if (!st.isDirectory()) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (--budget.left < 0) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, into, budget);
    else if (entry.isFile()) {
      try {
        into.add(inodeKey(lstatSync(full)));
      } catch {
        // vanished — skip
      }
    }
  }
}

/**
 * device:inode of every secret file: sensitive paths in the workspace plus
 * credential files at `locations`. A regular file sharing one of these
 * inodes is the secret under another name.
 */
export function secretInodes(root: string, locations: readonly string[] = defaultCredentialLocations()): Set<string> {
  const inodes = new Set<string>();
  const budget = { left: MAX_SCAN_ENTRIES };
  for (const entry of findSensitivePaths(root)) collectFiles(entry.path, inodes, budget);
  for (const location of locations) collectFiles(location, inodes, budget);
  return inodes;
}
