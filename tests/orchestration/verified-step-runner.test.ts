import { VerifiedStepRunner } from "../../src/orchestration/verified-step-runner.js";
import { Orchestrator } from "../../src/orchestration/orchestrator.js";
import type { PlanStep } from "../../src/orchestration/types.js";

const step = (id: string, description: string, extra: Partial<PlanStep> = {}): PlanStep => ({
  id,
  description,
  status: "pending",
  dependencies: [],
  retryCount: 0,
  ...extra,
});

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe("VerifiedStepRunner", () => {
  it("sends a compiled brief with the plan goal, the step and completed work — not the bare description", async () => {
    const runUserMessage = jest.fn(async () => "done");
    const s1 = step("s1", "add the migration", { status: "completed" });
    const s2 = step("s2", "fix auth spec", { dependencies: ["s1"], verify: "rspec spec/auth_spec.rb" });
    const runner = new VerifiedStepRunner(
      { goal: "Ship login", runUserMessage, runCommand: async () => ({ exitCode: 0 }) },
      [s1, s2, step("s3", "update docs")],
    );
    await runner.run(s2);
    const brief = (runUserMessage.mock.calls[0] as unknown as [string])[0];
    expect(brief).toContain("<task_goal>\nShip login\n</task_goal>");
    expect(brief).toContain("objective: fix auth spec");
    expect(brief).toContain("depends on: s1");
    expect(brief).toContain("`rspec spec/auth_spec.rb` exits 0");
    expect(brief).toContain("[done] s1: add the migration");
    expect(brief).toContain("[pending] s3: update docs");
  });

  it("completes only when the verify command exits 0", async () => {
    const runCommand = jest.fn(async () => ({ exitCode: 0 }));
    const runner = new VerifiedStepRunner({ goal: "g", runUserMessage: async () => "ok", runCommand });
    const out = await runner.run(step("s1", "x", { verify: "npm test" }));
    expect(out).toEqual({ kind: "success", output: { text: "ok", verified: true } });
    expect(runCommand).toHaveBeenCalledWith("npm test");
  });

  it("turns a failed verification into a retryable outcome and feeds it into the next brief", async () => {
    const runUserMessage = jest.fn(async () => "I fixed it, all tests pass");
    const runner = new VerifiedStepRunner({
      goal: "g",
      runUserMessage,
      runCommand: async () => ({ exitCode: 1, output: "auth_spec.rb:48 expected 200 got 401" }),
    });
    const s = step("s1", "fix spec", { verify: "rspec" });
    const out = await runner.run(s);
    expect(out.kind).toBe("retryable");
    expect(out.kind !== "success" && out.error).toContain("auth_spec.rb:48");
    await runner.run(s);
    const secondBrief = (runUserMessage.mock.calls[1] as unknown as [string])[0];
    expect(secondBrief).toContain("<previous_failures>");
    expect(secondBrief).toContain("expected 200 got 401");
  });

  it("treats a runner that throws (sandbox down) as a failed verification", async () => {
    const runner = new VerifiedStepRunner({
      goal: "g",
      runUserMessage: async () => "ok",
      runCommand: async () => {
        throw new Error("docker daemon unreachable");
      },
    });
    const out = await runner.run(step("s1", "x", { verify: "npm test" }));
    expect(out.kind).toBe("retryable");
    expect(out.kind !== "success" && out.error).toContain("docker daemon unreachable");
  });

  it("blocks a step that declares verify when no command runner exists", async () => {
    const runner = new VerifiedStepRunner({ goal: "g", runUserMessage: async () => "ok" });
    expect((await runner.run(step("s1", "x", { verify: "npm test" }))).kind).toBe("blocking");
  });

  it("passes steps without verify on a successful turn and records a thrown turn as a failure", async () => {
    const runner = new VerifiedStepRunner({
      goal: "g",
      runUserMessage: jest.fn().mockRejectedValueOnce(new Error("model timeout")).mockResolvedValue("ok"),
    });
    const s = step("s1", "x");
    expect(await runner.run(s)).toEqual({ kind: "retryable", error: "model timeout" });
    expect(runner.brief(s)).toContain("model timeout");
    expect((await runner.run(s)).kind).toBe("success");
  });

  it("drives an Orchestrator: a step failing verification retries, then completes once verify passes", async () => {
    const exits = [1, 0];
    const runner = new VerifiedStepRunner({
      goal: "g",
      runUserMessage: async () => "claimed done",
      runCommand: async () => ({ exitCode: exits.shift() ?? 0 }),
    });
    const steps = [step("s1", "fix", { verify: "npm test" })];
    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: { replan: async (r) => r },
      runRollback: async () => {},
      logger: quiet,
      onStepChange: (s) => runner.observe(s),
    });
    const final = await orchestrator.run();
    expect(final[0]).toMatchObject({ status: "completed", retryCount: 1 });
  });
});
