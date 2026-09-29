/**
 * RagPack — the mountable unit for hybrid-retrieval tools.
 *
 * Auto-mounted by AgentToolManager.registerIntelligenceTools together with
 * the memory pack (default-on; NEXUM_SEMANTIC_MEMORY=0 disables).
 */

import { ToolPack, packOf } from "../gateway/tool-pack.js";
import { RagSearchTool } from "../rag-tools.js";
import type { RagService } from "../../rag/rag-service.js";

export function ragPack(rag: RagService): ToolPack {
  return packOf("rag", "Hybrid retrieval (semantic + lexical) over workspace knowledge.", "rag", [
    {
      tool: new RagSearchTool(rag),
      category: "Retrieval",
      metadata: {
        risk: "read",
        execution: { timeoutMs: 60_000, concurrency: 4, idempotent: true, reversible: false, idempotencyKey: "none" },
        policy: { confirmation: "never" },
      },
    },
  ]);
}
