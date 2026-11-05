import { describe, expect, it } from "@jest/globals";
import { ApprovalManager } from "../../src/cli/services/approval-manager.js";

describe("ApprovalManager MCP elicitation", () => {
  it("fails closed without a listener", async () => {
    const manager = new ApprovalManager({
      autoApprove: false,
      hasApprovalListener: () => false,
      hasClarificationListener: () => false,
      hasMcpElicitationListener: () => false,
    });
    await expect(
      manager.requestMcpElicitation({
        id: "e1",
        serverId: "server",
        mode: "form",
        message: "Pick one",
        requestedSchema: { type: "object", properties: { x: { type: "string" } } },
      }),
    ).resolves.toMatchObject({ id: "e1", action: "decline" });
  });

  it("serializes concurrent requests and resolves the next after the first", async () => {
    const seen: string[] = [];
    const manager = new ApprovalManager({
      autoApprove: false,
      hasApprovalListener: () => false,
      hasClarificationListener: () => false,
      hasMcpElicitationListener: () => true,
      onMcpElicitationRequested: (request) => {
        seen.push(request.id);
      },
      mcpElicitationTimeoutMs: 1000,
    });

    const first = manager.requestMcpElicitation({
      id: "e1",
      serverId: "server",
      mode: "form",
      message: "one",
      requestedSchema: { type: "object", properties: { x: { type: "string" } } },
    });
    const second = manager.requestMcpElicitation({
      id: "e2",
      serverId: "server",
      mode: "form",
      message: "two",
      requestedSchema: { type: "object", properties: { y: { type: "string" } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["e1"]);
    manager.resolveMcpElicitation({ id: "e1", action: "decline" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["e1", "e2"]);
    manager.resolveMcpElicitation({ id: "e2", action: "cancel" });
    await expect(first).resolves.toMatchObject({ id: "e1", action: "decline" });
    await expect(second).resolves.toMatchObject({ id: "e2", action: "cancel" });
    expect(manager.pendingMcpElicitationCount()).toBe(0);
  });

  it("round-trips through the resolver", async () => {
    let captured = "";
    const manager = new ApprovalManager({
      autoApprove: false,
      hasApprovalListener: () => false,
      hasClarificationListener: () => false,
      hasMcpElicitationListener: () => true,
      onMcpElicitationRequested: (request) => {
        captured = request.id;
      },
    });

    const pending = manager.requestMcpElicitation({
      id: "e2",
      serverId: "server",
      mode: "url",
      message: "Authenticate",
      url: "https://example.com/auth",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured).toBe("e2");
    expect(manager.pendingMcpElicitationCount()).toBe(1);
    manager.resolveMcpElicitation({ id: "e2", action: "accept" });
    await expect(pending).resolves.toMatchObject({ id: "e2", action: "accept" });
    expect(manager.pendingMcpElicitationCount()).toBe(0);
  });
});
