import { describe, expect, it } from "@jest/globals";
import {
  normalizeMcpElicitationResponse,
  validateMcpElicitationForm,
  validateMcpElicitationRequest,
} from "../../src/core/user-input.js";

describe("MCP elicitation contracts", () => {
  it("accepts a valid form request", () => {
    expect(
      validateMcpElicitationRequest({
        id: "e1",
        serverId: "server",
        mode: "form",
        message: "Choose a branch",
        requestedSchema: {
          type: "object",
          properties: { branch: { type: "string", minLength: 1 } },
          required: ["branch"],
        },
      }),
    ).toEqual([]);
  });

  it("rejects non-http URL elicitation", () => {
    expect(
      validateMcpElicitationRequest({
        id: "e2",
        serverId: "server",
        mode: "url",
        message: "Authenticate",
        url: "file:///tmp/secret",
      }),
    ).toEqual([expect.stringContaining("only permits http/https")]);
  });

  it("validates required fields, types and choices", () => {
    const schema = {
      type: "object" as const,
      properties: {
        mode: { type: "string" as const, enum: ["a", "b"] },
        count: { type: "integer" as const, minimum: 1 },
      },
      required: ["mode", "count"],
    };
    expect(validateMcpElicitationForm(schema, { mode: "b", count: 2 })).toEqual([]);
    expect(validateMcpElicitationForm(schema, { mode: "x", count: 2 })).toEqual(
      expect.arrayContaining(['"mode" must be one of: a, b']),
    );
    expect(validateMcpElicitationForm(schema, { mode: "a", count: 0 })).toEqual(
      expect.arrayContaining(['"count" must be >= 1']),
    );
  });

  it("strips content from non-accept actions", () => {
    expect(
      normalizeMcpElicitationResponse({
        id: "e1",
        action: "decline",
        content: { ignored: "secret" },
      }),
    ).toEqual({ action: "decline" });
  });
});
