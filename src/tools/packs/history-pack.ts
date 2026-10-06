/**
 * HistoryPack — read-only session/run history tools (SessionQueryService).
 */

import { ToolPack, packOf } from "../gateway/tool-pack.js";
import { SessionEventsTool, SessionSearchTool, SessionTraceTool } from "../session-history-tools.js";
import type { SessionQueryService } from "../../session-query/index.js";

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

export function historyPack(query: SessionQueryService): ToolPack {
  return packOf("history", "Search and trace past sessions and recorded runs.", "history", [
    { tool: new SessionSearchTool(query), category: "Memory", metadata: READ },
    { tool: new SessionEventsTool(query), category: "Memory", metadata: READ },
    { tool: new SessionTraceTool(query), category: "Memory", metadata: READ },
  ]);
}
