import { GitHubDeliveryAdapter, GitHubHttpClient, HttpResult } from "../../src/evolution/delivery/github-adapter.js";

/**
 * A merge counts only when GitHub confirms it. These tests drive the real adapter
 * against a scripted GitHub: a 200 from the merge call is never enough on its own.
 */

const REVIEWED = "a".repeat(40);
const MERGE = "b".repeat(40);
const NO_SLEEP = async () => undefined;

type Route = (path: string, init?: { method?: string; body?: unknown }) => HttpResult | Promise<HttpResult>;

function adapterWith(route: Route): { adapter: GitHubDeliveryAdapter; requests: string[] } {
  const requests: string[] = [];
  const http: GitHubHttpClient = async (path, init) => {
    requests.push(`${init?.method ?? "GET"} ${path}`);
    return route(path, init);
  };
  const adapter = new GitHubDeliveryAdapter(
    { owner: "o", repo: "r", baseBranch: "main" },
    {
      runGit: async () => ({ stdout: "", exitCode: 0, stderr: "" }),
      http,
      sleep: NO_SLEEP,
    },
  );
  return { adapter, requests };
}

const files = (...entries: Array<[string, string, string]>) => ({
  files: entries.map(([filename, status, sha]) => ({ filename, status, sha })),
});

const CANDIDATE_FILES = files(["nexum.harness.json", "modified", "blob-1"]);

/** A GitHub that reports a clean, verifiable merge. Overrides swap in one broken fact at a time. */
function honestGitHub(overrides: Partial<Record<string, HttpResult | "throw">> = {}): Route {
  const table: Record<string, HttpResult | "throw"> = {
    "GET /repos/o/r/pulls/42": {
      status: 200,
      json: { merged: true, merge_commit_sha: MERGE, head: { sha: REVIEWED } },
    },
    [`GET /repos/o/r/commits/${REVIEWED}`]: { status: 200, json: CANDIDATE_FILES },
    [`GET /repos/o/r/commits/${MERGE}`]: { status: 200, json: CANDIDATE_FILES },
    ...overrides,
  };
  return (path, init) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    const entry = table[key];
    if (entry === undefined) throw new Error(`unexpected request ${key}`);
    if (entry === "throw") throw new Error("socket hang up");
    return entry;
  };
}

describe("mergePullRequest: typed outcomes", () => {
  it("reports merged only for 200 with merged: true and a full merge commit sha", async () => {
    const { adapter } = adapterWith(() => ({ status: 200, json: { merged: true, sha: MERGE } }));
    expect(await adapter.mergePullRequest(42, REVIEWED)).toEqual({ status: "merged", mergeCommitSha: MERGE });
  });

  it("treats a 200 that does not confirm a merge as uncertain, not merged", async () => {
    const { adapter } = adapterWith(() => ({ status: 200, json: { merged: false, sha: MERGE } }));
    expect((await adapter.mergePullRequest(42, REVIEWED)).status).toBe("uncertain");
  });

  it("treats a 200 with a malformed merge sha as uncertain", async () => {
    const { adapter } = adapterWith(() => ({ status: 200, json: { merged: true, sha: "not-a-sha" } }));
    expect((await adapter.mergePullRequest(42, REVIEWED)).status).toBe("uncertain");
  });

  it("treats a 200 with no body as uncertain", async () => {
    const { adapter } = adapterWith(() => ({ status: 200, json: null }));
    expect((await adapter.mergePullRequest(42, REVIEWED)).status).toBe("uncertain");
  });

  it.each([
    [405, "not mergeable"],
    [409, "Head branch was modified"],
    [422, "Validation failed"],
  ])("reports HTTP %i as a definitive rejection", async (status, message) => {
    const { adapter } = adapterWith(() => ({ status, json: { message } }));
    expect(await adapter.mergePullRequest(42, REVIEWED)).toEqual({
      status: "rejected",
      httpStatus: status,
      reason: message,
    });
  });

  it("treats an unexpected status as uncertain", async () => {
    const { adapter } = adapterWith(() => ({ status: 500, json: { message: "boom" } }));
    expect((await adapter.mergePullRequest(42, REVIEWED)).status).toBe("uncertain");
  });

  it("treats a transport failure as uncertain instead of throwing past the gate", async () => {
    const { adapter } = adapterWith(() => {
      throw new Error("socket hang up");
    });
    const outcome = await adapter.mergePullRequest(42, REVIEWED);
    expect(outcome.status).toBe("uncertain");
  });

  it("pins the merge to the reviewed head sha", async () => {
    let body: unknown;
    const { adapter } = adapterWith((_path, init) => {
      body = init?.body;
      return { status: 200, json: { merged: true, sha: MERGE } };
    });
    await adapter.mergePullRequest(42, REVIEWED);
    expect(body).toEqual({ merge_method: "squash", sha: REVIEWED });
  });
});

describe("verifyMergedPull: confirms the merge against GitHub, not the merge response", () => {
  it("confirms a clean merge: merged from the reviewed head, same merge sha, same content", async () => {
    const { adapter } = adapterWith(honestGitHub());
    const v = await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED);
    expect(v).toEqual({
      mergeCommitSha: MERGE,
      candidateCommit: REVIEWED,
      mergedFromReviewedHead: true,
      mergeCommitMatches: true,
      contentMatches: true,
    });
  });

  it("refuses when GitHub says the pull is not merged", async () => {
    const { adapter } = adapterWith(
      honestGitHub({
        "GET /repos/o/r/pulls/42": {
          status: 200,
          json: { merged: false, merge_commit_sha: null, head: { sha: REVIEWED } },
        },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).mergedFromReviewedHead).toBe(false);
  });

  it("refuses when the pull was merged from a head other than the reviewed one", async () => {
    const { adapter } = adapterWith(
      honestGitHub({
        "GET /repos/o/r/pulls/42": {
          status: 200,
          json: { merged: true, merge_commit_sha: MERGE, head: { sha: "d".repeat(40) } },
        },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).mergedFromReviewedHead).toBe(false);
  });

  it("refuses when GitHub's merge commit differs from the one the merge call returned", async () => {
    const { adapter } = adapterWith(
      honestGitHub({
        "GET /repos/o/r/pulls/42": {
          status: 200,
          json: { merged: true, merge_commit_sha: "e".repeat(40), head: { sha: REVIEWED } },
        },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).mergeCommitMatches).toBe(false);
  });

  it("refuses when the merge commit's file contents differ from the candidate's", async () => {
    const { adapter } = adapterWith(
      honestGitHub({
        [`GET /repos/o/r/commits/${MERGE}`]: { status: 200, json: files(["nexum.harness.json", "modified", "blob-2"]) },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).contentMatches).toBe(false);
  });

  it("refuses when the merge commit carries an extra file the candidate did not change", async () => {
    const { adapter } = adapterWith(
      honestGitHub({
        [`GET /repos/o/r/commits/${MERGE}`]: {
          status: 200,
          json: files(["nexum.harness.json", "modified", "blob-1"], ["src/injected.ts", "added", "blob-x"]),
        },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).contentMatches).toBe(false);
  });

  it("refuses an empty candidate file list rather than treating two empty diffs as equal", async () => {
    const { adapter } = adapterWith(
      honestGitHub({
        [`GET /repos/o/r/commits/${REVIEWED}`]: { status: 200, json: files() },
        [`GET /repos/o/r/commits/${MERGE}`]: { status: 200, json: files() },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).contentMatches).toBe(false);
  });

  it("fails closed on a possibly truncated file list (GitHub caps commit files at 300)", async () => {
    const many = Array.from(
      { length: 300 },
      (_, i) => [`src/f${i}.ts`, "modified", `blob-${i}`] as [string, string, string],
    );
    const { adapter } = adapterWith(
      honestGitHub({
        [`GET /repos/o/r/commits/${REVIEWED}`]: { status: 200, json: files(...many) },
        [`GET /repos/o/r/commits/${MERGE}`]: { status: 200, json: files(...many) },
      }),
    );
    expect((await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED)).contentMatches).toBe(false);
  });

  it("fails closed when the pull endpoint errors", async () => {
    const { adapter } = adapterWith(honestGitHub({ "GET /repos/o/r/pulls/42": { status: 500, json: {} } }));
    const v = await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED);
    expect(v.mergedFromReviewedHead).toBe(false);
    expect(v.reason).toBeDefined();
  });

  it("fails closed without throwing when a commit lookup fails", async () => {
    const { adapter } = adapterWith(honestGitHub({ [`GET /repos/o/r/commits/${MERGE}`]: "throw" }));
    const v = await adapter.verifyMergedPull(42, REVIEWED, MERGE, REVIEWED);
    expect(v.contentMatches).toBe(false);
    expect(v.reason).toBeDefined();
  });
});
