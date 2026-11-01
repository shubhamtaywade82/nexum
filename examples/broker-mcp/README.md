# broker-mcp-example

A spike: a read-only MCP server that wraps a broker REST API with [contractful-ts](https://www.npmjs.com/package/contractful-ts). It is an example, not part of the nexum package. The root `package.json` `files` list excludes `examples/`.

## Run

```bash
cd examples/broker-mcp
npm install
npm test
```

## Files

- `server.mjs`: stdio entry point. Reads `BROKER_BASE_URL` (required) and `BROKER_TOKEN` (optional bearer token) from the environment.
- `wrapper.mjs`: `defineBroker` (the contractful-ts client), `makeGetQuoteHandler` (builds contract arguments field by field), and `buildMcpServer` (registers `get_quote` only).
- `mock-broker.mjs`: a local HTTP stand-in used by the tests. It records every request.
- `test.mjs`: 10 tests covering retry and closed-schema behaviour, meta-key handling, `tools/list` and `tools/call` over stdio, and error redaction.

## Limits

- The endpoints (`GET /v1/quotes/:securityId`, `POST /v1/orders`) are placeholders, not any real broker's API.
- `placeOrder` is defined on the client but not registered. Exposing it needs a separate trust review and a broker idempotency strategy.
- nexum's `ask` approval is pinned to a hash of command and args, not file contents. Pin the server before live use.
- Not wired to nexum's CI or configuration. Register it through `mcpServers` only after reviewing the trust settings in `docs/guide/mcp.md`.
