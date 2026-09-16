/**
 * Tests for the `nexum rpc` CLI entry point (src/cli/rpc.ts).
 *
 * These tests verify the module's exported API surface without constructing
 * a full Agent (which loads LSP, MCP, browser, etc. — too heavy for a unit
 * test). The end-to-end JSON-RPC dispatch is covered by tests/rpc/rpc-methods.test.ts.
 */
import { describe, it, expect } from "@jest/globals";
import { startRpcServer, type RpcCliOptions } from "../../src/cli/rpc.js";

describe("src/cli/rpc.ts", () => {
  it("exports startRpcServer function", () => {
    expect(typeof startRpcServer).toBe("function");
  });

  it("RpcCliOptions type accepts workspaceRoot + rpcOptions", () => {
    const opts: RpcCliOptions = {
      workspaceRoot: "/tmp",
      config: { workspaceRoot: "/tmp" },
      rpcOptions: { autostart: false },
    };
    expect(opts).toBeDefined();
    expect(opts.workspaceRoot).toBe("/tmp");
  });
});

// Avoid the unused-import warning by ensuring startRpcServer is referenced
// in a no-op context. The actual integration test (constructing a full
// Agent + driving JSON-RPC) is too heavy for unit tests due to LSP/MCP/
// browser startup. Use tests/rpc/rpc-methods.test.ts for dispatch coverage.
void startRpcServer;
