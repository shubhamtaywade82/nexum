/**
 * MemoryPack — the mountable unit for semantic-memory tools.
 *
 * Auto-mounted by AgentToolManager.registerIntelligenceTools (default-on;
 * NEXUM_SEMANTIC_MEMORY=0 disables), so every product agent gets durable
 * semantic memory without per-product wiring.
 */

import { ToolPack, packOf } from "../gateway/tool-pack.js";
import { MemoryRecallTool, MemorySaveTool } from "../memory-tools.js";
import type { SemanticMemory } from "../../memory/semantic/semantic-memory.js";

export function memoryPack(memory: SemanticMemory): ToolPack {
  return packOf("memory", "Semantic long-term memory: save and recall durable knowledge.", "memory", [
    {
      tool: new MemorySaveTool(memory),
      category: "Memory",
      metadata: {
        // Writes to the workspace .nexum database — a real, low-risk mutation.
        risk: "low",
        sideEffects: { filesystem: true, process: false, network: false, externalMutation: false, financial: false },
        execution: { timeoutMs: 30_000, concurrency: 4, idempotent: false, reversible: true, idempotencyKey: "none" },
        policy: { confirmation: "never" },
      },
    },
    {
      tool: new MemoryRecallTool(memory),
      category: "Memory",
      metadata: {
        risk: "read",
        execution: { timeoutMs: 30_000, concurrency: 8, idempotent: true, reversible: false, idempotencyKey: "none" },
        policy: { confirmation: "never" },
      },
    },
  ]);
}
