import type { OpenPullRequest } from "./types.js";

/** Branches with this prefix are heal branches, reconciled only from the ledger. */
export const MANAGED_PREFIX = "fix/ci-";

export type Target = { ok: true; kind: "default" | "feature"; base: string } | { ok: false; reason: string };

/**
 * A failing run on the default branch heals against the default branch. A failing
 * run on another branch heals only when that branch has an open, same-repo,
 * non-draft PR. Any fix/ci-* branch is refused here: the ledger alone owns those.
 */
export function targetFor(branch: string, defaultBranch: string, openPrs: readonly OpenPullRequest[]): Target {
  if (branch === defaultBranch) return { ok: true, kind: "default", base: defaultBranch };
  if (branch.startsWith(MANAGED_PREFIX)) {
    return { ok: false, reason: "fix/ci-* branches are reconciled from the ledger only" };
  }
  const pr = openPrs.find((candidate) => candidate.headRefName === branch);
  if (!pr) return { ok: false, reason: `no open PR for ${branch}` };
  if (pr.isCrossRepository) return { ok: false, reason: "fork PR; the daemon cannot push to it" };
  if (pr.isDraft) return { ok: false, reason: "draft PR; its author is still working" };
  return { ok: true, kind: "feature", base: branch };
}

export function sanitizeBranchPart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** fix/ci-<base>-<run>, e.g. fix/ci-main-111 or fix/ci-feat-a-9. */
export function healBranchName(base: string, runId: number): string {
  return `${MANAGED_PREFIX}${sanitizeBranchPart(base)}-${runId}`;
}

/**
 * Glob to anchored RegExp with the semantics the Ruby tool relies on
 * (File.fnmatch with FNM_PATHNAME | FNM_DOTMATCH): `**` crosses directories,
 * `*` and `?` stay within one path segment, and dotfiles match.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 3;
      } else {
        source += ".*";
        index += 2;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

/** Paths the agent may never change, however green the result looks. */
export function forbiddenPaths(paths: readonly string[], patterns: readonly string[]): string[] {
  const matchers = patterns.map(globToRegExp);
  return paths.filter((path) => matchers.some((matcher) => matcher.test(path)));
}
