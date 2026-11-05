// Wraps a contractful-ts client as an MCP server. Only the tools listed here are
// reachable by the model; the contract set is not auto-exposed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auth, contract, defineApi, errorKind, HttpStatusError, P } from "contractful-ts";

const MAX_RESULT_CHARS = 8_000;

// The client is built per base URL and token so the MCP server reads both from its
// environment. A broker URL is fixed at definition time and is never taken from tool input.
export function defineBroker(base, token) {
  const BrokerApi = defineApi({
    name: "BrokerApi",
    base,
    retry: { retries: 2, baseDelay: 10, maxDelay: 50 },
    ...(token ? { auth: auth.bearer(() => token) } : {}),
    contracts: {
      quote: contract("GET /v1/quotes/:securityId", {
        params: {
          securityId: P.string({ required: true, pattern: /^[0-9]{1,12}$/ }),
          exchangeSegment: P.string({ required: true, inclusion: ["NSE_EQ", "NSE_FNO"] }),
        },
        responds: [{ status: 200, type: "hash" }, { status: 404 }],
      }),
      // Write path. Retry is disabled outright: a timeout or 5xx after a POST is ambiguous,
      // and a 429 would otherwise be retried for every method.
      placeOrder: contract("POST /v1/orders", {
        retry: "never",
        params: {
          securityId: P.string({ required: true, pattern: /^[0-9]{1,12}$/ }),
          quantity: P.integer({ required: true, min: 1, max: 1000 }),
        },
        responds: [{ status: 201, type: "hash" }, { status: 422 }],
      }),
    },
  });
  return new BrokerApi();
}

const text = (value) => ({ content: [{ type: "text", text: value }] });

// Never return the response body or the request headers to the model: error bodies
// can carry account data, and headers carry credentials. Status and kind only.
function failure(err) {
  const detail = err instanceof HttpStatusError ? `HTTP ${err.status}` : errorKind(err);
  return { isError: true, content: [{ type: "text", text: `request failed: ${detail}` }] };
}

// Exported so the field-pick can be tested with raw, unvalidated input. The MCP SDK's
// zod schema strips unknown keys before the handler runs, so the stdio path alone
// cannot show that this function is safe on its own.
export function makeGetQuoteHandler(broker) {
  return async (input) => {
    // Build the contract arguments field by field. Never spread `input`: the contract
    // accepts per-call meta keys (`_baseUrl`, `_skipAuth`, `_headers`, `_query`, ...)
    // that the model must not control.
    const args = { securityId: input.securityId, exchangeSegment: input.exchangeSegment };
    try {
      const body = await broker.quote(args);
      return text(JSON.stringify(body).slice(0, MAX_RESULT_CHARS));
    } catch (err) {
      return failure(err);
    }
  };
}

export function buildMcpServer(broker) {
  const server = new McpServer({ name: "broker-contracts", version: "0.1.0" });

  server.registerTool(
    "get_quote",
    {
      description: "Read the latest quote for one security. Read-only; no side effects.",
      inputSchema: {
        securityId: z.string().regex(/^[0-9]{1,12}$/),
        exchangeSegment: z.enum(["NSE_EQ", "NSE_FNO"]),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    makeGetQuoteHandler(broker),
  );

  // placeOrder is deliberately not registered. It is defined on the client so the retry
  // policy can be tested, and it is exposed only after an explicit trust review.
  return server;
}
