/**
 * WebService — separated web capability providers.
 *
 * Nexum currently has a Playwright browser implementation (navigate, click,
 * fill, get_text, screenshot, evaluate, close). That's good, but the
 * browser is too coupled to "web access" — it's the only way to fetch
 * web content.
 *
 * DeepSeek separates:
 *   Web Service
 *      ├── Search Provider
 *      ├── Fetch Provider
 *      └── model-facing Web tools
 *
 * This module formalizes that architecture:
 *
 *   WebService
 *      ├── BrowserProvider     (Playwright — heavy, full JS execution)
 *      ├── SearchProvider       (web search via search engine API)
 *      ├── FetchProvider        (lightweight HTTP fetch, no JS)
 *      ├── HttpProvider         (raw HTTP client)
 *      └── WebContentExtractor  (HTML → markdown / plain text)
 *
 * Browser automation becomes one implementation rather than the definition
 * of web access. Tools that just need to fetch a URL use FetchProvider;
 * tools that need to interact with a page use BrowserProvider.
 */

import { existsSync, readFileSync } from "node:fs";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

// ── Contracts ───────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebFetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  finalUrl: string; // after redirects
}

export interface WebContentExtraction {
  url: string;
  title: string;
  content: string; // markdown or plain text
  contentType: string;
  wordCount: number;
}

// ── Provider interfaces ─────────────────────────────────────────────────────

export interface SearchProvider {
  readonly id: string;
  search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]>;
}

export interface FetchProvider {
  readonly id: string;
  fetch(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<WebFetchResult>;
}

export interface HttpProvider {
  readonly id: string;
  request(
    method: string,
    url: string,
    opts?: { headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<WebFetchResult>;
}

export interface BrowserProvider {
  readonly id: string;
  navigate(url: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot?(): Promise<Buffer>;
  close?(): Promise<void>;
}

export interface WebContentExtractor {
  readonly id: string;
  extract(html: string, url: string): WebContentExtraction;
}

// ── WebService ──────────────────────────────────────────────────────────────

export class WebService {
  private searchProvider?: SearchProvider;
  private fetchProvider?: FetchProvider;
  private httpProvider?: HttpProvider;
  private browserProvider?: BrowserProvider;
  private extractor?: WebContentExtractor;

  setSearchProvider(provider: SearchProvider): this {
    this.searchProvider = provider;
    return this;
  }

  setFetchProvider(provider: FetchProvider): this {
    this.fetchProvider = provider;
    return this;
  }

  setHttpProvider(provider: HttpProvider): this {
    this.httpProvider = provider;
    return this;
  }

  setBrowserProvider(provider: BrowserProvider): this {
    this.browserProvider = provider;
    return this;
  }

  setExtractor(extractor: WebContentExtractor): this {
    this.extractor = extractor;
    return this;
  }

  /** Search the web. */
  async search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]> {
    if (!this.searchProvider) {
      throw new Error("no search provider configured");
    }
    return this.searchProvider.search(query, opts);
  }

  /** Fetch a URL (lightweight — no JS execution). */
  async fetch(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<WebFetchResult> {
    if (!this.fetchProvider) {
      throw new Error("no fetch provider configured");
    }
    return this.fetchProvider.fetch(url, opts);
  }

  /** Raw HTTP request. */
  async request(
    method: string,
    url: string,
    opts?: { headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<WebFetchResult> {
    if (!this.httpProvider) {
      throw new Error("no HTTP provider configured");
    }
    return this.httpProvider.request(method, url, opts);
  }

  /** Get the browser provider (for tools that need full page interaction). */
  browser(): BrowserProvider {
    if (!this.browserProvider) {
      throw new Error("no browser provider configured");
    }
    return this.browserProvider;
  }

  /** Fetch + extract content (convenience method). */
  async fetchAndExtract(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<WebContentExtraction> {
    const result = await this.fetch(url, opts);
    if (!this.extractor) {
      return {
        url: result.finalUrl,
        title: "",
        content: result.body,
        contentType: result.contentType,
        wordCount: result.body.split(/\s+/).length,
      };
    }
    return this.extractor.extract(result.body, result.finalUrl);
  }
}

// ── Built-in providers ──────────────────────────────────────────────────────

function blockList(family: "ipv4" | "ipv6", subnets: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of subnets) list.addSubnet(net, prefix, family);
  return list;
}

// Separate lists: BlockList also matches IPv4 input against IPv4-mapped IPv6 rules.
const BLOCKED_V4 = blockList("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);
const BLOCKED_V6 = blockList("ipv6", [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]);

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved and IPv4-mapped addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.check(address, "ipv4");
  if (family === 6) return BLOCKED_V6.check(address, "ipv6");
  return true;
}

export interface NodeFetchProviderOptions {
  /** Allow loopback/private/link-local destinations (default false). Only for trusted local use. */
  allowPrivateNetwork?: boolean;
  /** Max decompressed response body in bytes (default 10 MiB). */
  maxResponseBytes?: number;
  /** Max redirects followed (default 5). Every hop is re-validated. */
  maxRedirects?: number;
}

type RawResponse = { status: number; headers: Record<string, string>; stream: Readable };

/**
 * NodeFetchProvider — HTTP(S) client for agent web access with an SSRF and
 * resource boundary:
 *   - http/https only; every redirect hop re-validated
 *   - destinations resolved and checked at connect time (the checked address
 *     is the one connected to, so DNS rebinding cannot swap it)
 *   - private/loopback/link-local/metadata ranges refused unless allowed
 *   - decompressed body capped (bounds zip bombs); one deadline for the whole exchange
 *   - Authorization/Cookie dropped on cross-origin redirects
 */
export class NodeFetchProvider implements FetchProvider, HttpProvider {
  readonly id = "node-fetch";
  private readonly allowPrivateNetwork: boolean;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;

  constructor(opts: NodeFetchProviderOptions = {}) {
    this.allowPrivateNetwork = opts.allowPrivateNetwork ?? false;
    this.maxResponseBytes = opts.maxResponseBytes ?? 10 * 1024 * 1024;
    this.maxRedirects = opts.maxRedirects ?? 5;
  }

  async fetch(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<WebFetchResult> {
    return this.request("GET", url, opts);
  }

  async request(
    method: string,
    url: string,
    opts?: { headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<WebFetchResult> {
    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const timeout = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      let current = new URL(url);
      let currentMethod = method.toUpperCase();
      let body = opts?.body;
      let headers: Record<string, string> = { ...opts?.headers };
      for (let hop = 0; ; hop++) {
        this.assertAllowedUrl(current);
        const res = await this.send(currentMethod, current, headers, body, controller.signal);
        const location = res.headers["location"];
        if ([301, 302, 303, 307, 308].includes(res.status) && location) {
          res.stream.resume();
          if (hop >= this.maxRedirects) throw new Error(`too many redirects (max ${this.maxRedirects})`);
          const next = new URL(location, current);
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
            currentMethod = "GET";
            body = undefined;
          }
          if (next.origin !== current.origin) headers = withoutCredentials(headers);
          current = next;
          continue;
        }
        const text = (await this.readBody(res, controller.signal)).toString("utf8");
        return {
          url,
          status: res.status,
          headers: res.headers,
          body: text,
          contentType: res.headers["content-type"] ?? "application/octet-stream",
          finalUrl: current.href,
        };
      }
    } catch (e) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertAllowedUrl(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`blocked URL scheme "${url.protocol}" (only http/https)`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!this.allowPrivateNetwork && isIP(host) && isBlockedAddress(host)) {
      throw new Error(`blocked destination ${host}: private, loopback or reserved address`);
    }
  }

  private send(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<RawResponse> {
    const lookup: LookupFunction = (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = addresses as LookupAddress[];
        const blocked = this.allowPrivateNetwork ? undefined : list.find((a) => isBlockedAddress(a.address));
        if (blocked) {
          const e = new Error(
            `blocked destination ${hostname} (${blocked.address}): private, loopback or reserved address`,
          );
          return callback(e as NodeJS.ErrnoException, "", 0);
        }
        if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        else callback(null, list[0].address, list[0].family);
      });
    };
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const hasEncoding = Object.keys(headers).some((k) => k.toLowerCase() === "accept-encoding");
    return new Promise<RawResponse>((resolve, reject) => {
      const req = requestFn(
        url,
        {
          method,
          headers: hasEncoding ? headers : { ...headers, "Accept-Encoding": "gzip, deflate, br" },
          lookup,
          signal,
        },
        (res) => {
          const flat: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) flat[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({ status: res.statusCode ?? 0, headers: flat, stream: res });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  private readBody(res: RawResponse, signal: AbortSignal): Promise<Buffer> {
    const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
    let stream: Readable = res.stream;
    if (encoding === "gzip" || encoding === "x-gzip") stream = res.stream.pipe(createGunzip());
    else if (encoding === "deflate") stream = res.stream.pipe(createInflate());
    else if (encoding === "br") stream = res.stream.pipe(createBrotliDecompress());
    const limit = this.maxResponseBytes;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const fail = (e: Error) => {
        res.stream.destroy();
        stream.destroy();
        reject(e);
      };
      signal.addEventListener("abort", () => fail(signal.reason as Error), { once: true });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) fail(new Error(`response body exceeds maxResponseBytes (${limit})`));
        else chunks.push(chunk);
      });
      stream.on("error", (e) => fail(e));
      res.stream.on("error", (e) => fail(e));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }
}

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower !== "authorization" && lower !== "cookie" && lower !== "proxy-authorization") out[k] = v;
  }
  return out;
}

/**
 * SimpleWebContentExtractor — basic HTML → text conversion.
 * Strips tags, preserves text content, extracts <title>.
 */
export class SimpleWebContentExtractor implements WebContentExtractor {
  readonly id = "simple-extractor";

  extract(html: string, url: string): WebContentExtraction {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    // Remove script and style blocks.
    let content = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

    // Convert common block elements to newlines.
    content = content.replace(/<(p|div|h[1-6]|li|tr|br)[^>]*>/gi, "\n");

    // Strip remaining tags.
    content = content.replace(/<[^>]+>/g, "");

    // Decode common entities.
    content = content
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Collapse whitespace.
    content = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    return {
      url,
      title,
      content,
      contentType: "text/plain",
      wordCount: content.split(/\s+/).filter((w) => w.length > 0).length,
    };
  }
}

/**
 * StubSearchProvider — returns empty results (for tests / placeholder).
 *
 * @deprecated Use DuckDuckGoSearchProvider as the default. StubSearchProvider
 * is kept for tests and offline use.
 */
export class StubSearchProvider implements SearchProvider {
  readonly id = "stub-search";
  async search(_query: string, _opts?: { maxResults?: number }): Promise<WebSearchResult[]> {
    return [];
  }
}

/**
 * DuckDuckGoSearchProvider — performs real web searches via DuckDuckGo's
 * HTML Lite endpoint (https://lite.duckduckgo.com/lite/).
 *
 * Why DuckDuckGo Lite?
 *   - No API key required (works out of the box).
 *   - No rate limits for reasonable personal/research use.
 *   - HTML-only response (small, parseable, no JS).
 *   - Privacy-respecting (no tracking, no user identification).
 *
 * Parsing:
 *   - Fetches the HTML search results page.
 *   - Extracts result anchors + snippets via regex (the HTML is stable
 *     enough for this; if DuckDuckGo changes the layout, parsing will
 *     degrade gracefully by returning fewer results).
 *
 * This is the default SearchProvider for `defaultWebService()`. For
 * production-grade search (Bing, Google, Brave, SearXNG), implement a
 * custom `SearchProvider` against the upstream API and pass it to
 * `WebService.setSearchProvider()`.
 *
 * @experimental
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly id = "duckduckgo";
  private readonly fetchProvider: FetchProvider;
  private readonly extractor: WebContentExtractor;
  private readonly endpoint: string;

  constructor(opts?: { fetchProvider?: FetchProvider; extractor?: WebContentExtractor; endpoint?: string }) {
    this.fetchProvider = opts?.fetchProvider ?? new NodeFetchProvider();
    this.extractor = opts?.extractor ?? new SimpleWebContentExtractor();
    this.endpoint = opts?.endpoint ?? "https://lite.duckduckgo.com/lite/";
  }

  async search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]> {
    const max = opts?.maxResults ?? 10;
    // DuckDuckGo Lite accepts both GET and POST; use GET with URL params
    // (simpler + cacheable + matches the FetchProvider.fetch() signature).
    const url = `${this.endpoint}?q=${encodeURIComponent(query)}&kl=us-en`;
    let result: WebFetchResult;
    try {
      result = await this.fetchProvider.fetch(url, {
        headers: {
          "User-Agent": "nexum-agent-runtime/2.0 (+https://github.com/shubhamtaywade82/nexum)",
          Accept: "text/html",
        },
        timeoutMs: 15000,
      });
    } catch {
      return [];
    }
    if (result.status !== 200) return [];
    // Parse the HTML for result links + snippets.
    // DuckDuckGo Lite uses <a class="result-link" href="...">title</a>
    // and a sibling <td class="result-snippet">snippet</td>.
    return this.parseResults(result.body, max);
  }

  /**
   * Parse DuckDuckGo Lite HTML into WebSearchResult[].
   * Uses simple regex matching; degrades gracefully on layout changes.
   */
  private parseResults(html: string, max: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    // Match anchor tags that link to external URLs (skip duckduckgo.com).
    // DuckDuckGo Lite wraps results in <a class="result-link" href="URL">Title</a>
    const anchorRegex = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) !== null && results.length < max) {
      const url = decodeHtmlEntities(match[1]);
      // Skip internal DuckDuckGo links.
      if (url.startsWith("https://duckduckgo.com") || url.startsWith("/")) continue;
      const title = decodeHtmlEntities(stripTags(match[2])).trim();
      if (!title || !url) continue;
      // Look for a snippet near this anchor (next ~500 chars of HTML).
      const afterAnchor = html.slice(match.index + match[0].length, match.index + match[0].length + 1000);
      const snippetMatch = afterAnchor.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const snippet = snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])).trim() : "";
      results.push({ title, url, snippet });
    }

    // Fallback: if the result-link regex didn't match, try a more permissive
    // anchor extraction (some DDG layouts vary).
    if (results.length === 0) {
      const fallbackAnchor = /<a[^>]*href="(https?:\/\/(?!duckduckgo\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = fallbackAnchor.exec(html)) !== null && results.length < max) {
        const url = decodeHtmlEntities(match[1]);
        const title = decodeHtmlEntities(stripTags(match[2])).trim();
        if (!title || !url) continue;
        results.push({ title, url, snippet: "" });
      }
    }
    return results;
  }
}

/**
 * FileSearchProvider — searches a local index file (for offline / tests).
 */
export class FileSearchProvider implements SearchProvider {
  readonly id = "file-search";
  private results: WebSearchResult[] = [];

  constructor(indexFile?: string) {
    if (indexFile && existsSync(indexFile)) {
      try {
        const data = JSON.parse(readFileSync(indexFile, "utf8"));
        if (Array.isArray(data)) {
          this.results = data as WebSearchResult[];
        }
      } catch {
        // corrupt index — empty
      }
    }
  }

  async search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]> {
    const terms = query.toLowerCase().split(/\s+/);
    const max = opts?.maxResults ?? 10;
    return this.results
      .map((r) => ({
        ...r,
        score: terms.filter((t) => (r.title + r.snippet).toLowerCase().includes(t)).length,
      }))
      .filter((r) => (r.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, max);
  }
}

// ── HTML parsing helpers ────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Factory: default web service with Node fetch + DuckDuckGo search + simple extractor. */
export function defaultWebService(): WebService {
  const fetchProvider = new NodeFetchProvider();
  return new WebService()
    .setFetchProvider(fetchProvider)
    .setHttpProvider(fetchProvider)
    .setExtractor(new SimpleWebContentExtractor())
    .setSearchProvider(new DuckDuckGoSearchProvider({ fetchProvider }));
}
