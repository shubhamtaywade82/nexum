import React from "react";
import { describe, expect, it } from "@jest/globals";
import { render } from "ink-testing-library";
import { McpElicitationOverlay } from "../../../src/ui/overlays/McpElicitationOverlay.js";

describe("McpElicitationOverlay", () => {
  it("accepts a required string field", async () => {
    let response: unknown;
    const ui = render(
      <McpElicitationOverlay
        request={{
          id: "e1",
          serverId: "server",
          mode: "form",
          message: "Choose a name",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        }}
        width={100}
        rows={20}
        onSubmit={(value) => { response = value; }}
        onCancel={() => {}}
      />,
    );
    ui.stdin.write("alice");
    ui.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(response).toMatchObject({ id: "e1", action: "accept", content: { name: "alice" } });
    ui.unmount();
  });

  it("cancels a URL request with Escape", async () => {
    let cancelled = false;
    const ui = render(
      <McpElicitationOverlay
        request={{
          id: "e2",
          serverId: "server",
          mode: "url",
          message: "Authenticate",
          url: "https://example.com/auth",
        }}
        width={100}
        rows={20}
        onSubmit={() => {}}
        onCancel={() => { cancelled = true; }}
      />,
    );
    ui.stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
    ui.unmount();
  });
});
