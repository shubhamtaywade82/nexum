import React from "react";
import { describe, expect, it } from "@jest/globals";
import { render } from "ink-testing-library";
import { ExecutionDagOverlay } from "../../../src/ui/overlays/ExecutionDagOverlay.js";
import { executionNodesFromState } from "../../../src/runtime/event-node.js";

describe("ExecutionDagOverlay", () => {
  it("shows an empty state instead of placeholder nodes", () => {
    const ui = render(<ExecutionDagOverlay nodes={[]} width={100} rows={20} active={false} onClose={() => {}} />);
    expect(ui.lastFrame()).toContain("No execution recorded yet");
    expect(ui.lastFrame()).not.toContain("Migrate Provider Layer");
  });

  it("renders nodes derived from runtime state", () => {
    const nodes = executionNodesFromState({
      mission: {
        goal: "fix auth",
        phases: [
          { id: "plan", status: "completed", startedAt: 1, endedAt: 2 },
          { id: "execute", status: "running", startedAt: 2 },
        ],
        steps: [{ id: "s1", description: "patch login", status: "completed" }],
      },
      toolCalls: [
        { id: "tc1", name: "read_file", args: { path: "a.ts" }, status: "completed", startedAt: 3, endedAt: 5 },
      ],
    });
    expect(nodes.map((n) => n.id)).toEqual(["mission", "phase:plan", "phase:execute", "step:s1", "tool:tc1"]);
    expect(nodes.find((n) => n.id === "tool:tc1")).toMatchObject({ parentId: "phase:execute", durationMs: 2 });
    const ui = render(<ExecutionDagOverlay nodes={nodes} width={120} rows={30} active={false} onClose={() => {}} />);
    expect(ui.lastFrame()).toContain("read_file");
    expect(ui.lastFrame()).toContain("fix auth");
  });
});
