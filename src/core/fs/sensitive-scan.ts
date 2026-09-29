import { readdirSync, type Dirent } from "node:fs";
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
}

/**
 * Sensitive files/directories under `dir`, judged by their path relative to
 * `root` (a sensitive directory is reported once, not descended into).
 * Symlinks are neither followed nor reported. Throws SensitiveScanLimitError
 * past `limit` entries so callers can fail closed.
 */
export function findSensitivePaths(root: string, dir: string = root, limit = MAX_SCAN_ENTRIES): SensitiveEntry[] {
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
      } else if (entry.isFile() && isSensitivePath(rel)) {
        found.push({ path: full, dir: false });
      }
    }
  };
  walk(dir);
  return found;
}
