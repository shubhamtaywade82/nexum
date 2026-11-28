/**
 * MAC v1 P6, PR 6.1 — typed Kit adapter over executeKitCommand (SPEC §10.2/§10.5).
 *
 * All behavior is exercised through an INJECTED scripted runner (the adapter
 * must take an injectable command runner — like GitHubDeliveryAdapter takes
 * git/HTTP), plus one end-to-end case through the REAL fixture binary to prove
 * the adapter and the five `sdlc_*` tools share one invocation path (R-06).
 *
 * Coverage (issue #84 acceptance criteria):
 *   - allowlist: every non-union invocation refused BEFORE spawn — including
 *     `kit host install`, `kit install`, `kit new`, `kit evolve`, `kit memory`
 *   - id regex validation before spawn
 *   - fail-closed JSON parsing (never guess the phase state)
 *   - forward-compatible `kit next --json` (unknown fields ignored, missing
 *     required fields fail — R-13)
 *   - timeout policy: retry once, then blocker
 *   - kit-missing: degraded blocker `external-unavailable`, never silent
 *   - TDD phase argv matches the verified Kit CLI surface (feature/fix …
 *     start|red|green|refactor|verify, journal <id> --verify, next --json)
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SdlcKitAdapter,
  SDLCKIT_OPS,
  isFeatureId,
  isTaskId,
  type KitCommandRunner,
  type SdlcKitCommand,
  type SdlcKitResult,
} from "../../src/domains/agentic-sdlc-kit/adapter.js";

/** A scripted runner: records every invocation, answers from a queue (default: healthy empty JSON). */
function scriptedRunner(scripts: {
  responses?: Array<{ stdout?: string; stderr?: string; exitCode?: number }>;
  hang?: boolean;
}): { runner: KitCommandRunner; calls: Array<{ argv: string[]; cwd: string; timeoutMs: number }> } {
  const calls: Array<{ argv: string[]; cwd: string; timeoutMs: number }> = [];
  let index = 0;
  const runner: KitCommandRunner = async (invocation) => {
    calls.push({ argv: [...invocation.argv], cwd: invocation.cwd, timeoutMs: invocation.timeoutMs });
    if (scripts.hang) {
      return new Promise(() => undefined); // never resolves — the adapter's timer must fire
    }
    const response = scripts.responses?.[index] ?? {};
    index += 1;
    return {
      // default is well-formed JSON with next's required field — content
      // specifics are overridden per case via `responses`
      stdout: response.stdout ?? '{"requiredAction": "red"}',
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? 0,
    };
  };
  return { runner, calls };
}

const CLI_PRESENT = () => "/mock/kit/cli.js";

describe("P6 PR 6.1 — SdlcKitAdapter (typed, allowlisted, fail-closed)", () => {
  // ── Allowlist: deny-by-default (SPEC §10.2) ───────────────────────────────

  describe("allowlist — every non-union invocation is refused before spawn", () => {
    const refusals: Array<{ label: string; command: unknown }> = [
      { label: "kit host install", command: { op: "host", rest: "install" } },
      { label: "kit host install (combined)", command: { op: "host install" } },
      { label: "kit install", command: { op: "install" } },
      { label: "kit new", command: { op: "new" } },
      { label: "kit evolve", command: { op: "evolve" } },
      { label: "kit memory write", command: { op: "memory", action: "write", key: "x", value: "y" } },
      { label: "kit attach", command: { op: "attach" } },
      { label: "raw argv injection", command: { op: "journal-verify", runId: "FEATURE-001; rm -rf /" } },
      { label: "not even an object", command: "feature FEATURE-001 start" },
      { label: "null", command: null },
    ];

    for (const { label, command } of refusals) {
      it(`refuses: ${label}`, async () => {
        const { runner, calls } = scriptedRunner({});
        const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
        const result = await adapter.execute(command as SdlcKitCommand);
        expect(result.ok).toBe(false);
        expect(result.failure).toBe("invalid-command");
        expect(result.exitCode).toBe(-1);
        expect(calls).toEqual([]); // nothing was ever spawned
      });
    }

    it("the op vocabulary is exactly the SPEC §10.2 union (closed set)", () => {
      expect([...SDLCKIT_OPS]).toEqual([
        "inspect",
        "doctor",
        "validate-spec",
        "validate-plan",
        "verify",
        "feature-phase",
        "fix-phase",
        "next",
        "journal-verify",
      ]);
    });

    it("exhaustiveness: default branch of toArgv refuses unknown ops at runtime too", async () => {
      const { runner, calls } = scriptedRunner({});
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "optimize" } as unknown as SdlcKitCommand);
      expect(result.failure).toBe("invalid-command");
      expect(calls).toEqual([]);
    });
  });

  // ── Id regex validation (SPEC §10.2 — before spawn) ───────────────────────

  describe("id regex validation happens before any spawn", () => {
    it("isFeatureId accepts FEATURE-001 / BUG-101, rejects injections", () => {
      expect(isFeatureId("FEATURE-001")).toBe(true);
      expect(isFeatureId("BUG-101")).toBe(true);
      expect(isFeatureId("feature-001")).toBe(false); // lowercase
      expect(isFeatureId("FEATURE 001")).toBe(false); // space
      expect(isFeatureId("FEATURE-001;rm -rf /")).toBe(false);
      expect(isFeatureId("")).toBe(false);
      expect(isFeatureId("-LEADING")).toBe(false); // must start [A-Z0-9]
    });

    it("isTaskId accepts TASK-001, rejects TASK-1 / task-001 / empty", () => {
      expect(isTaskId("TASK-001")).toBe(true);
      expect(isTaskId("TASK-123456")).toBe(true);
      expect(isTaskId("TASK-1")).toBe(false); // needs ≥ 3 digits
      expect(isTaskId("task-001")).toBe(false);
      expect(isTaskId("TASK-0;1")).toBe(false);
      expect(isTaskId("")).toBe(false);
    });

    it("a bad feature-phase id is refused with the runner never invoked", async () => {
      const { runner, calls } = scriptedRunner({});
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({
        op: "feature-phase",
        featureId: "feature-001" as never,
        taskId: "TASK-001",
        phase: "red",
      });
      expect(result.failure).toBe("invalid-command");
      expect(calls).toEqual([]);
    });
  });

  // ── Union → argv (verified Kit CLI surface) ────────────────────────────────

  describe("argv conversion matches the verified Kit CLI surface", () => {
    const cases: Array<{ label: string; command: SdlcKitCommand; expectedArgv: string[] }> = [
      {
        label: "inspect defaults to the adapter cwd",
        command: { op: "inspect" },
        expectedArgv: ["inspect", "/repo", "--json"],
      },
      {
        label: "inspect with explicit path",
        command: { op: "inspect", path: "/repo/sub" },
        expectedArgv: ["inspect", "/repo/sub", "--json"],
      },
      { label: "doctor (human output — no --json)", command: { op: "doctor" }, expectedArgv: ["doctor"] },
      {
        label: "validate-spec",
        command: { op: "validate-spec", path: "docs/specifications" },
        expectedArgv: ["validate-spec", "docs/specifications", "--json"],
      },
      {
        label: "validate-plan",
        command: { op: "validate-plan", path: "docs/plans" },
        expectedArgv: ["validate-plan", "docs/plans", "--json"],
      },
      {
        label: "verify",
        command: { op: "verify", path: "/repo" },
        expectedArgv: ["verify", "/repo", "--json"],
      },
      {
        label: "verify --dry-run",
        command: { op: "verify", path: "/repo", dryRun: true },
        expectedArgv: ["verify", "/repo", "--json", "--dry-run"],
      },
      {
        label: "feature start (no task id on the CLI)",
        command: { op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "start" },
        expectedArgv: ["feature", "FEATURE-001", "start", "--json", "--host", "nexum"],
      },
      {
        label: "feature red (task id positional)",
        command: { op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "red" },
        expectedArgv: ["feature", "FEATURE-001", "red", "TASK-001", "--json", "--host", "nexum"],
      },
      {
        label: "feature green",
        command: { op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "green" },
        expectedArgv: ["feature", "FEATURE-001", "green", "TASK-001", "--json", "--host", "nexum"],
      },
      {
        label: "feature refactor",
        command: { op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "refactor" },
        expectedArgv: ["feature", "FEATURE-001", "refactor", "TASK-001", "--json", "--host", "nexum"],
      },
      {
        label: "feature verify (no task id on the CLI)",
        command: { op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "verify" },
        expectedArgv: ["feature", "FEATURE-001", "verify", "--json", "--host", "nexum"],
      },
      {
        label: "fix red uses the fix command",
        command: { op: "fix-phase", fixId: "BUG-101", taskId: "TASK-002", phase: "red" },
        expectedArgv: ["fix", "BUG-101", "red", "TASK-002", "--json", "--host", "nexum"],
      },
      { label: "next", command: { op: "next" }, expectedArgv: ["next", "--json"] },
      {
        label: "journal-verify",
        command: { op: "journal-verify", runId: "FEATURE-001" },
        expectedArgv: ["journal", "FEATURE-001", "--verify", "--json"],
      },
    ];

    for (const { label, command, expectedArgv } of cases) {
      it(label, async () => {
        const { runner, calls } = scriptedRunner({});
        const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
        const result = await adapter.execute(command);
        expect(result.failure).toBeNull();
        expect(result.argv).toEqual(expectedArgv);
        expect(calls).toEqual([{ argv: expectedArgv, cwd: "/repo", timeoutMs: 60_000 }]);
      });
    }

    it("declares a custom journal host (Kit ADR-0021: a host declares itself)", async () => {
      const { runner, calls } = scriptedRunner({});
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT, host: "nexum-mission-cli" });
      await adapter.execute({ op: "feature-phase", featureId: "FEATURE-001", taskId: "TASK-001", phase: "red" });
      expect(calls[0]?.argv).toContain("nexum-mission-cli");
      expect(calls[0]?.argv).toEqual([
        "feature",
        "FEATURE-001",
        "red",
        "TASK-001",
        "--json",
        "--host",
        "nexum-mission-cli",
      ]);
    });

    it("a per-op timeout override reaches the runner", async () => {
      const { runner, calls } = scriptedRunner({});
      const adapter = new SdlcKitAdapter({
        cwd: "/repo",
        runner,
        resolveCli: CLI_PRESENT,
        timeouts: { "journal-verify": 5_000 },
      });
      await adapter.execute({ op: "journal-verify", runId: "FEATURE-001" });
      expect(calls[0]?.timeoutMs).toBe(5_000);
    });
  });

  // ── Fail-closed parsing (SPEC §10.5 row 3) ────────────────────────────────

  describe("fail-closed JSON parsing — the phase state is never guessed", () => {
    it("non-JSON output on a --json op is a failure with the raw output preserved", async () => {
      const { runner } = scriptedRunner({ responses: [{ stdout: "plain text fallback output", exitCode: 0 }] });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("parse");
      expect(result.parsed).toBeNull();
      expect(result.stdout).toBe("plain text fallback output"); // preserved, never guessed
      expect(result.exitCode).toBe(0); // honest: the process exited 0; parsing is what failed
    });

    it("well-formed JSON passes through parsed", async () => {
      const payload = {
        featureId: "FEATURE-001",
        status: "in_progress",
        taskId: "TASK-001",
        phase: "red",
        requiredAction: "red",
        nextInvocation: "kit feature FEATURE-001 red TASK-001",
        verificationCommand: ["npm", "test"],
        blockingQuestions: [],
        advisoryLessons: [],
      };
      const { runner } = scriptedRunner({ responses: [{ stdout: JSON.stringify(payload), exitCode: 0 }] });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(true);
      expect(result.parsed).toEqual(payload);
    });

    it("kit next: unknown extra fields are ignored (forwards-compatible, R-13)", async () => {
      const payload = {
        featureId: "FEATURE-001",
        status: "in_progress",
        requiredAction: "red",
        nextInvocation: "kit feature FEATURE-001 red TASK-001",
        verificationCommand: ["npm", "test"],
        blockingQuestions: [],
        advisoryLessons: [],
        futureFieldFromKit0_9: { anything: true }, // unknown — ignored
      };
      const { runner } = scriptedRunner({ responses: [{ stdout: JSON.stringify(payload), exitCode: 0 }] });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(true);
      expect((result.parsed as Record<string, unknown>).futureFieldFromKit0_9).toBeDefined();
    });

    it("kit next: missing required field (requiredAction) is a parse failure", async () => {
      const payload = { featureId: "FEATURE-001", status: "in_progress" }; // no requiredAction
      const { runner } = scriptedRunner({ responses: [{ stdout: JSON.stringify(payload), exitCode: 0 }] });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("parse");
    });

    it("doctor output is not required to be JSON (parsed stays null, ok per exit code)", async () => {
      const { runner } = scriptedRunner({
        responses: [{ stdout: "kit 0.7.1\n  node 24.19.0 [ok]\nStatus: healthy", exitCode: 0 }],
      });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "doctor" });
      expect(result.ok).toBe(true);
      expect(result.parsed).toBeNull();
    });
  });

  // ── Exit codes (SPEC §10.5 row 4) ─────────────────────────────────────────

  describe("exit-code honesty", () => {
    it("exit 0 + JSON → ok", async () => {
      const { runner } = scriptedRunner({ responses: [{ stdout: '{"valid": true}', exitCode: 0 }] });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "validate-spec", path: "docs/specifications" });
      expect(result.ok).toBe(true);
      expect(result.failure).toBeNull();
    });

    it("exit 1 (kit refused the transition / verification failed) → command-failed, stderr surfaced", async () => {
      const { runner } = scriptedRunner({
        responses: [{ stdout: "{}", stderr: "kit feature: no RED recorded for TASK-001", exitCode: 1 }],
      });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({
        op: "feature-phase",
        featureId: "FEATURE-001",
        taskId: "TASK-001",
        phase: "green",
      });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("command-failed");
      expect(result.stderr).toContain("no RED recorded");
    });

    it("exit 3 (blocked — e.g. no active run) → command-failed with the kit's message", async () => {
      const { runner } = scriptedRunner({
        responses: [{ stdout: "", stderr: "kit next: no active feature runs", exitCode: 3 }],
      });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("no active feature runs");
    });
  });

  // ── Kit missing (SPEC §10.5 row 1) ────────────────────────────────────────

  describe("kit-missing behavior — degraded, never silent", () => {
    it("resolveKitCliPath → null: failure kit-unavailable + blocker external-unavailable", async () => {
      const { runner, calls } = scriptedRunner({});
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: () => null });
      expect(adapter.available()).toBe(false);
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe("kit-unavailable");
      expect(result.blocker).toBe("external-unavailable");
      expect(calls).toEqual([]); // nothing spawned
    });
  });

  // ── Timeout policy (SPEC §10.5 row 2: retry once, then blocker) ────────────

  describe("timeout policy", () => {
    it("a hanging command is retried exactly once, then blocker kit-timeout", async () => {
      const { runner, calls } = scriptedRunner({ hang: true });
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT, timeouts: { next: 50 } });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.failure).toBe("timeout");
      expect(result.blocker).toBe("kit-timeout");
      expect(calls.length).toBe(2); // retry once (SPEC §10.5)
    });

    it("a timeout that succeeds on retry returns ok", async () => {
      let call = 0;
      const calls: number[] = [];
      const runner: KitCommandRunner = async () => {
        call += 1;
        calls.push(call);
        if (call === 1) return new Promise(() => undefined); // first hangs
        return { stdout: JSON.stringify({ requiredAction: "run.completed" }), stderr: "", exitCode: 0 };
      };
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner, resolveCli: CLI_PRESENT, timeouts: { next: 50 } });
      const result = await adapter.execute({ op: "next" });
      expect(result.ok).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(calls).toEqual([1, 2]);
    });
  });

  // ── Evidence sink ─────────────────────────────────────────────────────────

  describe("raw-output evidence", () => {
    it("the artifact sink receives the raw record and its refs land on the result", async () => {
      const seen: string[] = [];
      const adapter = new SdlcKitAdapter({
        cwd: "/repo",
        runner: scriptedRunner({}).runner,
        resolveCli: CLI_PRESENT,
        artifactSink: (record) => {
          seen.push(record.op);
          return [
            `artifact:ma_${record.argv
              .join("_")
              .replace(/[^a-z0-9]/gi, "")
              .slice(0, 8)}`,
          ];
        },
      });
      const result = await adapter.execute({ op: "journal-verify", runId: "FEATURE-001" });
      expect(seen).toEqual(["journal-verify"]);
      expect(result.evidence).toEqual([expect.stringMatching(/^artifact:ma_/)]);
    });

    it("without a sink evidence is empty (the mission plane wires the store)", async () => {
      const adapter = new SdlcKitAdapter({ cwd: "/repo", runner: scriptedRunner({}).runner, resolveCli: CLI_PRESENT });
      const result = await adapter.execute({ op: "next" });
      expect(result.evidence).toEqual([]);
    });
  });

  // ── Shared invocation path (R-06 de-duplication review) ───────────────────

  describe("shared invocation path with the five sdlc_* tools (R-06)", () => {
    let fixtureDir: string | null = null;
    const originalEnv = process.env.NEXUM_SDLC_KIT_PATH;

    beforeAll(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), "nexum-kit-adapter-"));
      const fixtureScript = join(fixtureDir, "mock-kit.js");
      writeFileSync(
        fixtureScript,
        `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "doctor") {
  console.log("kit 0.7.1\\n  node 24.19.0 [ok]\\nStatus: healthy");
  process.exit(0);
}
if (cmd === "next") {
  const fs = require("node:fs");
  const path = require("node:path");
  // echo back the argv the adapter built, plus a requiredAction — proves the
  // adapter rides the same resolveKitCliPath/executeKitCommand path as the tools
  console.log(JSON.stringify({ featureId: "FEATURE-001", status: "in_progress", requiredAction: "red",
    nextInvocation: "kit feature FEATURE-001 red TASK-001", verificationCommand: ["npm", "test"],
    blockingQuestions: [], advisoryLessons: [], echoArgv: process.argv.slice(2) }));
  process.exit(0);
}
process.exit(1);
`,
      );
      process.env.NEXUM_SDLC_KIT_PATH = fixtureScript;
    });

    afterAll(() => {
      if (originalEnv !== undefined) process.env.NEXUM_SDLC_KIT_PATH = originalEnv;
      else delete process.env.NEXUM_SDLC_KIT_PATH;
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("no injected runner: executes through the real executeKitCommand path", async () => {
      const adapter = new SdlcKitAdapter({ cwd: fixtureDir! }); // default runner + resolveKitCliPath
      expect(adapter.available()).toBe(true);
      const doctor = await adapter.execute({ op: "doctor" });
      expect(doctor.ok).toBe(true);
      expect(doctor.stdout).toContain("Status: healthy");

      const next: SdlcKitResult<{ echoArgv: string[] }> = await adapter.execute({ op: "next" });
      expect(next.ok).toBe(true);
      expect(next.parsed?.echoArgv).toEqual(["next", "--json"]); // our argv, through the real path
    });

    it("a refused command never spawns even on the real path", async () => {
      const adapter = new SdlcKitAdapter({ cwd: fixtureDir! });
      const result = await adapter.execute({ op: "evolve" } as unknown as SdlcKitCommand);
      expect(result.failure).toBe("invalid-command");
      expect(result.exitCode).toBe(-1);
    });
  });
});
