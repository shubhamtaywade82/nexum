/**
 * Tests for the vector stores (in-memory + SQLite).
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryVectorStore,
  SqliteVectorStore,
  matchesFilter,
  type VectorRecord,
} from "../../src/memory/semantic/vector-store.js";
import { HashEmbedder } from "../../src/memory/semantic/embedding.js";

const embedder = new HashEmbedder();

async function record(id: string, text: string, metadata: Record<string, unknown> = {}): Promise<VectorRecord> {
  return { id, vector: await embedder.embed(text), text, metadata: { kind: "note", createdAt: 1_000, ...metadata } };
}

function eachStore(name: string, make: () => { store: InMemoryVectorStore | SqliteVectorStore; cleanup?: () => void }) {
  describe(name, () => {
    let store: InMemoryVectorStore | SqliteVectorStore;
    let cleanup: (() => void) | undefined;

    beforeEach(async () => {
      const made = make();
      store = made.store;
      cleanup = made.cleanup;
    });

    afterEach(() => {
      cleanup?.();
    });

    it("upserts and queries by cosine similarity", async () => {
      store.upsert(await record("a", "docker sandbox shell execution"));
      store.upsert(await record("b", "rails migration schema"));
      const query = await embedder.embed("docker shell");
      const hits = store.query(query, { k: 2 });
      expect(hits).toHaveLength(2);
      expect(hits[0].id).toBe("a");
      expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity);
    });

    it("upsert is idempotent (same id overwrites)", async () => {
      store.upsert(await record("a", "first version"));
      store.upsert(await record("a", "docker sandbox shell execution"));
      expect(store.count()).toBe(1);
      const got = store.get("a");
      expect(got?.text).toBe("docker sandbox shell execution");
    });

    it("filters by namespace and kind", async () => {
      store.upsert(await record("a", "docker shell", { namespace: "alpha", kind: "fact" }));
      store.upsert(await record("b", "docker shell", { namespace: "beta", kind: "note" }));
      const query = await embedder.embed("docker shell");
      expect(store.query(query, { k: 10, filter: { namespace: "alpha" } }).map((h) => h.id)).toEqual(["a"]);
      expect(store.query(query, { k: 10, filter: { kinds: ["note"] } }).map((h) => h.id)).toEqual(["b"]);
      expect(store.count({ namespace: "beta" })).toBe(1);
    });

    it("filters by tags (any-match), time window, and ids", async () => {
      store.upsert(await record("a", "alpha", { tags: ["lesson", "testing"], createdAt: 100 }));
      store.upsert(await record("b", "beta", { tags: ["preference"], createdAt: 200 }));
      const query = await embedder.embed("alpha beta");
      expect(store.query(query, { k: 10, filter: { tags: ["lesson"] } }).map((h) => h.id)).toEqual(["a"]);
      expect(store.query(query, { k: 10, filter: { since: 150 } }).map((h) => h.id)).toEqual(["b"]);
      expect(store.query(query, { k: 10, filter: { ids: ["b"] } }).map((h) => h.id)).toEqual(["b"]);
    });

    it("deletes, clears, and reports counts", async () => {
      store.upsert(await record("a", "alpha content"));
      store.upsert(await record("b", "beta content"));
      expect(store.delete("a")).toBe(true);
      expect(store.delete("missing")).toBe(false);
      expect(store.count()).toBe(1);
      store.clear();
      expect(store.count()).toBe(0);
    });

    it("returns raw vectors through vector()", async () => {
      const rec = await record("a", "docker shell");
      store.upsert(rec);
      const v = store.vector("a");
      expect(v).toBeDefined();
      expect(v).toHaveLength(rec.vector.length);
    });
  });
}

eachStore("InMemoryVectorStore", () => ({ store: new InMemoryVectorStore() }));

eachStore("SqliteVectorStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexum-vecstore-"));
  const store = new SqliteVectorStore(join(dir, "vectors.db"));
  return { store, cleanup: () => store.close() };
});

describe("SqliteVectorStore (persistence)", () => {
  it("persists vectors across connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-vecstore-"));
    const dbPath = join(dir, "persist.db");
    const first = new SqliteVectorStore(dbPath);
    first.upsert(await record("a", "docker sandbox shell execution"));
    first.close();

    const second = new SqliteVectorStore(dbPath);
    expect(second.count()).toBe(1);
    const query = await embedder.embed("docker shell");
    const hits = second.query(query, { k: 1 });
    expect(hits[0].id).toBe("a");
    expect(hits[0].similarity).toBeGreaterThan(0.3);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("matchesFilter", () => {
  it("applies all conditions conjunctively", () => {
    const metadata = { namespace: "ws", kind: "fact", tags: ["a", "b"], createdAt: 50 };
    expect(matchesFilter(metadata)).toBe(true);
    expect(matchesFilter(metadata, { namespace: "ws", kinds: ["fact"], tags: ["b"], since: 10, until: 100 })).toBe(
      true,
    );
    expect(matchesFilter(metadata, { namespace: "other" })).toBe(false);
    expect(matchesFilter(metadata, { tags: ["c"] })).toBe(false);
    expect(matchesFilter(metadata, { until: 10 })).toBe(false);
  });
});
