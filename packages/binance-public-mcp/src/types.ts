export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface KlineBar {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
}

export interface OrderBookSummary {
  symbol: string;
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  bidDepth: number;
  askDepth: number;
  imbalance: number;
}

export interface FundingRateRecord {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

export interface PremiumIndexRecord {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  interestRate: string;
  nextFundingTime: number;
  time: number;
}

export interface OpenInterestRecord {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface RecentTradeRecord {
  id: string;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  isBuyerMaker: boolean;
}
