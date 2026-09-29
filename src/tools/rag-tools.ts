/**
 * RAG tools — expose the hybrid retrieval pipeline to agents.
 *
 *   rag_search   query → retrieve → fuse → rerank → cited sources (read-only)
 *
 * Mounted by default through the "rag" tool pack alongside the memory pack
 * (AgentToolManager.registerIntelligenceTools; NEXUM_SEMANTIC_MEMORY=0
 * disables both).
 */

import { Tool } from "./tool.js";
import type { RagService } from "../rag/rag-service.js";

export class RagSearchTool extends Tool {
  constructor(private readonly rag: RagService) {
    super();
  }

  get name(): string {
    return "rag_search";
  }

  get description(): string {
    return (
      "Search the workspace knowledge corpus with hybrid retrieval (semantic + keyword + graph when " +
      "available), fused and reranked. Returns passages with numbered citations — cite them as [n] " +
      "in your answer. Use before answering questions about documents, past research, or workspace knowledge."
    );
  }

  get tags(): string[] {
    return ["rag", "retrieval", "search", "hybrid", "knowledge"];
  }

  get capabilities(): string[] {
    return ["rag", "search"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query" },
        k: { type: "number", description: "Max passages to return (default 5, max 12)" },
      },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = args.query as string;
    if (typeof query !== "string" || !query.trim()) {
      return { error: "ArgumentError", message: "query is required and must be non-empty" };
    }
    const k = typeof args.k === "number" && args.k > 0 ? Math.min(args.k, 12) : 5;

    try {
      const result = await this.rag.search(query, { k });
      return {
        query,
        count: result.chunks.length,
        passages: result.chunks.map((c, i) => ({
          citation: i + 1,
          content: c.content.length > 800 ? `${c.content.slice(0, 800)}...` : c.content,
          source: c.source.ref,
          kind: c.source.kind,
          score: c.score,
        })),
        ...(result.failures.length > 0 ? { degraded: result.failures } : {}),
      };
    } catch (err) {
      return { error: "RagError", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
