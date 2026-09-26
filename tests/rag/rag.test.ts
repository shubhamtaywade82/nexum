/**
 * Tests for the RAG plane: retrievers, registry, RRF fusion, rerankers,
 * grounding, RagService, and the workspace composition.
 */
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { RetrieverRegistry, type Retriever, type RetrievalQuery, type RetrievedChunk } from "../../src/rag/types.js";
import {
  InMemoryKeywordIndex,
  InMemoryGraphIndex,
  KeywordRetriever,
  GraphRetriever,
  MetadataRetriever,
  SqliteKeywordIndex,
  VectorRetriever,
} from "../../src/rag/retrievers.js";
import { HashEmbedder } from "../../src/memory/semantic/embedding.js";
import { InMemoryVectorStore } from "../../src/memory/semantic/vector-store.js";
import { HybridRetriever, fuseByRrf } from "../../src/rag/hybrid-retriever.js";
import { HeuristicReranker, LlmReranker, extractJson } from "../../src/rag/reranker.js";
import { GroundingService, extractClaims } from "../../src/rag/grounding.js";
import { RagService } from "../../src/rag/rag-service.js";
import { createWorkspaceRagService } from "../../src/rag/workspace.js";
import { RagSearchTool } from "../../src/tools/rag-tools.js";
import { ragPack } from "../../src/tools/packs/rag-pack.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";

const embedder = new HashEmbedder();

function chunk(id: string, content: string, retriever = "test", score = 0.5): RetrievedChunk {
  return { id, content, source: { kind: "custom", ref: `ref:${id}`, retriever }, score, metadata: {} };
}

/** A retriever with a fixed, deterministic result set. */
function fixedRetriever(name: string, chunks: RetrievedChunk[], shouldThrow = false): Retriever {
  return {
    name,
    async retrieve(_query: RetrievalQuery): Promise<RetrievedChunk[]> {
      if (shouldThrow) throw new Error(`${name} is down`);
      return chunks;
    },
  };
}

describe("RetrieverRegistry", () => {
  it("registers, resolves, and rejects duplicates", () => {
    const registry = new RetrieverRegistry().register(fixedRetriever("a", []));
    expect(registry.names()).toEqual(["a"]);
    expect(() => registry.register(fixedRetriever("a", []))).toThrow("already registered");
    expect(() => registry.require("missing")).toThrow("unknown retriever");
  });

  it("retrieveAll tolerates individual retriever failures", async () => {
    const registry = new RetrieverRegistry()
      .register(fixedRetriever("good", [chunk("c1", "docker sandbox shell")]))
      .register(fixedRetriever("bad", [], true));
    const outcome = await registry.retrieveAll({ text: "docker" });
    expect(outcome.chunks.map((c) => c.id)).toEqual(["c1"]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].retriever).toBe("bad");
  });

  it("retrieveFrom runs only the named retrievers", async () => {
    const registry = new RetrieverRegistry()
      .register(fixedRetriever("a", [chunk("ca", "alpha")]))
      .register(fixedRetriever("b", [chunk("cb", "beta")]));
    const outcome = await registry.retrieveFrom(["b"], { text: "anything" });
    expect(outcome.chunks.map((c) => c.id)).toEqual(["cb"]);
  });
});

describe("VectorRetriever", () => {
  it("retrieves semantically related chunks from the vector store", async () => {
    const store = new InMemoryVectorStore();
    for (const [id, text] of [
      ["v1", "The tool gateway validates arguments against JSON schemas"],
      ["v2", "Rails controllers inherit from ApplicationController"],
    ] as const) {
      store.upsert({
        id,
        vector: await embedder.embed(text),
        text,
        metadata: { namespace: "knowledge", source: `doc:${id}` },
      });
    }
    const retriever = new VectorRetriever({ store, embedder });
    const chunks = await retriever.retrieve({ text: "how are tool arguments validated?", k: 2 });
    expect(chunks[0].id).toBe("v1");
    expect(chunks[0].source.kind).toBe("vector");
    expect(chunks[0].source.ref).toBe("doc:v1");
  });
});

describe("KeywordRetriever + indexes", () => {
  it("in-memory index scores by token overlap", async () => {
    const index = new InMemoryKeywordIndex();
    index.upsert({ id: "k1", content: "docker sandbox blocks network egress", metadata: { namespace: "knowledge" } });
    index.upsert({ id: "k2", content: "rails migration adds a column", metadata: { namespace: "knowledge" } });
    const retriever = new KeywordRetriever(index);
    const chunks = await retriever.retrieve({ text: "docker network egress", k: 2 });
    expect(chunks[0].id).toBe("k1");
    expect(chunks[0].source.kind).toBe("keyword");
  });

  it("sqlite FTS index searches, lists, deletes and is namespace-scoped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-fts-"));
    const db = new Database(join(dir, "fts.db"));
    const index = new SqliteKeywordIndex(db);
    index.upsert({
      id: "s1",
      content: "the checkpoint store writes atomically",
      metadata: { namespace: "knowledge", source: "arch.md" },
    });
    index.upsert({
      id: "s2",
      content: "checkpointing is durable execution history",
      metadata: { namespace: "other", source: "x.md" },
    });

    const retriever = new KeywordRetriever(index);
    const chunks = await retriever.retrieve({ text: "checkpoint atomic writes", k: 5 });
    expect(chunks.map((c) => c.id)).toContain("s1");
    expect(chunks.map((c) => c.id)).not.toContain("s2");

    expect(index.count(["knowledge"])).toBe(1);
    expect(index.list(["knowledge"]).map((d) => d.id)).toEqual(["s1"]);
    expect(index.delete("s1")).toBe(true);
    expect(index.count()).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes MATCH syntax against injection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-fts-"));
    const db = new Database(join(dir, "fts.db"));
    const index = new SqliteKeywordIndex(db);
    index.upsert({ id: "s1", content: "normal content", metadata: {} });
    const results = index.search('quote" OR drop--', 5);
    expect(results).toEqual([]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GraphRetriever", () => {
  it("expands matched nodes one hop with relation context", async () => {
    const graph = new InMemoryGraphIndex();
    graph.addNode({ id: "user", label: "User", kind: "model", summary: "account entity" });
    graph.addNode({ id: "post", label: "Post", kind: "model", summary: "content entity" });
    graph.addEdge({ from: "user", to: "post", relation: "has_many" });
    const retriever = new GraphRetriever(graph);
    const chunks = await retriever.retrieve({ text: "user entity", k: 3 });
    const ids = chunks.map((c) => c.id).sort();
    expect(ids).toEqual(["post", "user"]);
    const post = chunks.find((c) => c.id === "post");
    expect(post?.content).toContain("via has_many");
    expect(post?.source.kind).toBe("graph");
  });
});

describe("MetadataRetriever", () => {
  it("filters by metadata and orders by recency", async () => {
    const index = new InMemoryKeywordIndex();
    index.upsert({
      id: "m1",
      content: "old incident",
      metadata: { namespace: "knowledge", kind: "incident", createdAt: 100 },
    });
    index.upsert({
      id: "m2",
      content: "new incident",
      metadata: { namespace: "knowledge", kind: "incident", createdAt: 200 },
    });
    index.upsert({
      id: "m3",
      content: "not an incident",
      metadata: { namespace: "knowledge", kind: "report", createdAt: 300 },
    });
    const retriever = new MetadataRetriever(index);
    const chunks = await retriever.retrieve({ text: "incidents", k: 5, filter: { kind: "incident" } });
    expect(chunks.map((c) => c.id)).toEqual(["m2", "m1"]);
    expect(chunks[0].source.kind).toBe("metadata");
  });
});

describe("HybridRetriever / RRF", () => {
  it("fuses ranks: chunks found by both retrievers win", async () => {
    const hybrid = new HybridRetriever({
      retrievers: [
        fixedRetriever("a", [chunk("x", "shared first for a"), chunk("y", "only a")]),
        fixedRetriever("b", [chunk("z", "only b"), chunk("x", "shared second for b")]),
      ],
    });
    const chunks = await hybrid.retrieve({ text: "q", k: 3 });
    expect(chunks[0].id).toBe("x"); // found by both → RRF sum
    expect(chunks[0].metadata.rrfVotes).toBe(2);
  });

  it("fuseByRrf dedupes by id and caps at k", () => {
    const fused = fuseByRrf(
      { chunks: [chunk("x", "a", "r1"), chunk("x", "b", "r2"), chunk("y", "c", "r1")], failures: [] },
      { k: 2 },
    );
    expect(fused.map((c) => c.id)).toEqual(["x", "y"]);
  });
});

describe("Rerankers", () => {
  it("HeuristicReranker promotes coverage and phrase hits", async () => {
    const reranker = new HeuristicReranker();
    const chunks = [
      chunk("off", "completely unrelated text about gardening"),
      chunk("on", "The tool gateway validates arguments against the schema"),
    ];
    const reranked = await reranker.rerank("tool gateway argument schema validation", chunks, 2);
    expect(reranked[0].id).toBe("on");
    expect(reranked[0].metadata.reranker).toBe("heuristic");
  });

  it("LlmReranker orders by model scores and falls back on failure", async () => {
    const gateway = {
      route: async () => ({ message: { content: '{"scores": [0.1, 0.9]}' } }) as unknown as ChatResponse,
    } as unknown as ModelGateway;
    const reranker = new LlmReranker({ modelGateway: gateway });
    const chunks = [chunk("a", "first"), chunk("b", "second")];
    const reranked = await reranker.rerank("q", chunks, 2);
    expect(reranked[0].id).toBe("b");
    expect(reranked[0].score).toBe(0.9);

    const broken = {
      route: async () => {
        throw new Error("model down");
      },
    } as unknown as ModelGateway;
    const fallback = await new LlmReranker({ modelGateway: broken }).rerank("q", chunks, 2);
    expect(fallback.map((c) => c.id)).toEqual(["a", "b"]); // stage-1 order kept
  });

  it("extractJson tolerates prose and fences", () => {
    expect(extractJson('prefix {"a": 1} suffix')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a": [1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(() => extractJson("no json at all")).toThrow();
  });
});

describe("GroundingService", () => {
  const evidence = [
    chunk("e1", "The Docker sandbox blocks all network egress by default", "vector", 0.9),
    chunk("e2", "Checkpoints are written atomically with tmp and rename", "vector", 0.8),
  ];

  it("supports claims backed by evidence and flags unsupported ones", () => {
    const grounding = new GroundingService();
    const report = grounding.ground(
      "The Docker sandbox blocks all network egress by default. " +
        "The moon is made of aged parmesan cheese and orbits the sun every eleven days.",
      evidence,
    );
    expect(report.claims).toHaveLength(2);
    expect(report.claims[0].verdict).toBe("supported");
    expect(report.claims[0].citation).toBe(1);
    expect(report.claims[1].verdict).toBe("unsupported");
    expect(report.claims[1].citation).toBeUndefined();
    expect(report.confidence).toBeLessThan(1);
    expect(report.sources[0].ref).toBe("ref:e1");
  });

  it("extractClaims skips questions, directives, and fragments", () => {
    const claims = extractClaims(
      "Is the sandbox networked? Please restart the service. Real claims are assertive sentences with substance.",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("assertive sentences");
  });

  it("renders answers with a sources block", () => {
    const grounding = new GroundingService();
    const report = grounding.ground("The Docker sandbox blocks all network egress by default.", evidence);
    const rendered = grounding.renderWithSources("Answer text", report);
    expect(rendered).toContain("Answer text");
    expect(rendered).toContain("[1] ref:e1 (custom)");
  });

  it("applies configurable thresholds for partial support", () => {
    const grounding = new GroundingService({ supportedThreshold: 0.9, partialThreshold: 0.2 });
    const report = grounding.ground("The Docker sandbox restricts most network egress traffic by default", evidence);
    expect(["partial", "supported"]).toContain(report.claims[0].verdict);
  });
});

describe("RagService", () => {
  async function makeRag() {
    const store = new InMemoryVectorStore();
    const index = new InMemoryKeywordIndex();
    const rag = new RagService({
      registry: new RetrieverRegistry()
        .register(new VectorRetriever({ store, embedder, namespace: "knowledge" }))
        .register(new KeywordRetriever(index, "keyword", ["knowledge"])),
      reranker: new HeuristicReranker(),
      ingest: { store, embedder, index },
    });
    await rag.ingest({
      text: "The policy engine denies destructive git operations like force push",
      source: "docs/policy.md",
    });
    await rag.ingest({ text: "Memory compaction summarizes old turns into system context", source: "docs/memory.md" });
    return rag;
  }

  it("ingests into both indexes and searches hybrid", async () => {
    const rag = await makeRag();
    const result = await rag.search("which git operations are denied?", { k: 2 });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].content).toContain("force push");
    expect(result.context).toContain("[1]");
    expect(result.context).toContain("docs/policy.md");
  });

  it("grounds a provided answer against the evidence", async () => {
    const rag = await makeRag();
    const result = await rag.search("git force push", {
      k: 2,
      answer: "The policy engine denies destructive git operations like force push.",
    });
    expect(result.grounding).toBeDefined();
    expect(result.grounding?.supported).toBeGreaterThan(0);
  });

  it("reports retriever failures without failing the search", async () => {
    const rag = new RagService({
      registry: new RetrieverRegistry().register(fixedRetriever("down", [], true)),
    });
    const result = await rag.search("anything");
    expect(result.chunks).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.context).toBeUndefined();
  });

  it("ingest requires an ingest target and non-empty text", async () => {
    const rag = new RagService({ registry: new RetrieverRegistry() });
    await expect(rag.ingest({ text: "x", source: "s" })).rejects.toThrow("no ingest target");
  });
});

describe("workspace composition + tools", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-rag-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("createWorkspaceRagService searches across persistent storage", async () => {
    const dbPath = join(dir, "memory.db");
    const rag = createWorkspaceRagService({ dbPath });
    await rag.ingest({ text: "Execution events persist as JSONL envelopes with correlation ids", source: "arch.md" });
    const result = await rag.search("how do execution events persist", { k: 3 });
    expect(result.chunks[0].content).toContain("envelopes");
  });

  it("RagSearchTool returns numbered passages and validates args", async () => {
    const rag = await (async () => {
      const store = new InMemoryVectorStore();
      const index = new InMemoryKeywordIndex();
      const service = new RagService({
        registry: new RetrieverRegistry().register(new KeywordRetriever(index)),
        ingest: { store, embedder, index },
      });
      await service.ingest({ text: "Hybrid retrieval fuses semantic and lexical signals", source: "rag.md" });
      return service;
    })();
    const tool = new RagSearchTool(rag);
    const result = (await tool.call({ query: "semantic lexical fusion" })) as {
      count: number;
      passages: Array<{ citation: number; source: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.passages[0].citation).toBe(1);
    expect(result.passages[0].source).toBe("rag.md");
    expect((await tool.call({ query: "" })).error).toBe("ArgumentError");
  });

  it("ragPack exposes the tool with read-only metadata", () => {
    const rag = new RagService({ registry: new RetrieverRegistry() });
    const pack = ragPack(rag);
    expect(pack.id).toBe("rag");
    expect(pack.entries[0].tool.name).toBe("rag_search");
    expect(pack.entries[0].metadata?.risk).toBe("read");
  });
});
