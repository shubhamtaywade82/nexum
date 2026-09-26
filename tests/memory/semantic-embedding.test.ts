/**
 * Tests for the semantic-memory embedding providers.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  HashEmbedder,
  OllamaEmbedder,
  FallbackEmbedder,
  cosineSimilarity,
  l2Normalize,
} from "../../src/memory/semantic/embedding.js";

describe("HashEmbedder", () => {
  it("is deterministic across instances", async () => {
    const a = new HashEmbedder();
    const b = new HashEmbedder();
    const va = await a.embed("the tool gateway validates arguments");
    const vb = await b.embed("the tool gateway validates arguments");
    expect(va).toEqual(vb);
  });

  it("produces L2-normalized vectors of the declared dimension", async () => {
    const embedder = new HashEmbedder({ dimensions: 128 });
    const v = await embedder.embed("normalize me");
    expect(v).toHaveLength(128);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("rates related text above unrelated text", async () => {
    const embedder = new HashEmbedder();
    const query = await embedder.embed("docker sandbox shell execution");
    const related = await embedder.embed("docker sandbox shell command execution");
    const unrelated = await embedder.embed("rails migration schema columns");
    const simRelated = cosineSimilarity(query, related);
    const simUnrelated = cosineSimilarity(query, unrelated);
    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simRelated).toBeGreaterThan(0.3);
  });

  it("embedBatch matches individual embeds", async () => {
    const embedder = new HashEmbedder();
    const texts = ["alpha", "beta gamma", "delta epsilon zeta"];
    const batch = await embedder.embedBatch(texts);
    for (let i = 0; i < texts.length; i++) {
      expect(batch[i]).toEqual(await embedder.embed(texts[i]));
    }
  });
});

describe("OllamaEmbedder", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses the modern /api/embed endpoint and normalizes output", async () => {
    const fetchMock = jest.fn(async () => {
      return new Response(JSON.stringify({ embeddings: [[3, 4]] }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const embedder = new OllamaEmbedder({ model: "nomic-embed-text", baseUrl: "http://localhost:11434" });
    const v = await embedder.embed("hello world");
    expect(v).toEqual(l2Normalize([3, 4]));
    const call = (fetchMock as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("http://localhost:11434/api/embed");
    const body = JSON.parse(String(call[1].body)) as { model: string; input: string[] };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["hello world"]);
  });

  it("falls back to the legacy /api/embeddings endpoint on failure", async () => {
    const fetchMock = jest.fn(async (url: unknown) => {
      if (String(url).endsWith("/api/embed")) throw new Error("endpoint gone");
      return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const embedder = new OllamaEmbedder({ model: "m" });
    const v = await embedder.embed("legacy");
    expect(v).toEqual([1, 0, 0]);
    expect((fetchMock as jest.Mock).mock.calls).toHaveLength(2);
  });
});

describe("FallbackEmbedder", () => {
  it("uses the primary when healthy", async () => {
    const primary = new HashEmbedder();
    const failing = {
      id: "failing",
      dimensions: 8,
      embed: async () => {
        throw new Error("down");
      },
      embedBatch: async () => {
        throw new Error("down");
      },
    };
    const fallback = new FallbackEmbedder(primary, failing);
    expect(await fallback.embed("ok")).toEqual(await primary.embed("ok"));
  });

  it("adapts the secondary to the primary dimensionality on failure", async () => {
    const failing = {
      id: "failing",
      dimensions: 256,
      embed: async () => {
        throw new Error("down");
      },
      embedBatch: async () => {
        throw new Error("down");
      },
    };
    // Secondary emits 4 dims; primary declares 256.
    const secondary = {
      id: "short",
      dimensions: 4,
      embed: async (t: string) => [t.length, 1, 0, 0],
      embedBatch: async (ts: string[]) => ts.map((t) => [t.length, 1, 0, 0] as number[]),
    };
    const fallback = new FallbackEmbedder(failing as never, secondary as never);
    const v = await fallback.embed("abc");
    expect(v).toHaveLength(256);
    expect(v[0]).toBe(3);
  });

  it("signals the fallback through onFallback", async () => {
    const failing = {
      id: "failing",
      dimensions: 4,
      embed: async () => {
        throw new Error("boom");
      },
      embedBatch: async () => {
        throw new Error("boom");
      },
    };
    const secondary = new HashEmbedder({ dimensions: 4 });
    const reasons: string[] = [];
    const fallback = new FallbackEmbedder(failing as never, secondary, { onFallback: (r) => reasons.push(r) });
    await fallback.embed("x");
    expect(reasons).toEqual(["boom"]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for zero or mismatched vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});
