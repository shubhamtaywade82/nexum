import { EventBus, RuntimeEvent } from "../../src/runtime/events/bus.js";

describe("EventBus", () => {
  it("delivers events to all subscribers", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.subscribe((e) => seen.push(e));
    bus.publish({ type: "status.changed", status: "hello" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: "status.changed", status: "hello" });
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    bus.publish({ type: "status.changed", status: "a" });
    unsub();
    bus.publish({ type: "status.changed", status: "b" });
    expect(seen).toHaveLength(1);
  });

  it("a subscriber unsubscribing during publish does not break others", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe(() => {
      seen.push("first");
      unsub();
    });
    bus.subscribe(() => seen.push("second"));
    bus.publish({ type: "status.changed", status: "x" });
    expect(seen).toEqual(["first", "second"]);
  });

  it("a throwing subscriber does not stop delivery or reach the publisher", () => {
    const failures: Array<{ message: string; type: string }> = [];
    const bus = new EventBus({
      onListenerError: (error, event) => failures.push({ message: (error as Error).message, type: event.type }),
    });
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => seen.push("after-throw"));

    expect(() => bus.publish({ type: "status.changed", status: "x" })).not.toThrow();
    expect(seen).toEqual(["after-throw"]);
    expect(failures).toEqual([{ message: "boom", type: "status.changed" }]);
  });

  it("reports a failing subscriber to stderr by default", () => {
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const bus = new EventBus();
      bus.subscribe(() => {
        throw new Error("boom");
      });
      bus.publish({ type: "status.changed", status: "x" });
      expect(write).toHaveBeenCalledWith("[event-bus] a subscriber failed on status.changed: boom\n");
    } finally {
      write.mockRestore();
    }
  });
});
