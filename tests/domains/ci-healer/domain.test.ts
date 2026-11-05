import { ACTIVE_STATES, canTransition } from "../../../src/domains/ci-healer/domain/lineage.js";
import {
  forbiddenPaths,
  globToRegExp,
  healBranchName,
  targetFor,
} from "../../../src/domains/ci-healer/domain/policy.js";
import { deriveChecks, latestPerWorkflow } from "../../../src/domains/ci-healer/domain/checks.js";
import { Digester } from "../../../src/domains/ci-healer/domain/digest.js";
import { buildPrompt } from "../../../src/domains/ci-healer/domain/prompt.js";
import type { OpenPullRequest, WorkflowRun } from "../../../src/domains/ci-healer/domain/types.js";

const SHA = "a".repeat(40);

const featurePr: OpenPullRequest = {
  number: 7,
  headRefName: "feature/x",
  baseRefName: "main",
  headRefOid: SHA,
  isCrossRepository: false,
  isDraft: false,
};

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: 1,
    headBranch: "main",
    headSha: SHA,
    workflowName: "CI",
    event: "push",
    status: "completed",
    conclusion: "failure",
    attempt: 1,
    createdAt: "2026-11-01T00:00:00Z",
    url: "https://example.test/runs/1",
    ...overrides,
  };
}

describe("targetFor", () => {
  it("targets the default branch for failures on it", () => {
    expect(targetFor("main", "main", [])).toEqual({ ok: true, kind: "default", base: "main" });
  });

  it("targets the failing branch when it has an open same-repo non-draft PR", () => {
    expect(targetFor("feature/x", "main", [featurePr])).toEqual({ ok: true, kind: "feature", base: "feature/x" });
  });

  it.each([
    ["no open PR", [], /no open PR/],
    ["fork PR", [{ ...featurePr, isCrossRepository: true }], /fork PR/],
    ["draft PR", [{ ...featurePr, isDraft: true }], /draft PR/],
  ])("skips a branch with %s", (_label, prs, reason) => {
    const target = targetFor("feature/x", "main", prs);
    expect(target).toMatchObject({ ok: false });
    expect(target.ok ? "" : target.reason).toMatch(reason);
  });

  it("refuses fix/ci-* branches even when they have an open PR", () => {
    const pr = { ...featurePr, headRefName: "fix/ci-main-111" };
    const target = targetFor("fix/ci-main-111", "main", [pr]);
    expect(target.ok ? "" : target.reason).toMatch(/ledger/);
  });
});

describe("healBranchName", () => {
  it("builds fix/ci-<base>-<run>", () => {
    expect(healBranchName("main", 111)).toBe("fix/ci-main-111");
  });

  it("sanitizes slashes and spaces in feature branch names", () => {
    expect(healBranchName("feat/payments retry", 9)).toBe("fix/ci-feat-payments-retry-9");
  });
});

describe("forbiddenPaths", () => {
  const patterns = [".github/workflows/**", "**/.env", "**/.env.*", "**/*.pem"];

  it("flags CI workflow edits, env files, and key material", () => {
    expect(
      forbiddenPaths([".github/workflows/ci.yml", "app/.env", "config/.env.production", "certs/server.pem"], patterns),
    ).toEqual([".github/workflows/ci.yml", "app/.env", "config/.env.production", "certs/server.pem"]);
  });

  it("leaves ordinary source files alone", () => {
    expect(forbiddenPaths(["lib/app.rb", "README.md", ".envrc"], patterns)).toEqual([]);
  });

  it("uses path-segment semantics for * and ** (matching the Ruby tool)", () => {
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("b.ts")).toBe(true);
  });
});

describe("lineage state machine", () => {
  it("allows the documented transitions and rejects the rest", () => {
    expect(canTransition("PR_OPEN", "HEALING")).toBe(true);
    expect(canTransition("EXHAUSTED", "GREEN")).toBe(true);
    expect(canTransition("HEALING", "PR_OPEN")).toBe(true);
    expect(canTransition("CLOSED", "PR_OPEN")).toBe(false);
    expect(canTransition("EXHAUSTED", "HEALING")).toBe(false);
    expect(canTransition("PR_OPEN", "PR_OPEN")).toBe(true);
  });

  it("treats only non-closed lineages as active", () => {
    expect(ACTIVE_STATES).not.toContain("CLOSED");
    expect(ACTIVE_STATES).toEqual(expect.arrayContaining(["HEALING", "PR_OPEN", "GREEN", "EXHAUSTED"]));
  });
});

describe("deriveChecks", () => {
  it("waits while any run on the head is still running", () => {
    expect(deriveChecks([run({ status: "in_progress", conclusion: "" })])).toEqual({ verdict: "pending" });
  });

  it("reports failing when a latest run failed", () => {
    expect(deriveChecks([run({ databaseId: 9 })])).toMatchObject({ verdict: "failing", run: { databaseId: 9 } });
  });

  it("ignores a failed attempt superseded by a passing re-run", () => {
    const runs = [
      run({ attempt: 1, conclusion: "failure" }),
      run({ attempt: 2, conclusion: "success", createdAt: "2026-11-01T00:05:00Z" }),
    ];
    expect(deriveChecks(runs)).toEqual({ verdict: "green" });
    expect(latestPerWorkflow(runs)).toHaveLength(1);
  });

  it("is indeterminate for conclusions the healer does not recognise", () => {
    expect(deriveChecks([run({ conclusion: "cancelled" })])).toEqual({ verdict: "indeterminate" });
  });

  it("is green when every latest run passed or was skipped", () => {
    expect(
      deriveChecks([run({ conclusion: "success" }), run({ workflowName: "Lint", conclusion: "skipped" })]),
    ).toEqual({ verdict: "green" });
  });
});

describe("Digester", () => {
  const digester = new Digester({ lineCap: 40, byteCap: 800, context: 1, tailLines: 5 });
  const gh = (text: string) => `build\tRun tests\t2026-11-01T05:48:00.1234567Z ${text}`;

  it("strips ANSI codes and the gh job/step/timestamp prefix", () => {
    expect(digester.digest(gh("\u001b[31mError: boom\u001b[0m in app/models/user.rb:12"))).toBe(
      "Error: boom in app/models/user.rb:12",
    );
  });

  it("keeps failure lines with context and drops install noise", () => {
    const raw = [
      gh("npm WARN deprecated left-pad@1.0.0"),
      gh("added 812 packages in 9s"),
      gh("Failures:"),
      gh("  1) User validates email"),
      gh("     Failure/Error: expect(user).to be_valid"),
      gh("     at ./spec/models/user_spec.rb:14"),
      gh("Finished in 0.3 seconds"),
      gh("cache restored"),
    ].join("\n");
    const digest = digester.digest(raw);
    expect(digest).toContain("Failure/Error");
    expect(digest).toContain("user_spec.rb:14");
    expect(digest).not.toContain("left-pad");
    expect(digest).not.toContain("cache restored");
  });

  it("falls back to the tail when nothing matches a failure signal", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `step line ${i + 1}`).join("\n");
    expect(digester.digest(raw).split("\n").at(-1)).toBe("step line 20");
  });

  it("caps very long digests and keeps both head and tail", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `ERROR at line ${i + 1} in lib/x.rb:${i + 1}`).join("\n");
    const digest = digester.digest(raw);
    expect(Buffer.byteLength(digest)).toBeLessThanOrEqual(800 + 60);
    expect(digest).toContain("ERROR at line 1 ");
    expect(digest).toContain("ERROR at line 500 ");
  });

  it("returns an empty digest for an empty log", () => {
    expect(digester.digest("\n\n")).toBe("");
  });
});

describe("buildPrompt", () => {
  it("wraps the CI log in a nonce-delimited block and forbids CI-config edits", () => {
    const prompt = buildPrompt({
      repo: "acme/app",
      sourceBranch: "main",
      workflow: "CI",
      runId: 9,
      attempt: 2,
      maxAttempts: 3,
      digest: "ERROR boom",
      nonce: "abc123",
    });
    expect(prompt).toContain("<<<CI_LOG_BEGIN abc123");
    expect(prompt).toContain("CI_LOG_END abc123>>>");
    expect(prompt).toContain("ERROR boom");
    expect(prompt).toContain("attempt 2 of 3");
    expect(prompt).toMatch(/Do not edit CI configuration/);
  });
});
