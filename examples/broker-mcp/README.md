# broker-mcp-example

A read-only MCP server that wraps a broker REST API with [contractful-ts](https://www.npmjs.com/package/contractful-ts). It is an example, not part of the nexum package. The root `package.json` `files` list excludes `examples/`, and the root `lint`/`format:check` scripts do not cover it.

## Run

```bash
cd examples/broker-mcp
npm ci
npm test
```

## Files

- `server.mjs`: stdio entry point. Reads `BROKER_BASE_URL` (required) and `BROKER_TOKEN` (optional bearer token) from the environment.
- `wrapper.mjs`: `defineBroker` (the contractful-ts client), `makeGetQuoteHandler` (builds contract arguments field by field), and `buildMcpServer` (registers `get_quote` only).
- `mock-broker.mjs`: a local HTTP stand-in used by the tests. It records every request.
- `test.mjs`: 11 tests covering retry and closed-schema behaviour, meta-key handling, `tools/list` and `tools/call` over stdio, error redaction, and transport failure.
- `nexum-config.example.json`: the nexum `mcpServers` entry. Copy it into a config file; do not commit a real `.nexum/config.json` with your values.

## nexum configuration

```json
{
  "mcpServers": [
    {
      "name": "broker-quotes",
      "command": "node",
      "args": ["/absolute/path/to/nexum/examples/broker-mcp/server.mjs"],
      "trust": "ask",
      "tools": { "allow": ["get_quote"] },
      "maxRisk": "low",
      "env": {
        "BROKER_BASE_URL": "https://broker.example.invalid",
        "BROKER_TOKEN": "credential:BROKER_TOKEN"
      }
    }
  ]
}
```

- `trust: "ask"`: the server connects only after `nexum mcp trust approve broker-quotes`. Without an approval it is denied, not connected silently.
- `tools.allow`: an explicit allowlist. `placeOrder` is not registered by the server, and the allowlist keeps it out even if it were.
- `maxRisk: "low"`: the server's `get_quote` is annotated `readOnlyHint: true`, which nexum maps to risk `low`. The risk ladder is `read < low < medium < high < critical`, so `maxRisk: "read"` would deny `get_quote`.
- `env.BROKER_TOKEN`: `credential:BROKER_TOKEN` is resolved by nexum's credential service at connect time. The token is never a tool argument and never appears in tool output.

## Verify the trust decision

Build nexum once (`npm ci && npm run build` at the repo root). Use a scratch HOME so no real state is touched. The config goes to the global `~/.nexum/config.json`, which always applies; the example's `args` path is replaced with this checkout's root.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
export SCRATCH_HOME=$(mktemp -d)
mkdir -p "$SCRATCH_HOME/.nexum"
sed "s#/absolute/path/to/nexum#$REPO_ROOT#" examples/broker-mcp/nexum-config.example.json > "$SCRATCH_HOME/.nexum/config.json"
HOME="$SCRATCH_HOME" node "$REPO_ROOT/bin/cli.js" mcp trust policy     # expect: level ask, connect no
HOME="$SCRATCH_HOME" node "$REPO_ROOT/bin/cli.js" mcp trust approve broker-quotes
HOME="$SCRATCH_HOME" node "$REPO_ROOT/bin/cli.js" mcp trust policy     # expect: connect yes
```

`mcp trust policy` decides at server level from the fingerprint and rules. It does not connect to the server or list its tools, so per-tool filtering at connect time is not exercised by this command.

## Verification results

- `npm test`: 11/11 pass.
- `nexum mcp trust policy`, scratch HOME, built from this checkout: before approval `connect no` with reason "requires approval (trust: ask)"; after `mcp trust approve broker-quotes` `connect yes`.
- Per-tool risk: `get_quote` is inferred as `low` from `readOnlyHint`. `maxRisk: "low"` allows it; `maxRisk: "read"` denies it with "exceeds the server's maxRisk". A tool outside `tools.allow` is denied with "matches no allow pattern".
- Mutation check on a scratch copy:
  - Spreading tool input into the contract call (`{ ...input }`) fails test 5 (handler-level). The stdio test 8 still passes, because the MCP SDK's zod schema strips unknown keys before the handler runs. Only the handler-level test guards this.
  - Removing `retry: "never"` from `placeOrder` fails test 3 (429 attempted more than once).
  - Changing it to `retry: "always"` fails tests 2 and 3. Test 2 (503 on POST) does not catch removal, because POST with the default `auto` mode is not retried on 503 either. It guards against `always`.

## Limits

- The endpoints (`GET /v1/quotes/:securityId`, `POST /v1/orders`) are placeholders, not any real broker's API. Broker name, base URL, auth scheme and real endpoints are still needed.
- `placeOrder` is defined on the client but not registered. Exposing it needs a separate trust review and a broker idempotency strategy.
- nexum's `ask` approval fingerprint covers the command, the args and the cwd (when set). It does not cover `env` or the server's file contents. Editing `server.mjs` does not re-trigger approval. Re-run `nexum mcp trust approve` after any change to the server code, and review it before approving.
- `BROKER_BASE_URL` lives in `env`, so it is outside the approval fingerprint. In a workspace `.nexum/config.json`, any change to the file re-triggers workspace trust, which covers `mcpServers`. In the global `~/.nexum/config.json`, the user owns the file.
- Not verified end to end: the agent actually registering only `get_quote` after connecting, and the real `tools/list` filtering inside nexum.
