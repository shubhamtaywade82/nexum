/**
 * Prompt editing through the real App key pipeline. These pin two input bugs:
 *   - two edits delivered before React re-renders both acted on the same stale
 *     cursor, so two backspaces in one tick removed one character
 *   - a paste did not move the cursor past the text it inserted, so the next
 *     typed character landed before the paste
 */
import React from "react";
import { render } from "../wide-render.js";
import { App, ShellAgent } from "../../../src/ui/App.js";
import { EventBus } from "../../../src/runtime/events/bus.js";
import { initialRuntimeState, Store } from "../../../src/runtime/store.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function world() {
  const bus = new EventBus();
  const store = new Store(initialRuntimeState({ workspace: "w", branch: "main", model: "m" }));
  store.attach(bus);
  const agent = { runUserMessage: jest.fn(async () => "ok") } as unknown as ShellAgent;
  return { bus, store, agent };
}

/** The prompt line as drawn: the text after the "> " marker, on the row that starts with it. */
function promptLine(frame: string | undefined): string | undefined {
  const row = stripAnsi(frame ?? "")
    .split("\n")
    .find((line) => line.startsWith("> "));
  return row?.slice(2).trimEnd();
}

// Real wait: the render is throttled, so a state change is only drawn after the throttle window.
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("prompt editing through the App key pipeline", () => {
  it("applies two backspaces delivered in one tick to two characters", async () => {
    const w = world();
    const r = render(<App bus={w.bus} store={w.store} agent={w.agent} columns={100} rows={30} now={0} />);
    r.stdin.write("abc");
    await settle();
    r.stdin.write("\x7f");
    r.stdin.write("\x7f");
    await settle();
    expect(promptLine(r.lastFrame())).toBe("a");
    r.unmount();
  });

  it("moves the cursor past a single-line paste so the next character follows it", async () => {
    const w = world();
    const r = render(<App bus={w.bus} store={w.store} agent={w.agent} columns={100} rows={30} now={0} />);
    r.stdin.write("\x1b[200~ab\x1b[201~");
    await settle();
    r.stdin.write("X");
    await settle();
    expect(promptLine(r.lastFrame())).toBe("abX");
    r.unmount();
  });
});
