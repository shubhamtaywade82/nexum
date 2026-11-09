import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool, TOOLS } from "../src/tools.js";
import { FuturesPublicClient } from "../src/client.js";

class MockFuturesClient extends FuturesPublicClient {
  public lastPath = "";
  public lastParams: Record<string, unknown> = {};
  public mockResponse: unknown = {};

  override async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    this.lastPath = path;
    this.lastParams = params;
    return this.mockResponse as T;
  }
}

describe("binance-public-mcp tools", () => {
  it("defines exactly 8 tools with valid schemas", () => {
    assert.equal(TOOLS.length, 8);
    const names = TOOLS.map((t) => t.name);
    assert.deepEqual(names, [
      "get_ticker",
      "get_klines",
      "get_orderbook",
      "get_funding_rate",
      "get_premium_index",
      "get_open_interest",
      "get_exchange_info",
      "get_recent_trades",
    ]);
  });

  it("handles get_ticker correctly", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = { symbol: "BTCUSDT", lastPrice: "74000.00" };

    const res = (await executeTool(mock, "get_ticker", { symbol: "BTCUSDT" })) as { lastPrice: string };
    assert.equal(mock.lastPath, "/fapi/v1/ticker/24hr");
    assert.equal(mock.lastParams.symbol, "BTCUSDT");
    assert.equal(res.lastPrice, "74000.00");
  });

  it("handles get_klines and normalizes candle objects", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = [[1700000000000, "100.0", "105.0", "99.0", "104.0", "500.0", 1700003599999, "51000.0", 1234]];

    const res = (await executeTool(mock, "get_klines", { symbol: "SOLUSDT", interval: "1h" })) as {
      symbol: string;
      interval: string;
      candles: Array<{ open: string; close: string; trades: number }>;
    };

    assert.equal(mock.lastPath, "/fapi/v1/klines");
    assert.equal(res.symbol, "SOLUSDT");
    assert.equal(res.candles.length, 1);
    assert.equal(res.candles[0].open, "100.0");
    assert.equal(res.candles[0].close, "104.0");
    assert.equal(res.candles[0].trades, 1234);
  });

  it("handles get_orderbook and computes depth imbalance", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = {
      lastUpdateId: 99999,
      bids: [["100.0", "2.0"]],
      asks: [["101.0", "1.0"]],
    };

    const res = (await executeTool(mock, "get_orderbook", { symbol: "BTCUSDT" })) as {
      bidDepth: number;
      askDepth: number;
      imbalance: number;
    };

    assert.equal(mock.lastPath, "/fapi/v1/depth");
    assert.equal(res.bidDepth, 2.0);
    assert.equal(res.askDepth, 1.0);
    // (2 - 1) / (2 + 1) = 0.3333
    assert.equal(res.imbalance, 0.3333);
  });

  it("handles get_funding_rate", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = [{ symbol: "BTCUSDT", fundingTime: 1700000000000, fundingRate: "0.0001" }];

    const res = (await executeTool(mock, "get_funding_rate", { symbol: "BTCUSDT" })) as {
      fundingRates: Array<{ fundingRate: string }>;
    };
    assert.equal(mock.lastPath, "/fapi/v1/fundingRate");
    assert.equal(res.fundingRates[0].fundingRate, "0.0001");
  });

  it("handles get_premium_index", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = { symbol: "BTCUSDT", markPrice: "74100.00", lastFundingRate: "0.0001" };

    const res = (await executeTool(mock, "get_premium_index", { symbol: "BTCUSDT" })) as { markPrice: string };
    assert.equal(mock.lastPath, "/fapi/v1/premiumIndex");
    assert.equal(res.markPrice, "74100.00");
  });

  it("handles get_open_interest", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = { symbol: "BTCUSDT", openInterest: "95000.5" };

    const res = (await executeTool(mock, "get_open_interest", { symbol: "BTCUSDT" })) as { openInterest: string };
    assert.equal(mock.lastPath, "/fapi/v1/openInterest");
    assert.equal(res.openInterest, "95000.5");
  });

  it("handles get_exchange_info with symbol filter", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = {
      timezone: "UTC",
      serverTime: 1700000000000,
      rateLimits: [],
      symbols: [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }],
    };

    const res = (await executeTool(mock, "get_exchange_info", { symbol: "BTCUSDT" })) as {
      symbols: Array<{ symbol: string }>;
    };
    assert.equal(mock.lastPath, "/fapi/v1/exchangeInfo");
    assert.equal(res.symbols.length, 1);
    assert.equal(res.symbols[0].symbol, "BTCUSDT");
  });

  it("handles get_recent_trades and stringifies trade IDs", async () => {
    const mock = new MockFuturesClient();
    mock.mockResponse = [
      {
        id: 12345678901234,
        price: "74000.00",
        qty: "0.5",
        quoteQty: "37000.00",
        time: 1700000000000,
        isBuyerMaker: true,
      },
    ];

    const res = (await executeTool(mock, "get_recent_trades", { symbol: "BTCUSDT" })) as {
      trades: Array<{ id: string; price: string }>;
    };
    assert.equal(mock.lastPath, "/fapi/v1/trades");
    assert.equal(typeof res.trades[0].id, "string");
    assert.equal(res.trades[0].id, "12345678901234");
  });

  it("rejects calls with missing symbol", async () => {
    const mock = new MockFuturesClient();
    await assert.rejects(async () => executeTool(mock, "get_ticker", {}), /symbol parameter is required/);
  });

  it("rejects unknown tool names", async () => {
    const mock = new MockFuturesClient();
    await assert.rejects(async () => executeTool(mock, "non_existent_tool", {}), /Unknown tool: non_existent_tool/);
  });
});
