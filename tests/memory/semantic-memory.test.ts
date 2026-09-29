/**
 * Tests for SemanticMemory (remember → recall → rank → context injection)
 * and the memory tools.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SemanticMemory,
  MemoryRanker,
  createSemanticMemory,
  createWorkspaceSemanticMemory,
} from "../../src/memory/semantic/semantic-memory.js";
import { HashEmbedder } from "../../src/memory/semantic/embedding.js";
import { InMemoryVectorStore } from "../../src/memory/semantic/vector-store.js";
import { MemorySaveTool, MemoryRecallTool } from "../../src/tools/memory-tools.js";
import { memoryPack } from "../../src/tools/packs/memory-pack.js";

function makeMemory(): SemanticMemory {
  return new SemanticMemory({ store: new InMemoryVectorStore(), embedder: new HashEmbedder() });
}

describe("SemanticMemory", () => {
  let memory: SemanticMemory;

  beforeEach(() => {
    memory = makeMemory();
  });

  it("remembers and recalls semantically related entries first", async () => {
    await memory.remember({ text: "The user prefers tabs over spaces", kind: "preference" });
    await memory.remember({ text: "Docker sandbox blocks network egress by default", kind: "fact" });
    await memory.remember({ text: "Rails migrations live in db/migrate", kind: "fact" });

    const hits = await memory.recall("what indentation does the user like?", { k: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0].text).toContain("tabs over spaces");
    expect(hits[0].kind).toBe("preference");
    expect(hits[0].score.relevance).toBeGreaterThan(hits[1].score.relevance);
  });

  it("filters recall by kind and respects k", async () => {
    await memory.remember({ text: "preference about tabs", kind: "preference" });
    await memory.remember({ text: "fact about docker sandbox networking", kind: "fact" });
    const hits = await memory.recall("docker", { k: 5, kinds: ["fact"] });
    expect(hits.every((h) => h.kind === "fact")).toBe(true);
    const one = await memory.recall("anything", { k: 1 });
    expect(one).toHaveLength(1);
  });

  it("rejects empty memory text", async () => {
    await expect(memory.remember({ text: "   " })).rejects.toThrow("non-empty");
  });

  it("isolates namespaces", async () => {
    await memory.remember({ text: "docker sandbox networking", namespace: "alpha" });
    await memory.remember({ text: "docker sandbox networking", namespace: "beta" });
    const alpha = await memory.recall("docker sandbox", { namespace: "alpha" });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].namespace).toBe("alpha");
    expect(memory.count({ namespace: "beta" })).toBe(1);
  });

  it("forgets entries and exposes get()", async () => {
    const id = await memory.remember({ text: "temporary fact about sqlite WAL" });
    expect(memory.get(id)?.text).toContain("WAL");
    expect(memory.forget(id)).toBe(true);
    expect(memory.get(id)).toBeUndefined();
    expect(await memory.recall("sqlite WAL", { k: 5 })).toHaveLength(0);
  });

  it("ranks higher-importance and newer memories above equal relevance", async () => {
    // Same text → same relevance; importance and recency must break the tie.
    await memory.remember({ text: "release process uses semantic versioning", importance: 0.1 });
    await memory.remember({ text: "release process uses semantic versioning", importance: 0.95 });
    const hits = await memory.recall("release process versioning", { k: 2 });
    expect(hits[0].score.importance).toBeGreaterThan(hits[1].score.importance);
    expect(hits[0].score.final).toBeGreaterThan(hits[1].score.final);
  });

  it("touches recalled memories (useCount bump) when touch=true", async () => {
    const id = await memory.remember({ text: "fact about the tool gateway policy engine" });
    await memory.recall("tool gateway policy", { k: 5, touch: true });
    const got = memory.get(id);
    expect(Number(got?.metadata.useCount)).toBe(1);
  });

  it("builds a bounded context fragment (or undefined when empty)", async () => {
    expect(await memory.buildContext("nothing stored yet")).toBeUndefined();
    await memory.remember({ text: "The test suite runs with Jest in ESM mode", kind: "fact" });
    await memory.remember({ text: "Prettier line width is 120", kind: "fact" });
    const ctx = await memory.buildContext("how do tests run?", { k: 2, maxChars: 300 });
    expect(ctx).toBeDefined();
    expect(ctx).toContain("Relevant memory");
    expect((ctx ?? "").length).toBeLessThanOrEqual(300);
  });

  it("feeds lessons and episodes through the learning adapters", async () => {
    await memory.recordLesson({
      category: "tooling",
      context: "shell runs in docker",
      lesson: "always mount the workspace",
    });
    await memory.recordEpisode({ goal: "fix flaky test", summary: "reran with seed", outcome: "success" });
    const lessons = await memory.recall("mount workspace docker", { kinds: ["lesson"] });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].text).toContain("always mount the workspace");
    const episodes = await memory.recall("flaky test", { kinds: ["episode"] });
    expect(episodes[0].text).toContain("fix flaky test");
  });
});

describe("MemoryRanker", () => {
  it("exponentially decays recency by half-life", () => {
    const now = Date.now();
    const ranker = new MemoryRanker(undefined, 1000, () => now); // 1s half-life
    const fresh = ranker.score({ similarity: 0.8, metadata: { createdAt: now } });
    const twoHalves = ranker.score({ similarity: 0.8, metadata: { createdAt: now - 2000 } });
    const stale = ranker.score({ similarity: 0.8, metadata: { createdAt: now - 4000 } });
    expect(fresh.recency).toBeCloseTo(1, 3);
    expect(twoHalves.recency).toBeCloseTo(0.25, 2);
    expect(stale.recency).toBeCloseTo(0.0625, 3);
    expect(fresh.final).toBeGreaterThan(stale.final);
  });

  it("saturates the usage boost", () => {
    const ranker = new MemoryRanker();
    const few = ranker.score({ similarity: 0.5, metadata: { useCount: 1 } });
    const many = ranker.score({ similarity: 0.5, metadata: { useCount: 64 } });
    expect(many.usage).toBeLessThanOrEqual(1);
    expect(many.usage - few.usage).toBeGreaterThan(0);
  });

  it("keeps all score components in [0,1]", () => {
    const ranker = new MemoryRanker();
    const score = ranker.score({ similarity: -0.5, metadata: { importance: 7, createdAt: 0 } });
    for (const component of [score.relevance, score.recency, score.importance, score.usage, score.final]) {
      expect(component).toBeGreaterThanOrEqual(0);
      expect(component).toBeLessThanOrEqual(1);
    }
  });
});

describe("createSemanticMemory / createWorkspaceSemanticMemory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-semmem-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a SQLite-backed memory at the workspace path", async () => {
    const memory = createWorkspaceSemanticMemory(dir);
    await memory.remember({ text: "workspace fact about the tool gateway" });
    const dbFile = join(dir, ".nexum", "memory.db");
    expect(existsSync(dbFile)).toBe(true);
    const hits = await memory.recall("tool gateway", { k: 5 });
    expect(hits).toHaveLength(1);
  });

  it("defaults to an in-memory store without a dbPath", async () => {
    const memory = createSemanticMemory({});
    expect(memory.store).toBeInstanceOf(InMemoryVectorStore);
    await memory.remember({ text: "ephemeral" });
    expect(memory.count()).toBe(1);
  });
});

describe("memory tools", () => {
  let memory: SemanticMemory;

  beforeEach(() => {
    memory = makeMemory();
  });

  it("memory_save persists and returns an id", async () => {
    const tool = new MemorySaveTool(memory);
    const result = await tool.call({ text: "prefer tabs over spaces", kind: "preference", importance: 0.9 });
    expect(result.saved).toBe(true);
    expect(String(result.id)).toMatch(/^mem_/);
    const hits = await memory.recall("indentation preference", { k: 5 });
    expect(hits[0].text).toContain("tabs");
  });

  it("memory_save rejects empty text and clamps importance", async () => {
    const tool = new MemorySaveTool(memory);
    expect((await tool.call({ text: "" })).error).toBe("ArgumentError");
    const result = await tool.call({ text: "clamped", importance: 42 });
    expect(result.saved).toBe(true);
    const got = memory.get(String(result.id));
    expect(Number(got?.metadata.importance)).toBe(1);
  });

  it("memory_recall returns ranked memories", async () => {
    await memory.remember({ text: "the sandbox image is nexum-sandbox:latest", kind: "fact" });
    const tool = new MemoryRecallTool(memory);
    const result = (await tool.call({ query: "which docker image does the sandbox use?", k: 3 })) as {
      count: number;
      memories: Array<{ text: string; score: number }>;
    };
    expect(result.count).toBe(1);
    expect(result.memories[0].text).toContain("nexum-sandbox");
    expect(result.memories[0].score).toBeGreaterThan(0);
  });

  it("memory_recall rejects empty queries", async () => {
    const tool = new MemoryRecallTool(memory);
    expect((await tool.call({ query: " " })).error).toBe("ArgumentError");
  });

  it("memoryPack exposes both tools with safe metadata", () => {
    const pack = memoryPack(memory);
    expect(pack.id).toBe("memory");
    expect(pack.entries.map((e) => e.tool.name).sort()).toEqual(["memory_recall", "memory_save"]);
    const save = pack.entries.find((e) => e.tool.name === "memory_save");
    expect(save?.metadata?.risk).toBe("low");
    expect(save?.metadata?.sideEffects?.filesystem).toBe(true);
  });
});
