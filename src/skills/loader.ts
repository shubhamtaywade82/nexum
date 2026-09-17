/**
 * Discovers and loads skills from disk. Never throws for a single bad
 * skill directory — malformed or missing SKILL.md is skipped, not fatal,
 * since skills are an optional enhancement, not a hard dependency.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import matter from "@11ty/gray-matter";
import { SkillContent, SkillMeta, SkillScope } from "./types.js";
import { legacyWorkspaceStateDir, workspaceStateDir } from "../platform/paths.js";

export interface DiscoverOptions {
  workspaceRoot: string;
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
}

function skillsDirs(root: string): string[] {
  // Canonical .nexum/skills, plus legacy .devagent/skills as a deprecated
  // fallback so pre-rename workspaces keep working until migrated
  // (docs/REBRANDING.md §4).
  return [join(workspaceStateDir(root), "skills"), join(legacyWorkspaceStateDir(root), "skills")];
}

function listSkillDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const dir of skillsDirs(root)) {
    if (!existsSync(dir)) continue;
    try {
      dirs.push(
        ...readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(dir, e.name)),
      );
    } catch {
      // unreadable skills directory — skip, not fatal
    }
  }
  return dirs;
}

function listResourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Reads and parses one skill's SKILL.md into SkillMeta. Returns null if missing/malformed. */
export function loadSkillMeta(skillDir: string, scope: SkillScope): SkillMeta | null {
  const path = join(skillDir, "SKILL.md");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const { data } = matter(raw);
    const id = skillDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
    if (!id) return null;
    return {
      id,
      name: typeof data.name === "string" && data.name ? data.name : id,
      description: typeof data.description === "string" ? data.description : "",
      tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string") : [],
      version: typeof data.version === "string" && data.version ? data.version : "0.0.0",
      language: typeof data.language === "string" && data.language ? data.language : undefined,
      scope,
      dir: skillDir,
      path,
    };
  } catch {
    return null;
  }
}

/**
 * Scans .nexum/skills/ (workspace) and ~/.nexum/skills/ (global) for skill
 * directories, parsing SKILL.md frontmatter only (cheap). Legacy
 * .devagent/skills/ locations are scanned as deprecated fallbacks. Workspace
 * skills override global skills sharing an id.
 */
export function discoverSkills(opts: DiscoverOptions): SkillMeta[] {
  const home = opts.homeDir ?? homedir();
  // listSkillDirs already scans both .nexum/skills and .devagent/skills
  // under the given root (canonical first, so a migrated skill is never
  // shadowed by its stale legacy copy — same id, same scope → first wins).
  const global = listSkillDirs(home)
    .map((dir) => loadSkillMeta(dir, "global"))
    .filter((s): s is SkillMeta => s != null);
  const workspace = listSkillDirs(opts.workspaceRoot)
    .map((dir) => loadSkillMeta(dir, "workspace"))
    .filter((s): s is SkillMeta => s != null);

  const byId = new Map<string, SkillMeta>();
  // First-wins per id per scope: canonical roots are listed before legacy, so
  // a migrated/canonical skill is never shadowed by its stale legacy copy;
  // workspace always beats global.
  for (const skill of global) {
    const existing = byId.get(skill.id);
    if (!existing || existing.scope !== skill.scope) byId.set(skill.id, skill);
  }
  for (const skill of workspace) {
    const existing = byId.get(skill.id);
    if (!existing || existing.scope !== skill.scope) byId.set(skill.id, skill); // workspace wins
  }
  return [...byId.values()];
}

/** Lazily loads full content (body + reference/script/template listings) for one skill. */
export function loadSkillContent(meta: SkillMeta): SkillContent {
  const raw = readFileSync(meta.path, "utf8");
  const { content } = matter(raw);
  return {
    ...meta,
    body: content.trim(),
    references: listResourceFiles(join(meta.dir, "references")),
    scripts: listResourceFiles(join(meta.dir, "scripts")),
    templates: listResourceFiles(join(meta.dir, "templates")),
  };
}
