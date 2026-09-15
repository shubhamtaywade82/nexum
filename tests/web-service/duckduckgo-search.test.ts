/**
 * Tests for the DuckDuckGoSearchProvider.
 *
 * These tests use a mock fetch provider to verify the search + HTML
 * parsing logic without making real network calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDuckGoSearchProvider, type FetchProvider, type WebFetchResult } from "../../src/web-service/index.js";

class MockFetchProvider implements FetchProvider {
  readonly id = "mock-fetch";
  public calls: Array<{ url: string; opts?: { headers?: Record<string, string>; timeoutMs?: number } }> = [];
  public response: WebFetchResult = {
    url: "https://lite.duckduckgo.com/lite/",
    status: 200,
    headers: {},
    body: "",
    contentType: "text/html",
    finalUrl: "https://lite.duckduckgo.com/lite/",
  };

  async fetch(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<WebFetchResult> {
    this.calls.push({ url, opts });
    return this.response;
  }
}

describe("DuckDuckGoSearchProvider", () => {
  let tmpDir: string;
  let mockFetch: MockFetchProvider;
  let provider: DuckDuckGoSearchProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-ddg-"));
    mockFetch = new MockFetchProvider();
    provider = new DuckDuckGoSearchProvider({ fetchProvider: mockFetch });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when fetch fails", async () => {
    mockFetch.fetch = async () => {
      throw new Error("network error");
    };
    const results = await provider.search("test query");
    expect(results).toEqual([]);
  });

  it("returns empty array on non-200 status", async () => {
    mockFetch.response = { ...mockFetch.response, status: 500 };
    const results = await provider.search("test");
    expect(results).toEqual([]);
  });

  it("parses DuckDuckGo Lite HTML into results", async () => {
    // Sample DuckDuckGo Lite HTML structure
    mockFetch.response.body = `
      <html><body>
        <table>
          <tr>
            <td>
              <a class="result-link" href="https://example.com/page1">Example Page 1</a>
            </td>
          </tr>
          <tr>
            <td class="result-snippet">This is the first snippet.</td>
          </tr>
          <tr>
            <td>
              <a class="result-link" href="https://example.com/page2">Example Page 2</a>
            </td>
          </tr>
          <tr>
            <td class="result-snippet">Second snippet here.</td>
          </tr>
        </table>
      </body></html>
    `;
    const results = await provider.search("example");
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("Example Page 1");
    expect(results[0].url).toBe("https://example.com/page1");
    expect(results[0].snippet).toContain("first snippet");
    expect(results[1].title).toBe("Example Page 2");
  });

  it("skips internal DuckDuckGo links", async () => {
    mockFetch.response.body = `
      <a class="result-link" href="https://duckduckgo.com/internal">Internal</a>
      <td class="result-snippet">internal snippet</td>
      <a class="result-link" href="https://example.com/external">External</a>
      <td class="result-snippet">external snippet</td>
    `;
    const results = await provider.search("test");
    expect(results.length).toBe(1);
    expect(results[0].url).toBe("https://example.com/external");
  });

  it("respects maxResults option", async () => {
    mockFetch.response.body = `
      <a class="result-link" href="https://example.com/1">Result 1</a>
      <a class="result-link" href="https://example.com/2">Result 2</a>
      <a class="result-link" href="https://example.com/3">Result 3</a>
      <a class="result-link" href="https://example.com/4">Result 4</a>
      <a class="result-link" href="https://example.com/5">Result 5</a>
    `;
    const results = await provider.search("test", { maxResults: 3 });
    expect(results.length).toBe(3);
  });

  it("falls back to permissive anchor extraction when result-link regex fails", async () => {
    // HTML without the result-link class — should fall back to plain anchors
    mockFetch.response.body = `
      <a href="https://example.com/fallback">Fallback Result</a>
      <a href="https://duckduckgo.com/skip">Skip This</a>
    `;
    const results = await provider.search("test");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Fallback Result");
    expect(results[0].url).toBe("https://example.com/fallback");
  });

  it("sends POST with form-encoded body and User-Agent header", async () => {
    mockFetch.response.body = "";
    await provider.search("test query");
    expect(mockFetch.calls.length).toBe(1);
    expect(mockFetch.calls[0].opts?.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(mockFetch.calls[0].opts?.headers?.["User-Agent"]).toMatch(/nexum-agent-runtime/);
  });

  it("decodes HTML entities in titles and snippets", async () => {
    mockFetch.response.body = `
      <a class="result-link" href="https://example.com/x">Tom &amp; Jerry &lt;cartoon&gt;</a>
      <td class="result-snippet">It&#39;s a &quot;fun&quot; show</td>
    `;
    const results = await provider.search("test");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Tom & Jerry <cartoon>");
    expect(results[0].snippet).toContain(`"fun"`);
    expect(results[0].snippet).toContain(`It's`);
  });
});
