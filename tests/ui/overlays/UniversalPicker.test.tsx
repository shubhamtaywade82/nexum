import React from "react";
import { render } from "../wide-render.js";
import { UniversalPicker } from "../../../src/ui/overlays/UniversalPicker.js";

const ITEMS = [
  { id: "a", label: "a", detail: "Free" },
  { id: "b", label: "deepseek-v4-flash", detail: "🔒 Subscription" },
];

describe("UniversalPicker", () => {
  it("ignores SGR mouse-reporting escape sequences instead of typing them into the query", () => {
    const { stdin, lastFrame, unmount } = render(
      <UniversalPicker title="Switch Model" items={ITEMS} width={80} rows={20} active={true} onSubmit={() => {}} />,
    );
    stdin.write("\x1b[<0;158;28M\x1b[<0;158;28m");
    const frame = lastFrame()!;
    expect(frame).not.toContain("[0");
    expect(frame).not.toContain("158");
    unmount();
  });

  it("still accepts real typed characters as a filter query", () => {
    const { stdin, lastFrame, unmount } = render(
      <UniversalPicker title="Switch Model" items={ITEMS} width={80} rows={20} active={true} onSubmit={() => {}} />,
    );
    stdin.write("deep");
    expect(lastFrame()!).toContain("deep");
    unmount();
  });

  it("aligns detail columns regardless of label length", () => {
    const { lastFrame, unmount } = render(
      <UniversalPicker title="Switch Model" items={ITEMS} width={80} rows={20} active={true} onSubmit={() => {}} />,
    );
    const lines = lastFrame()!.split("\n");
    const shortRow = lines.find((l) => l.includes("Free"))!;
    const longRow = lines.find((l) => l.includes("Subscription"))!;
    expect(shortRow.indexOf("Free")).toBe(longRow.indexOf("🔒"));
    unmount();
  });
});
