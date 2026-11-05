import React from "react";
import { render } from "../wide-render.js";
import { CompletionSurface } from "../../../src/ui/input/CompletionSurface.js";
import { CompletionRow } from "../../../src/ui/input/CompletionRow.js";
import { CompletionItem } from "../../../src/interaction/completion.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const items: CompletionItem[] = [
  { label: "/clear", detail: "Clear the conversation view", insert: "/clear ", kind: "command", group: "General" },
  { label: "/commit", detail: "Stage and commit changes", insert: "/commit ", kind: "command", group: "Git" },
  { label: "/model", detail: "Switch model", insert: "/model ", kind: "command", group: "Model" },
  { label: "/mode", detail: "Change execution mode", insert: "/mode ", kind: "command", group: "Mode" },
  { label: "/memory", detail: "Inspect agent memory", insert: "/memory ", kind: "command", group: "Views" },
  { label: "/mcp", detail: "Manage MCP servers", insert: "/mcp ", kind: "command", group: "Views" },
  { label: "/plan", detail: "Decompose and execute a task", insert: "/plan ", kind: "command", group: "Agent" },
  { label: "/quit", detail: "Quit DevAgent", insert: "/quit ", kind: "command", group: "General" },
];

describe("CompletionRow", () => {
  it("shows › for selected row", () => {
    const { lastFrame, unmount } = render(<CompletionRow item={items[0]} selected={true} width={80} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("›");
    expect(frame).toContain("/clear");
    unmount();
  });

  it("shows space for unselected row", () => {
    const { lastFrame, unmount } = render(<CompletionRow item={items[0]} selected={false} width={80} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("›");
    expect(frame).toContain("/clear");
    unmount();
  });

  it("renders detail and group", () => {
    const { lastFrame, unmount } = render(<CompletionRow item={items[0]} selected={false} width={80} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Clear the conversation view");
    expect(frame).toContain("General");
    unmount();
  });
});

describe("CompletionSurface", () => {
  it("renders nothing when items is empty", () => {
    const { lastFrame, unmount } = render(<CompletionSurface items={[]} selectedIndex={0} width={80} />);
    expect(lastFrame()).toBe("");
    unmount();
  });

  it("renders all items when count is below maxVisible", () => {
    const few = items.slice(0, 3);
    const { lastFrame, unmount } = render(<CompletionSurface items={few} selectedIndex={0} width={80} />);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("/clear");
    expect(frame).toContain("/commit");
    expect(frame).toContain("/model");
    expect(frame).not.toMatch(/\d+ \/ \d+/); // no counter for 3 items
    unmount();
  });

  it("highlights the selected row with ›", () => {
    const few = items.slice(0, 3);
    const { lastFrame, unmount } = render(<CompletionSurface items={few} selectedIndex={1} width={80} />);
    const frame = stripAnsi(lastFrame() ?? "");
    // ›  should appear on the line with /commit
    const lines = frame.split("\n");
    const selectedLine = lines.find((l) => l.includes("›"));
    expect(selectedLine).toContain("/commit");
    unmount();
  });

  it("shows counter when items exceed maxVisible", () => {
    const { lastFrame, unmount } = render(
      <CompletionSurface items={items} selectedIndex={0} width={80} maxVisible={3} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // Should show "1 / 8" counter
    expect(frame).toContain("1 / 8");
    unmount();
  });

  it("scrolls window to keep selected item visible", () => {
    const { lastFrame, unmount } = render(
      <CompletionSurface items={items} selectedIndex={6} width={80} maxVisible={3} />,
    );
    const frame = stripAnsi(lastFrame() ?? "");
    // Selected item at index 6 is /plan
    expect(frame).toContain("/plan");
    // Counter shows 7/8
    expect(frame).toContain("7 / 8");
    unmount();
  });

  it("clamps selectedIndex to valid range", () => {
    const few = items.slice(0, 3);
    const { lastFrame, unmount } = render(<CompletionSurface items={few} selectedIndex={99} width={80} />);
    const frame = stripAnsi(lastFrame() ?? "");
    // Should still render without crashing, with last item selected
    const lines = frame.split("\n");
    const selectedLine = lines.find((l) => l.includes("›"));
    expect(selectedLine).toContain("/model");
    unmount();
  });
});
