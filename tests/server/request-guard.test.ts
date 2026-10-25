import { request as httpRequest } from "node:http";

import { ServerHarness } from "../support/server-harness.js";

// Raw HTTP, so the test can set Host and Origin the way a browser would.
// fetch() does not let a caller choose those headers.
interface RawResponse {
  status: number;
  body: unknown;
}

function rawRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = data.length > 0 ? JSON.parse(data) : undefined;
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_BODY = "{}";
const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "content-type": "application/json",
  "content-length": String(Buffer.byteLength(JSON_BODY)),
  ...extra,
});

describe("Host and Origin guard with a bearer token (Wave 11 hardening)", () => {
  const harness = new ServerHarness();
  const TOKEN = "guard_test_token_12345";

  beforeAll(async () => {
    await harness.start({ token: TOKEN, allowedOrigins: ["http://localhost:5173"] });
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    await harness.pg.cleanTables();
  });

  const authed = { Authorization: `Bearer ${TOKEN}` };

  it("accepts a valid token from the loopback name the server is reached by", async () => {
    const res = await rawRequest(harness.baseUrl, "POST", "/sessions", jsonHeaders(authed), JSON_BODY);
    expect(res.status).toBe(201);
  });

  it("refuses a foreign Host even with a valid token (DNS rebinding)", async () => {
    const port = new URL(harness.baseUrl).port;
    const res = await rawRequest(
      harness.baseUrl,
      "POST",
      "/sessions",
      jsonHeaders({ ...authed, Host: `attacker.example:${port}` }),
      JSON_BODY,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden_host" });
  });

  it("refuses a foreign Origin even with a valid token", async () => {
    const res = await rawRequest(
      harness.baseUrl,
      "POST",
      "/sessions",
      jsonHeaders({ ...authed, Origin: "https://attacker.example" }),
      JSON_BODY,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden_origin" });
  });

  it("accepts an allowlisted browser origin with a valid token", async () => {
    const res = await rawRequest(
      harness.baseUrl,
      "POST",
      "/sessions",
      jsonHeaders({ ...authed, Origin: "http://localhost:5173" }),
      JSON_BODY,
    );
    expect(res.status).toBe(201);
  });

  it("refuses a text/plain body, the form a cross-site request uses, with a valid token", async () => {
    const res = await rawRequest(
      harness.baseUrl,
      "POST",
      "/sessions",
      { ...authed, "content-type": "text/plain", "content-length": String(Buffer.byteLength(JSON_BODY)) },
      JSON_BODY,
    );
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ error: "unsupported_media_type" });
  });

  it("refuses a cross-site request without a token, reporting the origin rather than a 401", async () => {
    const res = await rawRequest(
      harness.baseUrl,
      "POST",
      "/sessions",
      jsonHeaders({ Origin: "https://attacker.example", "content-type": "text/plain" }),
      JSON_BODY,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden_origin" });
  });

  it("still requires the token for a same-host JSON request without one", async () => {
    const res = await rawRequest(harness.baseUrl, "POST", "/sessions", jsonHeaders(), JSON_BODY);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  it("answers the OpenAI-compatible routes with an OpenAI-shaped error on a guard refusal", async () => {
    const res = await rawRequest(
      harness.baseUrl,
      "POST",
      "/v1/chat/completions",
      jsonHeaders({ ...authed, Origin: "https://attacker.example" }),
      JSON_BODY,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "forbidden_origin" } });
  });
});
