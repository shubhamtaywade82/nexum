import React from "react";
import { Text } from "@nemesis-oss/termina-core";
import { render } from "./wide-render.js";
import { ErrorBoundary } from "../../src/ui/ErrorBoundary.js";

function Bomb(): React.JSX.Element {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("renders a fallback instead of crashing when a child throws during render", () => {
    // Suppress React's console.error noise for the expected render error.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    const { lastFrame, unmount } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Nexum TUI crashed");
    expect(frame).toContain("kaboom");

    unmount();
    spy.mockRestore();
  });

  it("renders children normally when nothing throws", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary>
        <Text>all good</Text>
      </ErrorBoundary>,
    );

    expect(lastFrame()).toContain("all good");
    unmount();
  });
});
