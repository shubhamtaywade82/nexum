// Run: node --test test.mjs
// Covers the contract layer directly, then the MCP server over real stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ContractViolationError, HttpStatusError } from "contractful-ts";
import { startMockBroker } from "./mock-broker.mjs";
import { defineBroker, makeGetQuoteHandler } from "./wrapper.mjs";

const TOKEN = "spike-token-do-not-leak";

// ---------- contract layer ----------

test("GET retries a transient 503 and succeeds; the bearer token is sent on every attempt", async () => {
  const broker = await startMockBroker((_hit, n) => (n === 1 ? { status: 503 } : { json: { ltp: 101.5 } }));
  try {
    const api = defineBroker(broker.url, TOKEN);
    const body = await api.quote({ securityId: "2885", exchangeSegment: "NSE_EQ" });
    assert.equal(body.ltp, 101.5);
    assert.equal(broker.hits.length, 2);
    for (const hit of broker.hits) assert.equal(hit.headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    await broker.close();
  }
});

test("POST with retry: never is attempted exactly once on an ambiguous 503", async () => {
  const broker = await startMockBroker(() => ({ status: 503 }));
  try {
    const api = defineBroker(broker.url, TOKEN);
    await assert.rejects(api.placeOrder({ securityId: "2885", quantity: 1 }));
    assert.equal(broker.hits.length, 1);
  } finally {
    await broker.close();
  }
});

test("POST with retry: never is not retried even on 429", async () => {
  const broker = await startMockBroker(() => ({ status: 429, headers: { "retry-after": "0" } }));
  try {
    const api = defineBroker(broker.url, TOKEN);
    await assert.rejects(api.placeOrder({ securityId: "2885", quantity: 1 }), HttpStatusError);
    assert.equal(broker.hits.length, 1);
  } finally {
    await broker.close();
  }
});

test("an undeclared argument is rejected before any HTTP traffic", async () => {
  const broker = await startMockBroker();
  try {
    const api = defineBroker(broker.url, TOKEN);
    await assert.rejects(api.quote({ securityId: "not-a-number", exchangeSegment: "NSE_EQ" }), ContractViolationError);
    assert.equal(broker.hits.length, 0);
  } finally {
    await broker.close();
  }
});

test("the handler ignores meta keys even when they bypass the MCP schema", async () => {
  const broker = await startMockBroker();
  const attacker = await startMockBroker();
  try {
    const handler = makeGetQuoteHandler(defineBroker(broker.url, TOKEN));
    // Raw input, as a schema-less caller could pass it.
    const result = await handler({
      securityId: "2885",
      exchangeSegment: "NSE_EQ",
      _baseUrl: attacker.url,
      _skipAuth: true,
      _headers: { "x-exfil": "yes" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(attacker.hits.length, 0, "request must not reach the attacker-supplied base");
    assert.equal(broker.hits.length, 1);
    assert.equal(broker.hits[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(broker.hits[0].headers["x-exfil"], undefined);
  } finally {
    await broker.close();
    await attacker.close();
  }
});

// ---------- MCP layer over stdio ----------

async function withServer(fn) {
  const broker = await startMockBroker((hit) => {
    if (hit.url.startsWith("/v1/quotes/9999")) {
      return { status: 404, json: { account: "SECRET-ACCT-7781" } };
    }
    return { json: { ltp: 101.5, path: hit.url } };
  });
  const attacker = await startMockBroker();
  const client = new Client({ name: "spike-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    env: { PATH: process.env.PATH, BROKER_BASE_URL: broker.url, BROKER_TOKEN: TOKEN },
  });
  try {
    await client.connect(transport);
    await fn({ client, broker, attacker });
  } finally {
    await client.close();
    await broker.close();
    await attacker.close();
  }
}

const resultText = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("tools/list exposes only get_quote, marked read-only", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["get_quote"],
    );
    assert.equal(tools[0].annotations.readOnlyHint, true);
  });
});

test("get_quote calls the broker with the declared arguments and never returns the token", async () => {
  await withServer(async ({ client, broker }) => {
    const result = await client.callTool({
      name: "get_quote",
      arguments: { securityId: "2885", exchangeSegment: "NSE_EQ" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(broker.hits.length, 1);
    assert.equal(broker.hits[0].url, "/v1/quotes/2885?exchangeSegment=NSE_EQ");
    assert.equal(broker.hits[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!resultText(result).includes(TOKEN));
  });
});

test("model-supplied meta keys cannot redirect the request or skip auth", async () => {
  await withServer(async ({ client, broker, attacker }) => {
    const result = await client.callTool({
      name: "get_quote",
      arguments: {
        securityId: "2885",
        exchangeSegment: "NSE_EQ",
        _baseUrl: attacker.url,
        _skipAuth: true,
        _headers: { "x-exfil": "yes" },
      },
    });
    assert.notEqual(result.isError, true);
    assert.equal(attacker.hits.length, 0, "request must not reach the attacker-supplied base");
    assert.equal(broker.hits.length, 1);
    assert.equal(broker.hits[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(broker.hits[0].headers["x-exfil"], undefined);
  });
});

test("an invalid argument is refused by the MCP layer and never reaches the broker", async () => {
  await withServer(async ({ client, broker }) => {
    let refused = false;
    try {
      const result = await client.callTool({
        name: "get_quote",
        arguments: { securityId: "abc", exchangeSegment: "NSE_EQ" },
      });
      refused = result.isError === true;
    } catch {
      refused = true;
    }
    assert.equal(refused, true);
    assert.equal(broker.hits.length, 0);
  });
});

test("a broker error returns status only, never the response body", async () => {
  await withServer(async ({ client }) => {
    const result = await client.callTool({
      name: "get_quote",
      arguments: { securityId: "9999", exchangeSegment: "NSE_EQ" },
    });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /request failed: HTTP 404/);
    assert.ok(!resultText(result).includes("SECRET-ACCT-7781"));
  });
});
