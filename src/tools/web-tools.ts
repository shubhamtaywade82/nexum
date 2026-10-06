/**
 * Web tools over WebService (src/web-service): plain HTTP fetch + content
 * extraction and a general web search, without launching a browser.
 *
 *   web_fetch        GET a URL and return extracted readable text
 *   internet_search  general web search (titles, urls, snippets)
 *
 * The default NodeFetchProvider refuses loopback/private/link-local/cloud-
 * metadata destinations (SSRF guard) — these tools inherit that.
 */

import { Tool, ToolError } from "./tool.js";
import type { WebService } from "../web-service/index.js";

const DEFAULT_MAX_CHARS = 8_000;
const HARD_MAX_CHARS = 40_000;

export class WebFetchTool extends Tool {
  constructor(private readonly web: WebService) {
    super();
  }
  get name() {
    return "web_fetch";
  }
  get description() {
    return "Fetch a public http(s) URL and return its readable text (HTML is stripped). Use for docs pages, changelogs, API references. Private/internal addresses are refused.";
  }
  override get tags() {
    return ["web", "fetch", "url", "http", "page", "download", "docs"];
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        max_chars: {
          type: "integer",
          description: `Content cap (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS})`,
        },
      },
      required: ["url"],
    };
  }
  async call(args: Record<string, unknown>) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) throw new ToolError("url must be an absolute http(s) URL");
    const max = Math.min(
      HARD_MAX_CHARS,
      typeof args.max_chars === "number" && args.max_chars > 0 ? Math.floor(args.max_chars) : DEFAULT_MAX_CHARS,
    );
    const page = await this.web.fetchAndExtract(url, { timeoutMs: 20_000 });
    const truncated = page.content.length > max;
    return {
      url: page.url,
      title: page.title,
      content_type: page.contentType,
      content: truncated ? page.content.slice(0, max) : page.content,
      truncated,
      word_count: page.wordCount,
    };
  }
}

export class InternetSearchTool extends Tool {
  constructor(private readonly web: WebService) {
    super();
  }
  get name() {
    return "internet_search";
  }
  get description() {
    return "General web search; returns result titles, URLs and snippets. Follow up with web_fetch to read a result. (web_search is a Wikipedia-only fact lookup.)";
  }
  override get tags() {
    return ["web", "search", "internet", "google", "lookup", "news"];
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", description: "1-10, default 5" },
      },
      required: ["query"],
    };
  }
  async call(args: Record<string, unknown>) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new ToolError("query is required");
    const n = typeof args.max_results === "number" ? Math.max(1, Math.min(10, Math.floor(args.max_results))) : 5;
    const results = await this.web.search(query, { maxResults: n });
    return { query, results: results.slice(0, n) };
  }
}
