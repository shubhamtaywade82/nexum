import React from "react";
import { render } from "../wide-render.js";
import { ClarificationOverlay } from "../../../src/ui/overlays/ClarificationOverlay.js";
import { ClarificationRequest } from "../../../src/runtime/types.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("ClarificationOverlay", () => {
  const sampleRequest: ClarificationRequest = {
    id: "clar-test-1",
    prompt: "explain oops",
    question: "Which aspect of OOP would you like to explore?",
    options: [
      { id: "opt_general", label: "General OOP concepts", detail: "Classes, objects, inheritance" },
      { id: "opt_ts", label: "OOP in TypeScript", detail: "TypeScript classes and interfaces" },
      { id: "custom", label: "Custom instructions...", isCustom: true },
    ],
    allowCustom: true,
  };

  it("renders the question, original prompt, and options", () => {
    const { lastFrame, unmount } = render(
      <ClarificationOverlay request={sampleRequest} width={80} rows={20} onSubmit={jest.fn()} onCancel={jest.fn()} />,
    );

    const frame = lastFrame()!;
    expect(frame).toContain("Intent Clarification");
    expect(frame).toContain("Which aspect of OOP would you like to explore?");
    expect(frame).toContain("explain oops");
    expect(frame).toContain("[1] General OOP concepts");
    expect(frame).toContain("[2] OOP in TypeScript");
    expect(frame).toContain("[3] Custom instructions...");
    unmount();
  });

  it("submits option directly when number key is pressed", async () => {
    const handleSubmit = jest.fn();
    const { stdin, unmount } = render(
      <ClarificationOverlay
        request={sampleRequest}
        width={80}
        rows={20}
        onSubmit={handleSubmit}
        onCancel={jest.fn()}
      />,
    );

    stdin.write("2");
    await tick();
    expect(handleSubmit).toHaveBeenCalledWith({ id: "clar-test-1", selectedId: "opt_ts" });
    unmount();
  });

  it("submits highlighted option on Enter", async () => {
    const handleSubmit = jest.fn();
    const { stdin, unmount } = render(
      <ClarificationOverlay
        request={sampleRequest}
        width={80}
        rows={20}
        onSubmit={handleSubmit}
        onCancel={jest.fn()}
      />,
    );

    stdin.write("\r");
    await tick();
    expect(handleSubmit).toHaveBeenCalledWith({ id: "clar-test-1", selectedId: "opt_general" });
    unmount();
  });

  it("calls onCancel when Escape is pressed", async () => {
    const handleCancel = jest.fn();
    const { stdin, unmount } = render(
      <ClarificationOverlay
        request={sampleRequest}
        width={80}
        rows={20}
        onSubmit={jest.fn()}
        onCancel={handleCancel}
      />,
    );

    stdin.write("\x1b");
    await tick();
    expect(handleCancel).toHaveBeenCalled();
    unmount();
  });

  it("switches to custom instructions mode when custom option is chosen", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ClarificationOverlay request={sampleRequest} width={80} rows={20} onSubmit={jest.fn()} onCancel={jest.fn()} />,
    );

    stdin.write("3");
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("Enter your custom instructions:");
    unmount();
  });
});
