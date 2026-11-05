import { gateTaskCompletion } from "../../src/runtime/verification-gate.js";
import { VerifierService, expectCommandSucceeds, expectOutputContains } from "../../src/runtime/critic/verifier.js";
import type { Task, TaskStatus } from "../../src/runtime/types.js";

const task = (status: TaskStatus): Task[] => [{ id: "t1", title: "fix spec", status, dependencies: [] }];

describe("expectCommandSucceeds", () => {
  it("passes on exit 0 and ignores the answer text", async () => {
    const check = expectCommandSucceeds("tests", "rspec passes", async () => ({ exitCode: 0 }));
    expect(await check.run("I broke everything")).toEqual({ pass: true });
  });

  it("fails on non-zero exit with the output tail", async () => {
    const check = expectCommandSucceeds(
      "tests",
      "rspec",
      async () => ({ exitCode: 1, output: "x".repeat(600) + "2 failures" }),
      20,
    );
    const res = await check.run("all green!");
    expect(res.pass).toBe(false);
    expect(res.detail).toBe(`exit 1: ${"x".repeat(10)}2 failures`);
  });

  it("fails on a malformed exit code", async () => {
    const check = expectCommandSucceeds("c", "c", async () => ({ exitCode: Number.NaN }));
    expect((await check.run("")).pass).toBe(false);
  });
});

describe("gateTaskCompletion", () => {
  it("completes a running task only when every check passes", async () => {
    const v = new VerifierService()
      .register(expectCommandSucceeds("tests", "tests pass", async () => ({ exitCode: 0 })))
      .register(expectOutputContains(["auth_spec"]));
    const res = await gateTaskCompletion(task("running"), "t1", v, "fixed auth_spec");
    expect(res.outcome).toBe("completed");
    expect(res.tasks[0]).toMatchObject({ status: "completed", progress: 1 });
  });

  it("fails the task when a deterministic check fails, regardless of the model's claim", async () => {
    const v = new VerifierService().register(
      expectCommandSucceeds("tests", "tests pass", async () => ({ exitCode: 1, output: "auth_spec.rb:48 failed" })),
    );
    const res = await gateTaskCompletion(task("running"), "t1", v, "Done — all tests pass.");
    expect(res.outcome).toBe("failed");
    expect(res.tasks[0].status).toBe("failed");
    expect(res.reason).toContain("auth_spec.rb:48");
  });

  it("can route failures to blocked instead", async () => {
    const v = new VerifierService().register(expectOutputContains(["never"]));
    const res = await gateTaskCompletion(task("running"), "t1", v, "x", { onFailure: "blocked" });
    expect(res.tasks[0].status).toBe("blocked");
  });

  it("treats a throwing runner (network/sandbox error) as a failure", async () => {
    const v = new VerifierService().register(
      expectCommandSucceeds("tests", "tests", async () => {
        throw new Error("docker daemon unreachable");
      }),
    );
    const res = await gateTaskCompletion(task("running"), "t1", v, "ok");
    expect(res.outcome).toBe("failed");
    expect(res.reason).toContain("docker daemon unreachable");
  });

  it("refuses to complete with an empty contract by default", async () => {
    const res = await gateTaskCompletion(task("running"), "t1", new VerifierService(), "done");
    expect(res.outcome).toBe("failed");
    expect(res.report).toBeUndefined();
    const allowed = await gateTaskCompletion(task("running"), "t1", new VerifierService(), "done", {
      requireChecks: false,
    });
    expect(allowed.outcome).toBe("completed");
  });

  it("skips non-running and unknown tasks without running checks (idempotent)", async () => {
    const run = jest.fn(async () => ({ exitCode: 0 }));
    const v = new VerifierService().register(expectCommandSucceeds("c", "c", run));
    const done = task("completed");
    const res = await gateTaskCompletion(done, "t1", v, "done again");
    expect(res.outcome).toBe("skipped");
    expect(res.tasks).toBe(done);
    expect((await gateTaskCompletion(done, "nope", v, "")).outcome).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
  });
});
