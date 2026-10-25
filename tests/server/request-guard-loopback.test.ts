import { request as httpRequest } from "node:http";

import { ServerHarness } from "../support/server-harness.js";

// The mode that was exploitable: loopback, no token. Any local caller is still
// accepted (that is the documented local-dev boundary), but a browser page
// must not be able to reach it.

function rawPost(
  baseUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, method: "POST", path: "/sessions", headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data.length > 0 ? JSON.parse(data) : undefined });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("loopback host without a token refuses browser-driven requests", () => {
  const harness = new ServerHarness();
  const JSON_BODY = "{}";
  const json = { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON_BODY)) };

  beforeAll(async () => {
    await harness.start({});
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    await harness.pg.cleanTables();
  });

  it("keeps the local-dev flow: a JSON request from loopback needs no token", async () => {
    const res = await rawPost(harness.baseUrl, json, JSON_BODY);
    expect(res.status).toBe(201);
  });

  it("refuses a rebinding request, which the host used to accept", async () => {
    const port = new URL(harness.baseUrl).port;
    const res = await rawPost(harness.baseUrl, { ...json, Host: `attacker.example:${port}` }, JSON_BODY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden_host" });
  });

  it("refuses a cross-site text/plain POST, which the host used to accept with a 201", async () => {
    const res = await rawPost(
      harness.baseUrl,
      {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(JSON_BODY)),
        Origin: "https://attacker.example",
      },
      JSON_BODY,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden_origin" });
  });
});
