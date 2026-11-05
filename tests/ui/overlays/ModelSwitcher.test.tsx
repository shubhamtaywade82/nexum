import React from "react";
import { render } from "../wide-render.js";
import { ModelSwitcher } from "../../../src/ui/overlays/ModelSwitcher.js";

describe("ModelSwitcher", () => {
  it("tags a known subscription-gated model before selection", () => {
    const { lastFrame, unmount } = render(
      <ModelSwitcher
        current="qwen3:30b"
        models={["qwen3:30b", "minimax-m2.7"]}
        availability={{ "minimax-m2.7": false }}
        width={80}
        rows={20}
        active={true}
        onSelect={() => {}}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("minimax-m2.7");
    expect(frame).toContain("🔒 Subscription");
    unmount();
  });

  // Only claims the data supports. A 200 from the availability probe means
  // "reachable with this key", not "free" — a subscriber is billed for those
  // too. And the checker only ever tracks cloud ids, so labelling every local
  // model "Untested" was permanent noise rather than information.
  it("says nothing about availability for a model that is merely reachable", () => {
    const { lastFrame, unmount } = render(
      <ModelSwitcher
        current="qwen3:30b"
        models={["qwen3:30b", "qwen3:8b"]}
        availability={{ "qwen3:8b": true }}
        width={80}
        rows={20}
        active={true}
        onSelect={() => {}}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).not.toContain("Subscription");
    expect(frame).not.toContain("Free");
    expect(frame).not.toContain("Untested");
    expect(frame).toContain("current");
    unmount();
  });

  it("shows capability tags", () => {
    const { lastFrame, unmount } = render(
      <ModelSwitcher
        current="qwen3:30b"
        models={["qwen3:30b", "qwen2.5-coder:32b"]}
        availability={{ "qwen2.5-coder:32b": true }}
        capabilities={{ "qwen2.5-coder:32b": ["coding", "tools"] }}
        width={80}
        rows={20}
        active={true}
        onSelect={() => {}}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("code/tools");
    unmount();
  });

  it("combines a subscription tag with capability tags", () => {
    const { lastFrame, unmount } = render(
      <ModelSwitcher
        current="qwen3:30b"
        models={["qwen3:30b", "minimax-m2.7"]}
        availability={{ "minimax-m2.7": false }}
        capabilities={{ "minimax-m2.7": ["reasoning"] }}
        width={80}
        rows={20}
        active={true}
        onSelect={() => {}}
      />,
    );
    expect(lastFrame()!).toContain("🔒 Subscription · reason");
    unmount();
  });
});
