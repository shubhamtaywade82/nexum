// Merges a Dependabot bump of @nemesis-oss/ollama-sdk when it is a minor or patch
// upgrade and changes nothing else. Anything else stays open for a human.
//
// Runs from the sdk-auto-merge workflow on the default branch, after CI has passed
// for the PR head. It reads PR data through the GitHub API and never checks out or
// executes code from the pull request.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SDK = "@nemesis-oss/ollama-sdk";
const SDK_LOCK_KEY = `node_modules/${SDK}`;
const ALLOWED_FILES = new Set(["package.json", "package-lock.json"]);
const DEPENDABOT = "dependabot[bot]";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text) {
  const match = SEMVER.exec(typeof text === "string" ? text : "");
  return match ? match.slice(1).map(Number) : null;
}

// A minor or patch upgrade keeps the major version and moves to a newer release.
export function isMinorOrPatchUpgrade(fromText, toText) {
  const from = parseVersion(fromText);
  const to = parseVersion(toText);
  if (!from || !to || to[0] !== from[0]) return false;
  for (const index of [1, 2]) {
    if (to[index] !== from[index]) return to[index] > from[index];
  }
  return false;
}

// package.json with the SDK range removed, so any other change shows up as a difference.
function withoutSdkRange(pkg) {
  const copy = structuredClone(pkg);
  if (copy.dependencies) delete copy.dependencies[SDK];
  if (copy.devDependencies) delete copy.devDependencies[SDK];
  return copy;
}

// Lockfile package entries that differ between base and head.
export function changedLockKeys(baseLock, headLock) {
  const basePackages = baseLock.packages ?? {};
  const headPackages = headLock.packages ?? {};
  const keys = new Set([...Object.keys(basePackages), ...Object.keys(headPackages)]);
  return [...keys].filter((key) => JSON.stringify(basePackages[key]) !== JSON.stringify(headPackages[key]));
}

// `base` and `head` are { packageJson, lock } at each commit. `lock` may be null.
export function decide({ pr, expectedHeadSha, defaultBranch, changedFiles, base, head }) {
  const reasons = [];
  if (pr.user?.login !== DEPENDABOT) reasons.push("PR author is not dependabot[bot]");
  if (pr.state !== "open") reasons.push("PR is not open");
  if (pr.draft) reasons.push("PR is a draft");
  if (pr.base?.ref !== defaultBranch) reasons.push(`base branch is not ${defaultBranch}`);
  if (pr.head?.sha !== expectedHeadSha) reasons.push("PR head changed after the CI run");

  if (changedFiles.length === 0) {
    reasons.push("PR changes no files");
  } else {
    const stray = changedFiles.filter((file) => !ALLOWED_FILES.has(file));
    if (stray.length > 0) reasons.push(`PR changes files other than the package manifests: ${stray.join(", ")}`);
  }

  const fromVersion = base.lock?.packages?.[SDK_LOCK_KEY]?.version;
  const toVersion = head.lock?.packages?.[SDK_LOCK_KEY]?.version;
  if (!isMinorOrPatchUpgrade(fromVersion, toVersion)) {
    reasons.push(`not a minor or patch upgrade of ${SDK} (${fromVersion ?? "none"} -> ${toVersion ?? "none"})`);
  }

  const otherManifestChanges =
    JSON.stringify(withoutSdkRange(base.packageJson ?? {})) !== JSON.stringify(withoutSdkRange(head.packageJson ?? {}));
  if (otherManifestChanges) reasons.push("package.json changes beyond the SDK range");

  // The root entry ("") carries the SDK range. Any other lockfile entry, including a
  // new transitive dependency, is a change a person should read.
  const unexpected = changedLockKeys(base.lock ?? {}, head.lock ?? {}).filter(
    (key) => key !== "" && key !== SDK_LOCK_KEY,
  );
  if (unexpected.length > 0) {
    reasons.push(`lockfile entries other than the SDK changed (${unexpected.length}, first: ${unexpected[0]})`);
  }

  return { merge: reasons.length === 0, reasons, from: fromVersion, to: toVersion };
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function fetchRaw(repo, path, sha) {
  try {
    return gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${sha}`]);
  } catch {
    return null;
  }
}

function loadManifests(repo, sha) {
  const packageText = fetchRaw(repo, "package.json", sha);
  const lockText = fetchRaw(repo, "package-lock.json", sha);
  if (packageText === null) throw new Error(`package.json missing at ${sha}`);
  return {
    packageJson: JSON.parse(packageText),
    lock: lockText === null ? null : JSON.parse(lockText),
  };
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function main(env = process.env) {
  const repo = required(env, "REPO");
  const headBranch = required(env, "HEAD_BRANCH");
  const expectedHeadSha = required(env, "HEAD_SHA");
  const defaultBranch = required(env, "DEFAULT_BRANCH");

  const open = JSON.parse(
    gh(["pr", "list", "--repo", repo, "--state", "open", "--head", headBranch, "--json", "number"]),
  );
  if (open.length === 0) {
    console.log(`No open PR for ${headBranch}; nothing to merge.`);
    return 0;
  }
  if (open.length > 1) throw new Error(`${open.length} open PRs share head ${headBranch}; refusing to choose`);

  const number = open[0].number;
  const pr = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`]));
  const changedFiles = gh(["api", "--paginate", `repos/${repo}/pulls/${number}/files`, "--jq", ".[].filename"])
    .split("\n")
    .filter(Boolean);

  const decision = decide({
    pr,
    expectedHeadSha,
    defaultBranch,
    changedFiles,
    base: loadManifests(repo, pr.base.sha),
    head: loadManifests(repo, pr.head.sha),
  });

  if (!decision.merge) {
    console.log(`Not merging PR #${number}: ${decision.reasons.join("; ")}`);
    return 0;
  }

  gh(["pr", "merge", String(number), "--repo", repo, "--squash", "--match-head-commit", expectedHeadSha]);
  console.log(`Merged PR #${number}: ${SDK} ${decision.from} -> ${decision.to}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
