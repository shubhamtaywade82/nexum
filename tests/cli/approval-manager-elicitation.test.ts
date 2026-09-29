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
    await expect(manager.requestMcpElicitation({
      id: "e1",
      serverId: "server",
      mode: "form",
      message: "Pick one",
      requestedSchema: { type: "object", properties: { x: { type: "string" } } },
    })).resolves.toMatchObject({ id: "e1", action: "decline" });
  });

  it("round-trips through the resolver", async () => {
    let captured = "";
    const manager = new ApprovalManager({
      autoApprove: false,
      hasApprovalListener: () => false,
      hasClarificationListener: () => false,
      hasMcpElicitationListener: () => true,
      onMcpElicitationRequested: (request) => { captured = request.id; },
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
