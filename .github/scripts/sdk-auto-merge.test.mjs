// Run: node --test .github/scripts/sdk-auto-merge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { SDK, changedLockKeys, decide, isMinorOrPatchUpgrade, parseVersion } from "./sdk-auto-merge.mjs";

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);
const SDK_KEY = `node_modules/${SDK}`;

function manifests(version, { range = `^${version}`, extra = {} } = {}) {
  const packageJson = {
    name: "app",
    dependencies: { [SDK]: range, react: "^18.0.0", ...extra },
  };
  const lock = {
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": { name: "app", dependencies: { [SDK]: range, react: "^18.0.0" } },
      [SDK_KEY]: {
        version,
        resolved: `https://registry.npmjs.org/${SDK}/-/x-${version}.tgz`,
        integrity: `sha-${version}`,
      },
      "node_modules/react": { version: "18.3.1" },
    },
  };
  return { packageJson, lock };
}

// A realistic Dependabot minor bump: the SDK entry, the root range and nothing else.
function minorBump() {
  return {
    base: manifests("1.24.2"),
    head: manifests("1.25.0"),
  };
}

function scenario(overrides = {}) {
  const { base, head } = minorBump();
  return {
    pr: {
      user: { login: "dependabot[bot]" },
      state: "open",
      draft: false,
      base: { ref: "main" },
      head: { sha: SHA_HEAD },
    },
    expectedHeadSha: SHA_HEAD,
    defaultBranch: "main",
    changedFiles: ["package.json", "package-lock.json"],
    base,
    head,
    ...overrides,
  };
}

test("parseVersion accepts plain x.y.z and rejects anything else", () => {
  assert.deepEqual(parseVersion("1.24.2"), [1, 24, 2]);
  assert.equal(parseVersion("1.24"), null);
  assert.equal(parseVersion("1.24.2-beta.1"), null);
  assert.equal(parseVersion(undefined), null);
});

test("isMinorOrPatchUpgrade allows newer minor and patch releases in the same major", () => {
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "1.25.0"), true);
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "1.24.3"), true);
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "1.99.0"), true);
});

test("isMinorOrPatchUpgrade refuses major bumps, downgrades, no-ops and unparseable versions", () => {
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "2.0.0"), false);
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "1.24.1"), false);
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "1.24.2"), false);
  assert.equal(isMinorOrPatchUpgrade("1.24.2", "latest"), false);
  assert.equal(isMinorOrPatchUpgrade(undefined, "1.25.0"), false);
});

test("changedLockKeys reports only the entries that differ", () => {
  const { base, head } = minorBump();
  assert.deepEqual(changedLockKeys(base.lock, head.lock).sort(), ["", SDK_KEY].sort());
});

test("a clean SDK minor bump is merged", () => {
  const result = decide(scenario());
  assert.equal(result.merge, true, result.reasons.join("; "));
  assert.equal(result.from, "1.24.2");
  assert.equal(result.to, "1.25.0");
});

test("a clean SDK patch bump is merged", () => {
  const result = decide(scenario({ head: manifests("1.24.3") }));
  assert.equal(result.merge, true, result.reasons.join("; "));
  assert.equal(result.to, "1.24.3");
});

test("a major bump is left open", () => {
  const result = decide(scenario({ head: manifests("2.0.0") }));
  assert.equal(result.merge, false);
  assert.match(result.reasons.join(" "), /not a minor or patch upgrade/);
});

test("a PR from anyone other than Dependabot is left open", () => {
  const scenarioPr = scenario();
  scenarioPr.pr.user.login = "someone";
  assert.match(decide(scenarioPr).reasons.join(" "), /not dependabot/);
});

test("a PR whose head moved after the CI run is left open", () => {
  const s = scenario();
  s.pr.head.sha = "c".repeat(40);
  assert.match(decide(s).reasons.join(" "), /head changed/);
});

test("a PR that changes a workflow file is left open", () => {
  const s = scenario({ changedFiles: ["package.json", "package-lock.json", ".github/workflows/ci.yml"] });
  assert.match(decide(s).reasons.join(" "), /files other than the package manifests: \.github\/workflows\/ci\.yml/);
});

test("a PR that changes another package.json dependency is left open", () => {
  const s = scenario({ head: manifests("1.25.0", { extra: { axios: "^1.7.0" } }) });
  assert.match(decide(s).reasons.join(" "), /package\.json changes beyond the SDK range/);
});

test("a PR that adds a new lockfile entry (for example a transitive dependency) is left open", () => {
  const s = scenario();
  s.head.lock.packages["node_modules/new-transitive"] = { version: "0.1.0" };
  assert.match(decide(s).reasons.join(" "), /lockfile entries other than the SDK changed \(1/);
});

test("a PR against a branch other than the default is left open", () => {
  const s = scenario();
  s.pr.base.ref = "develop";
  assert.match(decide(s).reasons.join(" "), /base branch is not main/);
});

test("a draft PR is left open", () => {
  const s = scenario();
  s.pr.draft = true;
  assert.match(decide(s).reasons.join(" "), /draft/);
});

test("a PR with no changed files is left open", () => {
  assert.match(decide(scenario({ changedFiles: [] })).reasons.join(" "), /changes no files/);
});

test("a missing lockfile on either side is left open rather than guessed", () => {
  const s = scenario();
  s.head.lock = null;
  assert.equal(decide(s).merge, false);
});
