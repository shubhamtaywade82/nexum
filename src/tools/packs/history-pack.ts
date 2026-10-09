/**
 * HistoryPack — read-only session/run history tools (SessionQueryService).
 */

import { ToolPack, packOf } from "../gateway/tool-pack.js";
import { SessionEventsTool, SessionSearchTool, SessionTraceTool } from "../session-history-tools.js";
import type { SessionQueryService } from "../../session-query/index.js";
import { ArtifactReadTool } from "../artifact-tools.js";
import type { ArtifactStore } from "../../artifacts/index.js";

const READ = {
  risk: "read" as const,
  execution: {
    timeoutMs: 15_000,
    concurrency: 8,
    idempotent: true,
    reversible: false,
    idempotencyKey: "none" as const,
  },
  policy: { confirmation: "never" as const },
};

export function historyPack(query: SessionQueryService, artifacts?: ArtifactStore): ToolPack {
  return packOf("history", "Search and trace past sessions and recorded runs; read stored artifacts.", "history", [
    { tool: new SessionSearchTool(query), category: "Memory", metadata: READ },
    { tool: new SessionEventsTool(query), category: "Memory", metadata: READ },
    { tool: new SessionTraceTool(query), category: "Memory", metadata: READ },
    ...(artifacts ? [{ tool: new ArtifactReadTool(artifacts), category: "Memory", metadata: READ }] : []),
  ]);
}
