/**
 * Memory tools — expose SemanticMemory to agents.
 *
 *   memory_save    persist a fact/lesson/preference/note (low risk, mutating)
 *   memory_recall  semantic recall of relevant memories (read-only)
 *
 * Mounted by default through the "memory" tool pack (AgentToolManager
 * auto-mounts it in registerBaseTools; NEXUM_SEMANTIC_MEMORY=0 disables).
 */

import { Tool } from "./tool.js";
import type { SemanticMemory } from "../memory/semantic/semantic-memory.js";
import type { MemoryKind } from "../memory/semantic/semantic-memory.js";

const KINDS: MemoryKind[] = ["fact", "lesson", "episode", "note", "preference", "skill"];

export class MemorySaveTool extends Tool {
  constructor(private readonly memory: SemanticMemory) {
    super();
  }

  get name(): string {
    return "memory_save";
  }

  get description(): string {
    return (
      "Persist a durable memory for future sessions: facts about this workspace/user, lessons learned, " +
      "preferences, or reusable knowledge. Memories are retrieved semantically by memory_recall and " +
      "injected into context when relevant — save things worth remembering across tasks, not transient state."
    );
  }

  get tags(): string[] {
    return ["memory", "semantic", "persist", "long-term"];
  }

  get capabilities(): string[] {
    return ["memory"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory to persist (one clear statement)" },
        kind: {
          type: "string",
          enum: KINDS,
          description: 'Memory kind (default "note")',
        },
        importance: {
          type: "number",
          description: "0..1 — how much this memory should matter in ranking (default 0.5)",
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional filter tags" },
      },
      required: ["text"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const text = args.text as string;
    if (typeof text !== "string" || !text.trim()) {
      return { error: "ArgumentError", message: "text is required and must be non-empty" };
    }
    const kind = KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : "note";
    const importance = typeof args.importance === "number" ? Math.max(0, Math.min(1, args.importance)) : undefined;
    const tags = Array.isArray(args.tags) ? args.tags.map(String).slice(0, 8) : undefined;

    try {
      const id = await this.memory.remember({ text: text.trim(), kind, importance, tags });
      return { saved: true, id, kind, text: text.trim().slice(0, 200) };
    } catch (err) {
      return { error: "MemoryError", message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export class MemoryRecallTool extends Tool {
  constructor(private readonly memory: SemanticMemory) {
    super();
  }

  get name(): string {
    return "memory_recall";
  }

  get description(): string {
    return (
      "Semantic recall of long-term memories relevant to a query. Use before making assumptions about " +
      "this workspace/user's preferences, past decisions, lessons, or previously learned facts."
    );
  }

  get tags(): string[] {
    return ["memory", "semantic", "search", "recall"];
  }

  get capabilities(): string[] {
    return ["memory"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "What to remember (natural language)" },
        k: { type: "number", description: "Max memories to return (default 5, max 20)" },
        kinds: {
          type: "array",
          items: { type: "string", enum: KINDS },
          description: "Restrict to these memory kinds",
        },
      },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = args.query as string;
    if (typeof query !== "string" || !query.trim()) {
      return { error: "ArgumentError", message: "query is required and must be non-empty" };
    }
    const k = typeof args.k === "number" && args.k > 0 ? Math.min(args.k, 20) : 5;
    const kinds = Array.isArray(args.kinds)
      ? (args.kinds.filter((x) => KINDS.includes(x as MemoryKind)) as MemoryKind[])
      : undefined;

    try {
      const hits = await this.memory.recall(query, { k, kinds });
      return {
        query,
        count: hits.length,
        memories: hits.map((h) => ({
          id: h.id,
          kind: h.kind,
          text: h.text,
          tags: h.tags,
          score: h.score.final,
          relevance: h.score.relevance,
        })),
      };
    } catch (err) {
      return { error: "MemoryError", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
