import type { FuturesPublicClient } from "./client.js";
import type {
  ToolDefinition,
  KlineBar,
  OrderBookSummary,
  FundingRateRecord,
  PremiumIndexRecord,
  OpenInterestRecord,
  RecentTradeRecord,
} from "./types.js";

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_ticker",
    description: "Get 24-hour rolling window price change statistics for USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTCUSDT, SOLUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_klines",
    description: "Get Kline/candlestick bars for a USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT" },
        interval: {
          type: "string",
          description: "Interval: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M (default 1h)",
        },
        limit: { type: "number", description: "Default 100, max 1000" },
        startTime: { type: "number", description: "UTC timestamp in ms" },
        endTime: { type: "number", description: "UTC timestamp in ms" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_orderbook",
    description: "Get order book depth and volume imbalance for USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT" },
        limit: { type: "number", description: "Depth limit: 5, 10, 20, 50, 100, 500, 1000 (default 50)" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_funding_rate",
    description: "Get historical funding rates for USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT" },
        limit: { type: "number", description: "Default 20, max 1000" },
        startTime: { type: "number", description: "UTC timestamp in ms" },
        endTime: { type: "number", description: "UTC timestamp in ms" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_premium_index",
    description: "Get mark price, index price, and current funding rate for USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTCUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_open_interest",
    description: "Get current open interest for USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTCUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_exchange_info",
    description: "Get current exchange trading rules, rate limits, and symbol filters.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional symbol filter, e.g. BTCUSDT" } },
    },
  },
  {
    name: "get_recent_trades",
    description: "Get recent market trades for USD-M futures symbol.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. BTCUSDT" },
        limit: { type: "number", description: "Default 50, max 1000" },
      },
      required: ["symbol"],
    },
  },
];

export async function executeTool(
  client: FuturesPublicClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_ticker":
      return handleGetTicker(client, args);
    case "get_klines":
      return handleGetKlines(client, args);
    case "get_orderbook":
      return handleGetOrderbook(client, args);
    case "get_funding_rate":
      return handleGetFundingRate(client, args);
    case "get_premium_index":
      return handleGetPremiumIndex(client, args);
    case "get_open_interest":
      return handleGetOpenInterest(client, args);
    case "get_exchange_info":
      return handleGetExchangeInfo(client, args);
    case "get_recent_trades":
      return handleGetRecentTrades(client, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleGetTicker(client: FuturesPublicClient, args: Record<string, unknown>): Promise<unknown> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  return client.get("/fapi/v1/ticker/24hr", { symbol });
}

async function handleGetKlines(
  client: FuturesPublicClient,
  args: Record<string, unknown>,
): Promise<{ symbol: string; interval: string; candles: KlineBar[] }> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  const interval = String(args.interval ?? "1h");
  const limit = Math.min(Math.max(Number(args.limit ?? 100) || 100, 1), 1000);

  const raw = await client.get<unknown[][]>("/fapi/v1/klines", {
    symbol,
    interval,
    limit,
    startTime: args.startTime as number | undefined,
    endTime: args.endTime as number | undefined,
  });

  const candles: KlineBar[] = raw.map((row) => ({
    openTime: Number(row[0]),
    open: String(row[1]),
    high: String(row[2]),
    low: String(row[3]),
    close: String(row[4]),
    volume: String(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: String(row[7]),
    trades: Number(row[8]),
  }));

  return { symbol, interval, candles };
}

async function handleGetOrderbook(
  client: FuturesPublicClient,
  args: Record<string, unknown>,
): Promise<OrderBookSummary> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 5), 1000);

  const res = await client.get<{
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
  }>("/fapi/v1/depth", { symbol, limit });

  const bidDepth = res.bids.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const askDepth = res.asks.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const totalDepth = bidDepth + askDepth;
  const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  return {
    symbol,
    lastUpdateId: res.lastUpdateId,
    bids: res.bids,
    asks: res.asks,
    bidDepth: Math.round(bidDepth * 1000) / 1000,
    askDepth: Math.round(askDepth * 1000) / 1000,
    imbalance: Math.round(imbalance * 10000) / 10000,
  };
}

async function handleGetFundingRate(
  client: FuturesPublicClient,
  args: Record<string, unknown>,
): Promise<{ symbol: string; fundingRates: FundingRateRecord[] }> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 1000);

  const raw = await client.get<FundingRateRecord[]>("/fapi/v1/fundingRate", {
    symbol,
    limit,
    startTime: args.startTime as number | undefined,
    endTime: args.endTime as number | undefined,
  });

  return { symbol, fundingRates: raw };
}

async function handleGetPremiumIndex(
  client: FuturesPublicClient,
  args: Record<string, unknown>,
): Promise<PremiumIndexRecord> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  return client.get<PremiumIndexRecord>("/fapi/v1/premiumIndex", { symbol });
}

async function handleGetOpenInterest(
  client: FuturesPublicClient,
  args: Record<string, unknown>,
): Promise<OpenInterestRecord> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  return client.get<OpenInterestRecord>("/fapi/v1/openInterest", { symbol });
}

async function handleGetExchangeInfo(client: FuturesPublicClient, args: Record<string, unknown>): Promise<unknown> {
  const symbol = args.symbol ? String(args.symbol).toUpperCase() : undefined;
  const info = await client.get<{
    timezone: string;
    serverTime: number;
    rateLimits: unknown[];
    symbols: Array<{ symbol: string; [key: string]: unknown }>;
  }>("/fapi/v1/exchangeInfo");

  if (!symbol) return info;
  return {
    ...info,
    symbols: info.symbols.filter((s) => s.symbol === symbol),
  };
}

async function handleGetRecentTrades(
  client: FuturesPublicClient,
  args: Record<string, unknown>,
): Promise<{ symbol: string; trades: RecentTradeRecord[] }> {
  const symbol = String(args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol parameter is required");
  const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 1000);

  const raw = await client.get<Array<{ id: number; [key: string]: unknown }>>("/fapi/v1/trades", { symbol, limit });

  // Stringify ID because exchange trade IDs exceed JS safe integer threshold over time.
  const trades: RecentTradeRecord[] = raw.map((t) => ({
    id: String(t.id),
    price: String(t.price),
    qty: String(t.qty),
    quoteQty: String(t.quoteQty),
    time: Number(t.time),
    isBuyerMaker: Boolean(t.isBuyerMaker),
  }));

  return { symbol, trades };
}
