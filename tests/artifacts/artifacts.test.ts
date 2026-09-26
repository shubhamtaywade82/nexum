/**
 * Tests for the artifact store: versioning, provenance, derivation, and
 * both backends.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { InMemoryArtifactStore, SqliteArtifactStore, deriveArtifact, contentHash } from "../../src/artifacts/store.js";

function eachStore(
  name: string,
  make: () => { store: InMemoryArtifactStore | SqliteArtifactStore; cleanup?: () => void },
) {
  describe(name, () => {
    let store: InMemoryArtifactStore | SqliteArtifactStore;
    let cleanup: (() => void) | undefined;

    beforeEach(() => {
      const made = make();
      store = made.store;
      cleanup = made.cleanup;
    });

    afterEach(() => {
      cleanup?.();
    });

    it("saves with identity, hash, and version 1", () => {
      const artifact = store.save({
        name: "research-findings",
        kind: "research",
        content: "The tool gateway validates every call.",
        tags: ["research"],
        provenance: { agentId: "researcher", runId: "run_1" },
      });
      expect(artifact.id).toMatch(/^art_/);
      expect(artifact.version).toBe(1);
      expect(artifact.contentHash).toBe(contentHash("The tool gateway validates every call."));
      expect(artifact.provenance.agentId).toBe("researcher");
    });

    it("versions monotonically per (name, kind)", () => {
      store.save({ name: "report", kind: "report", content: "v1" });
      const v2 = store.save({ name: "report", kind: "report", content: "v2 body" });
      expect(v2.version).toBe(2);
      const other = store.save({ name: "report", kind: "diff", content: "unrelated" });
      expect(other.version).toBe(1);
      expect(store.versions("report", "report")).toHaveLength(2);
      expect(store.latest("report", "report")?.content).toBe("v2 body");
    });

    it("queries by kind, tags, agent, and time", () => {
      const base = Date.now();
      store.save({ name: "a", kind: "report", content: "x", tags: ["final"], provenance: { agentId: "writer" } });
      store.save({ name: "b", kind: "research", content: "y", tags: ["draft"], provenance: { agentId: "researcher" } });
      expect(store.count({ kind: "report" })).toBe(1);
      expect(store.count({ tags: ["draft"] })).toBe(1);
      expect(store.count({ agentId: "writer" })).toBe(1);
      expect(store.count({ since: base + 10_000 })).toBe(0);
    });

    it("gets and deletes", () => {
      const artifact = store.save({ name: "gone", content: "soon" });
      expect(store.get(artifact.id)?.content).toBe("soon");
      expect(store.delete(artifact.id)).toBe(true);
      expect(store.get(artifact.id)).toBeUndefined();
      expect(store.delete(artifact.id)).toBe(false);
    });
  });
}

eachStore("InMemoryArtifactStore", () => ({ store: new InMemoryArtifactStore() }));

eachStore("SqliteArtifactStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexum-artifacts-"));
  const store = new SqliteArtifactStore(join(dir, "artifacts.db"));
  return { store, cleanup: () => store.close() };
});

describe("deriveArtifact", () => {
  it("links child provenance to the parent reference", () => {
    const store = new InMemoryArtifactStore();
    const research = store.save({ name: "findings", kind: "research", content: "sources say..." });
    const analysis = deriveArtifact(
      store,
      { artifactId: research.id },
      {
        kind: "analysis",
        content: "analysis of sources",
        provenance: { agentId: "analyst" },
      },
    );
    expect(analysis.name).toBe("findings"); // inherits the chain's name
    expect(analysis.kind).toBe("analysis");
    expect(analysis.version).toBe(1); // new (name, kind) chain
    expect(analysis.provenance.sources).toEqual([{ artifactId: research.id, name: "findings" }]);

    // The chain is walkable: analysis → research.
    const parent = store.get(analysis.provenance.sources![0].artifactId);
    expect(parent?.content).toContain("sources say");
  });

  it("throws on missing parents", () => {
    const store = new InMemoryArtifactStore();
    expect(() => deriveArtifact(store, { artifactId: "art_missing" }, { content: "orphan" })).toThrow("not found");
  });
});

describe("SqliteArtifactStore (persistence)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-artifacts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists artifacts across connections", () => {
    const dbPath = join(dir, "artifacts.db");
    const first = new SqliteArtifactStore(dbPath);
    const saved = first.save({ name: "benchmark", kind: "benchmark", content: "702 tests" });
    first.close();

    const second = new SqliteArtifactStore(dbPath);
    expect(second.get(saved.id)?.content).toBe("702 tests");
    expect(second.latest("benchmark", "benchmark")?.version).toBe(1);
    // json_extract agentId filter round-trips
    const third = new SqliteArtifactStore(new Database(dbPath));
    expect(third.count({ agentId: "nobody" })).toBe(0);
    third.close();
    second.close();
  });
});
