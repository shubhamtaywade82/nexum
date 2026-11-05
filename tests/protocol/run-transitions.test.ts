import { isValidRunTransition, runStatusPredecessors } from "../../src/protocol/types.js";

describe("run status transitions", () => {
  it("only lets live runs reach terminal states", () => {
    expect(runStatusPredecessors("completed")).toEqual(["running"]);
    expect(runStatusPredecessors("running")).toEqual(["queued"]);
    expect(runStatusPredecessors("cancelled").sort()).toEqual(["queued", "running"]);
    expect(runStatusPredecessors("interrupted").sort()).toEqual(["queued", "running"]);
  });

  it("never moves a terminal run (a late completion cannot overwrite a cancellation)", () => {
    expect(isValidRunTransition("cancelled", "completed")).toBe(false);
    expect(isValidRunTransition("interrupted", "failed")).toBe(false);
    expect(runStatusPredecessors("queued")).toEqual([]);
  });
});
