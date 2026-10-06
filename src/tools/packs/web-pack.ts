/**
 * WebPack — HTTP fetch + general web search over WebService (no browser).
 */

import { ToolPack, packOf } from "../gateway/tool-pack.js";
import { InternetSearchTool, WebFetchTool } from "../web-tools.js";
import type { WebService } from "../../web-service/index.js";

const NET_READ = {
  risk: "read" as const,
  sideEffects: { network: true },
  execution: {
    timeoutMs: 30_000,
    concurrency: 4,
    idempotent: true,
    reversible: false,
    idempotencyKey: "none" as const,
  },
  policy: { confirmation: "never" as const },
};

export function webPack(web: WebService): ToolPack {
  return packOf("web", "Fetch public web pages and search the web.", "web", [
    { tool: new WebFetchTool(web), category: "Web", metadata: NET_READ },
    { tool: new InternetSearchTool(web), category: "Web", metadata: NET_READ },
  ]);
}
