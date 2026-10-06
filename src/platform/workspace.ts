/**
 * WorkspaceManager — owns every decision about where persistent state lives
 * (docs/REBRANDING.md §4). Agent/CLI code asks it for paths; nothing else
 * decides where `.nexum` is or when a legacy `.devagent` workspace migrates.
 *
 * Migration properties (all enforced, all tested):
 *   - atomic:      the marker file is written LAST and is the commit point;
 *                  an interrupted migration leaves no marker and simply re-runs
 *   - idempotent:  entries already present in .nexum are never overwritten
 *                  (merge-on-copy); a completed migration is a no-op
 *   - recoverable: per-entry copy failures are collected and reported; one
 *                  bad entry never aborts the rest, and the source is untouched
 *   - non-destructive: .devagent is COPIED, never moved or deleted
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import {
  globalStateDir,
  historyFile,
  legacyGlobalStateDir,
  legacyHistoryFile,
  legacyWorkspaceStateDir,
  workspaceStateDir,
} from "./paths.js";

/** State entries carried over from a legacy `.devagent` workspace. */
const FILE_ENTRIES = [
  "memory.db",
  "checkpoint.json",
  "docs.db",
  "config.json",
  "models.json",
  "lessons.db",
  "history.json",
  "rails-index.db",
] as const;
const DIR_ENTRIES = ["sessions", "skills", "backups"] as const;

export type EntryStatus = "copied" | "skipped" | "failed";

export interface MigrationEntry {
  name: string;
  status: EntryStatus;
  detail?: string;
}

export interface MigrationReport {
  /** A copy actually happened this call. */
  migrated: boolean;
  /** Marker already existed — nothing to do. */
  alreadyMigrated: boolean;
  /** Legacy `.devagent` directory that was (or would be) migrated. */
  source: string | null;
  entries: MigrationEntry[];
  /** Workspace-root history file `.devagent_history` → `.nexum_history`. */
  historyMigrated: boolean;
  /** Marker file path (commit point), when a migration completed. */
  marker: string | null;
  /** Set when the workspace could not be initialized at all. */
  error?: string;
}

export interface WorkspacePaths {
  /** `<root>/.nexum` */
  dir: string;
  memoryDb: string;
  checkpoint: string;
  sessionsDir: string;
  docsDb: string;
  configFile: string;
  skillsDir: string;
  modelsCache: string;
  /** Learning engine database (`lessons.db`). */
  lessonsDb: string;
  /** TUI command history (`history.json`). */
  historyFile: string;
  /** Snapshot backup root (`backups/`). */
  backupsDir: string;
}

export interface WorkspaceDetection {
  root: string;
  hasCurrent: boolean;
  hasLegacy: boolean;
}

export class WorkspaceManager {
  readonly root: string;
  readonly dir: string;
  readonly legacyDir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = workspaceStateDir(root);
    this.legacyDir = legacyWorkspaceStateDir(root);
  }

  /** Marker file — the single commit point of a completed migration. */
  get markerFile(): string {
    return join(this.dir, ".migrated-from-devagent.json");
  }

  detect(): WorkspaceDetection {
    return {
      root: this.root,
      hasCurrent: existsSync(this.dir),
      hasLegacy: existsSync(this.legacyDir),
    };
  }

  hasMigrationMarker(): boolean {
    return existsSync(this.markerFile);
  }

  /**
   * Migrate legacy `.devagent` state into `.nexum` (copy, never delete).
   * Safe to call repeatedly; returns what happened for reporting.
   */
  migrate(): MigrationReport {
    const { hasCurrent, hasLegacy } = this.detect();
    const report: MigrationReport = {
      migrated: false,
      alreadyMigrated: false,
      source: hasLegacy ? this.legacyDir : null,
      entries: [],
      historyMigrated: false,
      marker: null,
    };

    // Completed migration: the marker is the commit point — nothing to do.
    if (hasCurrent && this.hasMigrationMarker()) {
      report.alreadyMigrated = true;
      report.marker = this.markerFile;
      return report;
    }

    try {
      // Ensure the target exists before copying anything (initializes a fresh
      // .nexum even for workspaces with no legacy state at all).
      if (!hasCurrent) mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
      return report;
    }

    if (hasLegacy) {
      for (const name of FILE_ENTRIES) {
        report.entries.push(this.copyEntry(name, false));
      }
      for (const name of DIR_ENTRIES) {
        report.entries.push(this.copyEntry(name, true));
      }
      // Root-level history convenience file.
      const legacyHist = legacyHistoryFile(this.root);
      if (existsSync(legacyHist)) {
        const target = historyFile(this.root);
        if (!existsSync(target)) {
          try {
            cpSync(legacyHist, target);
            report.historyMigrated = true;
          } catch (err) {
            report.entries.push({
              name: `${BRAND.legacyConfigDir}_history`,
              status: "failed",
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      report.migrated = report.entries.some((e) => e.status !== "failed") || report.historyMigrated;
      // Commit point: marker last. A crash above leaves no marker and the
      // next run re-copies (skipping anything already present).
      try {
        writeFileSync(
          this.markerFile,
          JSON.stringify(
            {
              product: BRAND.cli,
              migratedAt: new Date().toISOString(),
              source: BRAND.legacyConfigDir,
              entries: report.entries,
            },
            null,
            2,
          ),
          "utf8",
        );
        report.marker = this.markerFile;
      } catch (err) {
        report.error = err instanceof Error ? err.message : String(err);
      }
    }

    return report;
  }

  private copyEntry(name: string, isDir: boolean): MigrationEntry {
    const src = join(this.legacyDir, name);
    const dest = join(this.dir, name);
    if (!existsSync(src)) return { name, status: "skipped" };
    if (existsSync(dest)) return { name, status: "skipped" }; // never overwrite newer .nexum state
    try {
      cpSync(src, dest, { recursive: isDir, force: false });
      return { name, status: "copied" };
    } catch (err) {
      return { name, status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Resolve the workspace for use: initialize `.nexum`, migrate any legacy
   * `.devagent` state, and hand back canonical paths. Every runtime entry
   * point (Agent, TUI, docs CLI) goes through this — never `mkdir` `.nexum`
   * ad hoc elsewhere.
   */
  ensure(): WorkspacePaths {
    const { hasCurrent, hasLegacy } = this.detect();
    if (!hasCurrent || (hasLegacy && !this.hasMigrationMarker())) {
      this.migrate();
    }
    return this.paths();
  }

  /** Canonical state paths (does not touch the filesystem). */
  paths(): WorkspacePaths {
    return {
      dir: this.dir,
      memoryDb: join(this.dir, "memory.db"),
      checkpoint: join(this.dir, "checkpoint.json"),
      sessionsDir: join(this.dir, "sessions"),
      docsDb: join(this.dir, "docs.db"),
      configFile: join(this.dir, "config.json"),
      skillsDir: join(this.dir, "skills"),
      modelsCache: join(this.dir, "models.json"),
      lessonsDb: join(this.dir, "lessons.db"),
      historyFile: join(this.dir, "history.json"),
      backupsDir: join(this.dir, "backups"),
    };
  }

  /** Count files under a directory recursively (reporting only). */
  static countFiles(dir: string): number {
    if (!existsSync(dir)) return 0;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) return 1;
      let n = 0;
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name));
          else n++;
        }
      };
      walk(dir);
      return n;
    } catch {
      return 0;
    }
  }
}

function homedirSafe(): string {
  try {
    return homedir();
  } catch {
    return process.cwd();
  }
}

/**
 * Migrate global state `~/.devagent` → `~/.nexum` (config.json, .env,
 * skills/). Same copy-never-delete semantics as workspace migration. Read
 * fallbacks in cli/config.ts keep a non-migrated global dir usable too.
 */
export function migrateGlobalState(home: string = homedirSafe()): MigrationReport {
  const target = globalStateDir(home);
  const source = legacyGlobalStateDir(home);
  const report: MigrationReport = {
    migrated: false,
    alreadyMigrated: false,
    source: existsSync(source) ? source : null,
    entries: [],
    historyMigrated: false,
    marker: null,
  };

  if (!existsSync(source)) {
    if (!existsSync(target)) {
      try {
        mkdirSync(target, { recursive: true });
      } catch (err) {
        report.error = err instanceof Error ? err.message : String(err);
      }
    }
    return report;
  }

  try {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    return report;
  }

  const markerPath = join(target, ".migrated-from-devagent.json");
  if (existsSync(markerPath)) {
    report.alreadyMigrated = true;
    report.marker = markerPath;
    return report;
  }

  for (const name of ["config.json", ".env", "skills"] as const) {
    const src = join(source, name);
    const dest = join(target, name);
    if (!existsSync(src) || existsSync(dest)) {
      report.entries.push({ name, status: "skipped" });
      continue;
    }
    try {
      cpSync(src, dest, { recursive: name === "skills", force: false });
      report.entries.push({ name, status: "copied" });
    } catch (err) {
      report.entries.push({ name, status: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  report.migrated = report.entries.some((e) => e.status === "copied");
  try {
    writeFileSync(
      markerPath,
      JSON.stringify(
        { product: BRAND.cli, migratedAt: new Date().toISOString(), source: BRAND.legacyConfigDir },
        null,
        2,
      ),
      "utf8",
    );
    report.marker = markerPath;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}
