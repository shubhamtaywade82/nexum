import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleRpcMessage } from "../src/server.js";
import { FuturesPublicClient } from "../src/client.js";

class MockFuturesClient extends FuturesPublicClient {
  public mockResponse: unknown = { symbol: "BTCUSDT", lastPrice: "74000.00" };

  override async get<T>(): Promise<T> {
    return this.mockResponse as T;
  }
}

describe("binance-public-mcp server JSON-RPC handler", () => {
  it("responds to initialize with protocolVersion and serverInfo", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });

    assert.ok(res);
    assert.equal(res.id, 1);
    const result = res.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    assert.equal(result.serverInfo.name, "binance-public-mcp");
    assert.equal(result.protocolVersion, "2024-11-05");
  });

  it("responds to ping with empty result", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    });

    assert.ok(res);
    assert.equal(res.id, 2);
    assert.deepEqual(res.result, {});
  });

  it("responds to tools/list with all 8 tools", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });

    assert.ok(res);
    const result = res.result as { tools: Array<{ name: string }> };
    assert.equal(result.tools.length, 8);
  });

  it("executes tools/call and wraps in MCP text content", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_ticker",
        arguments: { symbol: "BTCUSDT" },
      },
    });

    assert.ok(res);
    assert.equal(res.id, 4);
    const result = res.result as { content: Array<{ type: string; text: string }> };
    assert.equal(result.content[0].type, "text");
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.symbol, "BTCUSDT");
  });

  it("returns formatted error content on tool failure", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_ticker",
        arguments: {}, // Missing symbol
      },
    });

    assert.ok(res);
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /symbol parameter is required/);
  });

  it("returns -32601 for unknown methods", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      id: 6,
      method: "unknown_method",
    });

    assert.ok(res);
    assert.equal(res.error?.code, -32601);
  });

  it("ignores notifications with null response", async () => {
    const mock = new MockFuturesClient();
    const res = await handleRpcMessage(mock, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    assert.equal(res, null);
  });
});
