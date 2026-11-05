import { ServerHarness } from "../support/server-harness.js";

// A browser page on an allowlisted origin must be able to call the host: its preflight is answered
// before auth (a preflight carries no credentials), and the actual response names the origin so the
// browser lets the page read it. A foreign origin gets nothing.
describe("browser origins from NEXUM_ALLOWED_ORIGINS", () => {
  const harness = new ServerHarness();
  const TOKEN = "cors_test_token_12345";
  const ORIGIN = "http://localhost:5173";

  beforeAll(async () => {
    await harness.start({ token: TOKEN, allowedOrigins: [ORIGIN] });
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    await harness.pg.cleanTables();
  });

  it("answers the preflight for an allowlisted origin without a token", async () => {
    const res = await fetch(`${harness.baseUrl}/sessions`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("refuses the preflight from a foreign origin, with no CORS grant", async () => {
    const res = await fetch(`${harness.baseUrl}/sessions`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("names the allowlisted origin on the actual response, so the browser lets the page read it", async () => {
    const res = await fetch(`${harness.baseUrl}/sessions`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("still requires the token on the actual request after a successful preflight", async () => {
    const res = await fetch(`${harness.baseUrl}/sessions`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("adds no CORS header to a request that carries no Origin", async () => {
    const res = await fetch(`${harness.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
