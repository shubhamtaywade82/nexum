# MCP Elicitation

Nexum implements the MCP client-side `elicitation/create` capability.

## Protocol

When `connectMcpServerV2` receives an elicitation handler, Nexum advertises both `form` and `url` elicitation capabilities and registers the request handler before connecting.

The handler converts the protocol request into `McpElicitationRequest`, routes it through `ApprovalManager` in the application-level Agent, and converts the response back to the MCP result. Requests are represented as execution events so the TUI can render a blocking input surface without changing the underlying execution lifecycle.

The same handler is used by the current MCP TypeScript client for embedded `input_required` elicitation requests.

## Form mode

The TUI supports strings, numbers, integers, booleans, enums/oneOf, and string multi-select arrays. Client-side validation checks required fields, primitive types, ranges and offered choices. The MCP server remains authoritative for final schema validation.

Form mode is intended for non-sensitive input. Nexum explicitly warns users not to enter passwords, API keys, or other secrets in a form.

## URL mode

URL mode is intended for sensitive or credential-bearing flows. Nexum validates the URL and only permits `http` and `https`. The URL is opened only after an explicit user action; the elicitation response never carries form content.

## Decline and cancel

`decline` means the user refused the request. `cancel` means the user dismissed the interaction. In headless mode without an elicitation listener, Nexum automatically declines instead of deadlocking the agent.

## Compatibility

This feature is additive. Applications that do not pass an elicitation handler retain the old MCP client capability set. The low-level API is:

```ts
connectMcpServerV2(descriptor, {
  elicitation: {
    request: async (request) => ({ id: request.id, action: "decline" }),
  },
});
```

The application-level `Agent` wires its TUI/CLI handler to the same contract.


<!-- CI validation branch marker -->
