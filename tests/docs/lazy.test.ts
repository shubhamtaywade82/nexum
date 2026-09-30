import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocsStore } from "../../src/docs/store.js";
import { LazyDocs, FAILURE_COOLDOWN_MS, MAX_FETCHES_PER_SEARCH, IngestFn } from "../../src/docs/lazy.js";

function newStore(): DocsStore {
  return new DocsStore(join(mkdtempSync(join(tmpdir(), "lazy-docs-")), "docs.db"));
}

/** Ingest stub: writes one section whose body is the given text per id. */
function stubIngest(bodies: Record<string, string>, calls: string[] = []): IngestFn {
  return async (store, id) => {
    calls.push(id);
    const body = bodies[id];
    if (body === undefined) throw new Error(`no source ${id}`);
    store.upsertSource({ slug: id, name: id, ingestedAt: 1 });
    store.replaceSections(id, [{ path: "p", title: id, body }]);
    return { slug: id, name: id, sectionCount: 1 };
  };
}

describe("LazyDocs.searchWorkspace", () => {
  it("fetches the source the query names before the workspace's priority order", async () => {
    const store = newStore();
    const calls: string[] = [];
    const lazy = new LazyDocs(store, {
      ingest: stubIngest({ typescript: "generics", javascript: "closures", node: "streams" }, calls),
    });

    const out = await lazy.searchWorkspace("node streams", ["typescript", "javascript", "node"], 8);

    expect(calls).toEqual(["node"]);
    expect(out.fetched).toEqual(["node"]);
    expect(out.results).toEqual([expect.objectContaining({ source: "node" })]);
    store.close();
  });

  it("stops at the first source that yields results and never exceeds the per-call cap", async () => {
    const store = newStore();
    const calls: string[] = [];
    const ids = ["a", "b", "c", "d"];
    const lazy = new LazyDocs(store, { ingest: stubIngest({ a: "x", b: "x", c: "x", d: "needle" }, calls) });

    const out = await lazy.searchWorkspace("needle", ids, 8);

    expect(calls.length).toBeLessThanOrEqual(MAX_FETCHES_PER_SEARCH);
    expect(calls).toEqual(["a", "b"]);
    expect(out.results).toEqual([]);
    store.close();
  });

  it("does not fetch when cached sources already match", async () => {
    const store = newStore();
    const calls: string[] = [];
    const lazy = new LazyDocs(store, { ingest: stubIngest({ react: "hooks", html: "tags" }, calls) });
    await lazy.ensure("react");
    calls.length = 0;

    const out = await lazy.searchWorkspace("hooks", ["react", "html"], 8);

    expect(calls).toEqual([]);
    expect(out.results).toHaveLength(1);
    store.close();
  });

  it("remembers failures for the cooldown, then retries", async () => {
    const store = newStore();
    const calls: string[] = [];
    let clock = 1_000;
    const lazy = new LazyDocs(store, { ingest: stubIngest({}, calls), now: () => clock });

    expect(await lazy.ensure("ghost")).toBe(false);
    expect(await lazy.ensure("ghost")).toBe(false);
    expect(calls).toEqual(["ghost"]);

    const out = await lazy.searchWorkspace("anything", ["ghost"], 8);
    expect(out.skipped).toEqual(["ghost"]);
    expect(calls).toEqual(["ghost"]);

    clock += FAILURE_COOLDOWN_MS + 1;
    await lazy.ensure("ghost");
    expect(calls).toEqual(["ghost", "ghost"]);
    store.close();
  });

  it("shares one download between concurrent requests for the same id", async () => {
    const store = newStore();
    const calls: string[] = [];
    const lazy = new LazyDocs(store, { ingest: stubIngest({ react: "hooks" }, calls) });

    const [a, b] = await Promise.all([lazy.ensure("react"), lazy.ensure("react")]);

    expect([a, b]).toEqual([true, true]);
    expect(calls).toEqual(["react"]);
    store.close();
  });
});
