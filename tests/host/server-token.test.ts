import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexumClient } from "../../src/assistant/client/index.js";
import { globalStateDir } from "../../src/platform/paths.js";
import {
  loadOrCreateServerToken,
  readServerToken,
  resolveServeAuth,
  serverTokenPath,
} from "../../src/host/server-token.js";

// base64url of 32 random bytes is 43 characters.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

describe("per-user loopback token", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-token-"));
    path = join(dir, "state", "server-token");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a 0600 token on first use and returns the same token afterwards", () => {
    const first = loadOrCreateServerToken(path);
    expect(first).toMatch(TOKEN_SHAPE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateServerToken(path)).toBe(first);
  });

  it("treats a blank token file as missing and replaces it", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(path, "  \n");
    expect(readServerToken(path)).toBeUndefined();
    expect(loadOrCreateServerToken(path)).toMatch(TOKEN_SHAPE);
  });

  it("keeps the token file in the global state directory", () => {
    expect(serverTokenPath(dir)).toBe(join(globalStateDir(dir), "server-token"));
  });

  describe("resolveServeAuth", () => {
    it("uses NEXUM_SERVER_TOKEN when it is set and creates no file", () => {
      expect(resolveServeAuth({ host: "127.0.0.1", envToken: "from-env", noToken: false, tokenPath: path })).toEqual({
        kind: "token",
        token: "from-env",
        source: "env",
      });
      expect(readServerToken(path)).toBeUndefined();
    });

    it("treats an empty NEXUM_SERVER_TOKEN as unset and generates the per-user token", () => {
      const auth = resolveServeAuth({ host: "127.0.0.1", envToken: "", noToken: false, tokenPath: path });
      expect(auth).toEqual({ kind: "token", token: readServerToken(path), source: "file" });
    });

    it("generates the per-user token on every loopback bind name", () => {
      for (const host of ["127.0.0.1", "localhost", "::1"]) {
        const auth = resolveServeAuth({ host, envToken: undefined, noToken: false, tokenPath: path });
        expect(auth).toEqual({ kind: "token", token: readServerToken(path), source: "file" });
      }
    });

    it("runs without a token when the operator passes --no-token, creating no file", () => {
      expect(resolveServeAuth({ host: "127.0.0.1", envToken: undefined, noToken: true, tokenPath: path })).toEqual({
        kind: "none",
      });
      expect(readServerToken(path)).toBeUndefined();
    });

    it("never generates a token for a non-loopback bind, which must be given one explicitly", () => {
      expect(resolveServeAuth({ host: "0.0.0.0", envToken: undefined, noToken: false, tokenPath: path })).toEqual({
        kind: "none",
      });
      expect(readServerToken(path)).toBeUndefined();
    });
  });

  describe("NexumClient default token", () => {
    const okFetch = (seen: string[]): typeof fetch =>
      (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

    it("sends the per-user token to a loopback base URL", async () => {
      const token = loadOrCreateServerToken(path);
      const seen: string[] = [];
      const client = new NexumClient({ baseUrl: "http://127.0.0.1:3777", tokenFile: path, fetchFn: okFetch(seen) });

      await client.health();
      expect(seen).toEqual([`Bearer ${token}`]);
    });

    it("never sends the per-user token to a non-loopback base URL", async () => {
      loadOrCreateServerToken(path);
      const seen: string[] = [];
      const client = new NexumClient({
        baseUrl: "https://nexum.example.com",
        tokenFile: path,
        fetchFn: okFetch(seen),
      });

      await client.health();
      expect(seen).toEqual([""]);
    });

    it("prefers an explicit token over the per-user token", async () => {
      loadOrCreateServerToken(path);
      const seen: string[] = [];
      const client = new NexumClient({
        baseUrl: "http://127.0.0.1:3777",
        token: "explicit",
        tokenFile: path,
        fetchFn: okFetch(seen),
      });

      await client.health();
      expect(seen).toEqual(["Bearer explicit"]);
    });
  });
});
