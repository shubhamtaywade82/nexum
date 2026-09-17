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