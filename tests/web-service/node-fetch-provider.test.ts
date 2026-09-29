import { describe, it, expect, afterEach } from "@jest/globals";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { NodeFetchProvider, isBlockedAddress } from "../../src/web-service/index.js";

const servers: Server[] = [];

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("NodeFetchProvider SSRF boundary (default policy)", () => {
  const provider = new NodeFetchProvider();

  it.each([
    "http://127.0.0.1:1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:1/",
    "http://[::ffff:127.0.0.1]:1/",
    "http://2130706433:1/",
    "http://10.0.0.1/",
  ])("refuses literal private destination %s", async (url) => {
    await expect(provider.fetch(url)).rejects.toThrow(/blocked destination/);
  });

  it("refuses a hostname that resolves to loopback (checked at connect time)", async () => {
    const base = await serve((_req, res) => res.end("secret"));
    const port = new URL(base).port;
    await expect(provider.fetch(`http://localhost:${port}/`)).rejects.toThrow(/blocked destination localhost/);
  });

  it("refuses non-http schemes", async () => {
    await expect(provider.fetch("file:///etc/passwd")).rejects.toThrow(/blocked URL scheme/);
  });
});

describe("NodeFetchProvider behavior (private network allowed for local test servers)", () => {
  const provider = new NodeFetchProvider({ allowPrivateNetwork: true, maxResponseBytes: 1024 });

  it("returns status, headers, body and final URL", async () => {
    const base = await serve((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("hello");
    });
    const r = await provider.fetch(`${base}/x`);
    expect(r).toMatchObject({ status: 200, body: "hello", contentType: "text/plain", finalUrl: `${base}/x` });
  });

  it("decodes gzip bodies", async () => {
    const base = await serve((_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync("compressed hello"));
    });
    expect((await provider.fetch(base)).body).toBe("compressed hello");
  });

  it("caps the body size, including decompressed size (zip bomb)", async () => {
    const plain = await serve((_req, res) => res.end("x".repeat(4096)));
    await expect(provider.fetch(plain)).rejects.toThrow(/exceeds maxResponseBytes/);

    const bomb = await serve((_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(5 * 1024 * 1024)));
    });
    await expect(provider.fetch(bomb)).rejects.toThrow(/exceeds maxResponseBytes/);
  });

  it("follows redirects but re-validates each hop's scheme", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/end" });
        res.end();
      } else if (req.url === "/to-file") {
        res.writeHead(302, { location: "file:///etc/passwd" });
        res.end();
      } else {
        res.end("arrived");
      }
    });
    const r = await provider.fetch(`${base}/start`);
    expect(r.body).toBe("arrived");
    expect(r.finalUrl).toBe(`${base}/end`);
    await expect(provider.fetch(`${base}/to-file`)).rejects.toThrow(/blocked URL scheme/);
  });

  it("stops redirect loops", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    });
    await expect(new NodeFetchProvider({ allowPrivateNetwork: true, maxRedirects: 2 }).fetch(base)).rejects.toThrow(
      /too many redirects/,
    );
  });

  it("drops credentials on cross-origin redirects", async () => {
    const target = await serve((req, res) => res.end(req.headers.authorization ?? "none"));
    const targetPort = new URL(target).port;
    const origin = await serve((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${targetPort}/` });
      res.end();
    });
    const r = await provider.fetch(origin, { headers: { Authorization: "Bearer t0ken" } });
    expect(r.body).toBe("none");
  });

  it("enforces the timeout across the whole exchange", async () => {
    const base = await serve((_req, res) => {
      res.write("partial");
      // never ends
    });
    await expect(provider.fetch(base, { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/);
  });
});
