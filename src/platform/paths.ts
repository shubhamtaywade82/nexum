/**
 * Path resolution for workspace/global state (docs/REBRANDING.md §4).
 * Workspace state lives under `.nexum/`, global state under `~/.nexum/`.
 */

import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "./brand.js";
import { readEnv } from "./environment.js";

/** Workspace state directory: `<root>/.nexum`. */
export function workspaceStateDir(root: string): string {
  return join(root, BRAND.configDir);
}

/** Global state directory: `~/.nexum`. */
export function globalStateDir(home: string = homedir()): string {
  return join(home, BRAND.configDir);
}

/** Readline history file at the workspace root: `.nexum_history`. */
export function historyFile(root: string): string {
  return join(root, `${BRAND.configDir}_history`);
}

/**
 * Resolve the workspace root the same way editor tooling does: walk up from
 * cwd to the nearest `.git`, then to the nearest `.nexum` directory (for
 * non-git workspaces), then cwd. An explicit NEXUM_WORKSPACE always wins.
 */
export function findWorkspaceRoot(cwd: string, home: string = homedir()): string {
  const override = readEnv("WORKSPACE");
  if (override) return override;

  const root = resolve("/");
  const isTemp = (d: string) => d === resolve(tmpdir()) || d === "/tmp" || d === "/private/tmp";
  const walkUpTo = (marker: string): string | null => {
    let dir = resolve(cwd);
    while (dir !== root) {
      if (existsSync(join(dir, marker)) && dir !== home && !isTemp(dir)) return dir;
      dir = resolve(dir, "..");
    }
    return null;
  };

  return walkUpTo(".git") ?? walkUpTo(BRAND.configDir) ?? cwd;
}
