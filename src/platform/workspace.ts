/**
 * WorkspaceManager — owns where persistent workspace state lives
 * (docs/REBRANDING.md §4). Agent/CLI code asks it for paths; nothing else
 * decides where `.nexum` is.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceStateDir } from "./paths.js";

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

export class WorkspaceManager {
  readonly root: string;
  readonly dir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = workspaceStateDir(root);
  }

  /** Create `.nexum` if missing and return the canonical state paths. */
  ensure(): WorkspacePaths {
    mkdirSync(this.dir, { recursive: true });
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
}
