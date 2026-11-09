# binance-public-mcp

Credential-free Model Context Protocol (MCP) server for Binance USDⓈ-M Futures public market data.

Provides real-time tickers, order book depth, OHLCV klines, funding rates, open interest, exchange rules, and trade history without API keys, OAuth, or account registration.

## Tools Included

| Tool                | Parameters                                                  | Description                                                   |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| `get_ticker`        | `symbol` (required)                                         | 24-hour rolling window price change statistics.               |
| `get_klines`        | `symbol` (req), `interval`, `limit`, `startTime`, `endTime` | Structured candlestick OHLCV bars.                            |
| `get_orderbook`     | `symbol` (req), `limit` (default: 50)                       | Order book depth and calculated bid/ask imbalance.            |
| `get_funding_rate`  | `symbol` (req), `limit`, `startTime`, `endTime`             | Historical 8-hour funding rates.                              |
| `get_premium_index` | `symbol` (req)                                              | Mark price, index price, next funding time, and current rate. |
| `get_open_interest` | `symbol` (req)                                              | Live open interest in contracts.                              |
| `get_exchange_info` | `symbol` (optional)                                         | Trading rules, precision filters, and rate limits.            |
| `get_recent_trades` | `symbol` (req), `limit` (default: 50)                       | Recent market trades with stringified safe IDs.               |

## Quick Start

### 1. Build

```bash
npm install
npm run build
```

### 2. Run Tests

```bash
npm test
```

### 3. Usage over STDIO (Default)

```bash
node dist/index.js
```

### 4. Usage over HTTP

```bash
node dist/index.js --http 3000
```

## Nexum Integration

Add to `.nexum/config.json`:

```json
{
  "mcpServers": {
    "binance-public": {
      "command": "node",
      "args": ["packages/binance-public-mcp/dist/index.js"]
    }
  }
}
```

## Claude Code Integration

```bash
claude mcp add binance-public -- node /path/to/packages/binance-public-mcp/dist/index.js
```
