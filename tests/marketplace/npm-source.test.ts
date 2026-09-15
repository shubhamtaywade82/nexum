/**
 * Tests for the NpmMarketplaceSource.
 *
 * These tests use a mock fetch() to verify the discovery + download
 * logic without making real network calls.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpmMarketplaceSource } from "../../src/marketplace/index.js";

// Save the original global fetch so we can restore it after each test.
const originalFetch = global.fetch;

function mockFetch(
  handler: (url: string) => { ok: boolean; json?: unknown; arrayBuffer?: ArrayBuffer; status?: number },
): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const response = handler(url);
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 404),
      json: async () => response.json,
      arrayBuffer: async () => response.arrayBuffer ?? new ArrayBuffer(0),
      text: async () => JSON.stringify(response.json ?? ""),
      headers: new Map(),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("NpmMarketplaceSource", () => {
  let tmpDir: string;
  let source: NpmMarketplaceSource;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-npm-"));
    source = new NpmMarketplaceSource({
      registryUrl: "https://registry.test",
      scope: "@nexum-plugin",
      cacheTtlMs: 0, // disable cache for tests
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  describe("fetchCatalog", () => {
    it("returns empty array when search returns no results", async () => {
      global.fetch = mockFetch(() => ({ ok: true, json: { total: 0, objects: [] } }));
      const entries = await source.fetchCatalog();
      expect(entries).toEqual([]);
    });

    it("returns empty array when search fails", async () => {
      global.fetch = mockFetch(() => ({ ok: false, status: 500 }));
      const entries = await source.fetchCatalog();
      expect(entries).toEqual([]);
    });

    it("returns empty array when fetch throws", async () => {
      global.fetch = (async () => {
        throw new Error("network error");
      }) as typeof fetch;
      const entries = await source.fetchCatalog();
      expect(entries).toEqual([]);
    });

    it("discovers packages from search results", async () => {
      // The search returns 2 packages; the packument fetches return metadata
      // for each. We mock both endpoints via a single handler.
      global.fetch = mockFetch((url) => {
        if (url.includes("/-/v1/search")) {
          return {
            ok: true,
            json: {
              total: 2,
              objects: [
                { package: { name: "@nexum-plugin/foo", version: "1.0.0" } },
                { package: { name: "@nexum-plugin/bar", version: "2.0.0" } },
              ],
            },
          };
        }
        if (url.includes("/@nexum-plugin%2Ffoo")) {
          return {
            ok: true,
            json: {
              name: "@nexum-plugin/foo",
              "dist-tags": { latest: "1.0.0" },
              description: "A foo plugin",
              license: "MIT",
              versions: {
                "1.0.0": {
                  version: "1.0.0",
                  dist: { tarball: "https://registry.test/foo/-/foo-1.0.0.tgz" },
                  nexum: { id: "foo", name: "Foo Plugin", tags: ["test"] },
                },
              },
            },
          };
        }
        if (url.includes("/@nexum-plugin%2Fbar")) {
          return {
            ok: true,
            json: {
              name: "@nexum-plugin/bar",
              "dist-tags": { latest: "2.0.0" },
              versions: {
                "2.0.0": {
                  version: "2.0.0",
                  dist: { tarball: "https://registry.test/bar/-/bar-2.0.0.tgz" },
                },
              },
            },
          };
        }
        return { ok: false, status: 404 };
      });
      const entries = await source.fetchCatalog();
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.id).sort()).toEqual(["@nexum-plugin/bar", "foo"]);
    });

    it("skips packages with no latest version", async () => {
      global.fetch = mockFetch((url) => {
        if (url.includes("/-/v1/search")) {
          return {
            ok: true,
            json: {
              total: 1,
              objects: [{ package: { name: "@nexum-plugin/bad", version: "1.0.0" } }],
            },
          };
        }
        return {
          ok: true,
          json: {
            name: "@nexum-plugin/bad",
            "dist-tags": {},
            versions: {},
          },
        };
      });
      const entries = await source.fetchCatalog();
      expect(entries).toEqual([]);
    });
  });

  describe("fetchEntry", () => {
    it("returns entry for known package", async () => {
      global.fetch = mockFetch((url) => {
        if (url.includes("/@nexum-plugin%2Ffoo")) {
          return {
            ok: true,
            json: {
              name: "@nexum-plugin/foo",
              "dist-tags": { latest: "1.0.0" },
              versions: {
                "1.0.0": {
                  version: "1.0.0",
                  dist: { tarball: "https://registry.test/foo.tgz" },
                  nexum: { id: "foo", name: "Foo Plugin" },
                },
              },
            },
          };
        }
        return { ok: false, status: 404 };
      });
      const entry = await source.fetchEntry("@nexum-plugin/foo");
      expect(entry).toBeDefined();
      expect(entry?.id).toBe("foo");
      expect(entry?.npmPackage).toBe("@nexum-plugin/foo");
      expect(entry?.source).toBe("npm");
    });

    it("returns undefined for unknown package", async () => {
      global.fetch = mockFetch(() => ({ ok: false, status: 404 }));
      const entry = await source.fetchEntry("@nexum-plugin/nonexistent");
      expect(entry).toBeUndefined();
    });
  });

  describe("download", () => {
    it("downloads the tarball to destPath", async () => {
      const tarballContent = new TextEncoder().encode("fake tarball content");
      global.fetch = mockFetch((url) => {
        if (url.includes("/@nexum-plugin%2Ffoo")) {
          return {
            ok: true,
            json: {
              name: "@nexum-plugin/foo",
              "dist-tags": { latest: "1.0.0" },
              versions: {
                "1.0.0": {
                  version: "1.0.0",
                  dist: { tarball: "https://registry.test/foo.tgz" },
                },
              },
            },
          };
        }
        if (url.endsWith("/foo.tgz")) {
          return { ok: true, arrayBuffer: tarballContent.buffer };
        }
        return { ok: false, status: 404 };
      });
      const destPath = join(tmpDir, "foo.tgz");
      await source.download(
        {
          id: "foo",
          name: "Foo",
          version: "1.0.0",
          npmPackage: "@nexum-plugin/foo",
          source: "npm",
        },
        destPath,
      );
      const { readFileSync, statSync } = await import("node:fs");
      expect(statSync(destPath).size).toBe(tarballContent.length);
      expect(readFileSync(destPath).toString()).toBe("fake tarball content");
    });

    it("throws when entry has no npmPackage", async () => {
      await expect(
        source.download({ id: "x", name: "X", version: "1.0.0", source: "npm" }, join(tmpDir, "x.tgz")),
      ).rejects.toThrow(/has no npmPackage/);
    });

    it("throws when package not found", async () => {
      global.fetch = mockFetch(() => ({ ok: false, status: 404 }));
      await expect(
        source.download(
          { id: "x", name: "X", version: "1.0.0", npmPackage: "@nexum-plugin/x", source: "npm" },
          join(tmpDir, "x.tgz"),
        ),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("caching", () => {
    it("caches catalog results within TTL", async () => {
      let callCount = 0;
      global.fetch = mockFetch((url) => {
        if (url.includes("/-/v1/search")) {
          callCount++;
          return { ok: true, json: { total: 0, objects: [] } };
        }
        return { ok: false, status: 404 };
      });
      const cachedSource = new NpmMarketplaceSource({
        registryUrl: "https://registry.test",
        scope: "@nexum-plugin",
        cacheTtlMs: 60000, // 1 min
      });
      await cachedSource.fetchCatalog();
      await cachedSource.fetchCatalog();
      expect(callCount).toBe(1); // search only called once
    });
  });
});

// Keep writeFileSync import used for side-effect typing.
void writeFileSync;
void jest;
