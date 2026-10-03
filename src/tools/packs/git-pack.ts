/**
 * GitPack + GitHubPack (review item 21) — version control surfaces.
 *
 * Split per the review: local git operations vs GitHub (external mutation)
 * are SEPARATE packs so products can mount git without granting the
 * GitHub API surface (and vice versa). The legacy combined gitPack
 * remains as a compat export.
 */

import { GitReadTool, GitTool } from "../git-tools.js";
import { GitHubTool } from "../github-tools.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";
import type { ToolRisk } from "../../core/tools/tool-contract.js";

/** Local git operations (commit, diff, log, status — no push). */
export function gitPack(root: string): ToolPack {
  return packOf(
    "git",
    "Local git operations: status, diff, log, commit.",
    "vcs",
    [
      { tool: new GitTool(root), category: "Git", metadata: { risk: "high" as ToolRisk } },
      {
        tool: new GitReadTool(root),
        category: "Git",
        metadata: {
          risk: "read" as ToolRisk,
          sideEffects: { filesystem: false, process: true },
          policy: { confirmation: "never", uiInvocable: true },
        },
      },
    ],
    "Git",
  );
}

/** GitHub API surface (PRs, issues, checks — external mutation). */
export function githubPack(root: string): ToolPack {
  return packOf(
    "github",
    "GitHub operations: PRs, issues, reviews (external mutation).",
    "vcs",
    [
      {
        tool: new GitHubTool(root),
        category: "GitHub",
        metadata: { risk: "high" as ToolRisk, sideEffects: { network: true, externalMutation: true } },
      },
    ],
    "GitHub",
  );
}

/**
 * @deprecated mount gitPack + githubPack separately (review item 21).
 * Compat: the historical combined pack.
 */
export function gitGithubPack(root: string): ToolPack {
  return packOf(
    "git",
    "Git and GitHub operations.",
    "vcs",
    [new GitTool(root), new GitHubTool(root)].map((tool) => ({
      tool,
      category: "Git",
      metadata: { risk: "high" as ToolRisk },
    })),
    "Git",
  );
}
