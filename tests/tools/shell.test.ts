import { EventEmitter } from "node:events";
import { jest } from "@jest/globals";

// jest.mock's auto-hoisting doesn't apply to real ESM — mock explicitly and
// import both the mock and the module under test dynamically, after the
// mock is registered (see https://jestjs.io/docs/ecmascript-modules).
jest.unstable_mockModule("node:child_process", () => ({ spawn: jest.fn() }));

const { spawn } = await import("node:child_process");
const { ShellTool } = await import("../../src/tools/shell.js");

const mockSpawn = spawn as jest.Mock;

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

afterEach(() => {
  mockSpawn.mockReset();
  jest.useRealTimers();
});

// Dynamic `await import()` gives ShellTool as a value binding only — this
// recovers a type from it for annotations below.
type ShellToolInstance = InstanceType<typeof ShellTool>;

function skipDockerPreflight(tool: ShellToolInstance): void {
  // Non-null means "already probed", which keeps call() on its synchronous
  // fast path so the fake child's listeners are attached in the same tick.
  (tool as any).dockerAvailable = true;
}

describe("ShellTool", () => {
  it("returns exitCode and output on successful execution", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new ShellTool({ workspaceRoot: "/tmp/ws" });
    skipDockerPreflight(tool);
    const promise = tool.call({ command: "echo hi" });

    proc.stdout.emit("data", Buffer.from("hi\n"));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    expect(await promise).toMatchObject({ exitCode: 0, stdout: "hi\n" });
  });

  it("returns non-zero exitCode on command failure", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new ShellTool({ workspaceRoot: "/tmp/ws" });
    skipDockerPreflight(tool);
    const promise = tool.call({ command: "false" });

    proc.stderr.emit("data", Buffer.from("error"));
    proc.emit("close", 1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error");
  });

  it("returns an error payload when docker binary cannot be spawned (fail-closed)", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new ShellTool({ workspaceRoot: "/tmp/ws" });
    skipDockerPreflight(tool);
    const promise = tool.call({ command: "echo" });

    proc.emit("error", new Error("ENOENT"));

    const result = await promise;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/failed to spawn docker/);
  });

  it("truncates output that exceeds MAX_OUTPUT_BYTES and returns BufferExceededError", async () => {
    jest.useFakeTimers();

    const proc = fakeProc();
    const killProc = fakeProc();
    mockSpawn.mockReturnValueOnce(proc).mockReturnValue(killProc);

    const tool = new ShellTool({ workspaceRoot: "/tmp/ws" });
    skipDockerPreflight(tool);
    const promise = tool.call({ command: "yes" });

    proc.stdout.emit("data", Buffer.alloc(ShellTool.MAX_OUTPUT_BYTES, "a"));
    proc.stdout.emit("data", Buffer.from("more"));

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

    killProc.emit("close", 0);
    proc.emit("close", -1);

    const result = await promise;
    expect(result.error).toBe("BufferExceededError");
    expect(result.truncated).toBe(true);
  });

  it("returns a DockerUnavailableError instead of a raw spawn error when docker is missing", async () => {
    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", logger: { info: jest.fn(), warn: jest.fn() } });
    (tool as any).dockerAvailable = false;
    (tool as any).dockerChecked = true;

    const result = await tool.call({ command: "echo hi" });

    expect(result.error).toBe("DockerUnavailableError");
    expect(result.exitCode).toBe(-1);
  });

  it("includes expected docker security flags", () => {
    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", timeoutSec: 15 });
    const args = (tool as any).dockerArgs("c1", "echo hi");

    expect(args).toContain("--network=none");
    expect(args).toContain("--pids-limit=128");
    expect(args).toContain("timeout");
    expect(args).toContain("15");
  });

  it("forwards stdout/stderr chunks to onOutput as they arrive, without changing the buffered result", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);
    const onOutput = jest.fn();

    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", onOutput });
    skipDockerPreflight(tool);
    const promise = tool.call({ command: "echo hi" });

    proc.stdout.emit("data", Buffer.from("hi\n"));
    proc.stderr.emit("data", Buffer.from("warn\n"));
    proc.emit("close", 0);

    const result = await promise;
    expect(onOutput).toHaveBeenCalledWith("stdout", "hi\n");
    expect(onOutput).toHaveBeenCalledWith("stderr", "warn\n");
    expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n", stderr: "warn\n" });
  });

  it("spawns on the host with sh when sandbox is false", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", sandbox: false });
    const promise = tool.call({ command: "echo host" });

    expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "echo host"], { cwd: "/tmp/ws" });

    proc.stdout.emit("data", Buffer.from("host\n"));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toMatchObject({ exitCode: 0, stdout: "host\n" });
  });
});

// timeoutSec arrives as untyped JSON from the model. It was read with a bare
// `as number`, so a string "30" made (timeoutSec + 15) * 1000 evaluate to
// 3015000 -- 50 minutes instead of 45 seconds -- and a non-numeric value
// produced NaN, which makes setTimeout fire immediately so *every* run_shell
// returned "sandbox exceeded hard timeout".
describe("ShellTool timeoutSec coercion", () => {
  const resolve = (tool: ShellToolInstance, raw: unknown): number => (tool as any).resolveTimeoutSec(raw);

  it("accepts a number", () => {
    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", timeoutSec: 30 });
    expect(resolve(tool, 45)).toBe(45);
  });

  it("coerces a numeric string instead of concatenating it", () => {
    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", timeoutSec: 30 });
    expect(resolve(tool, "45")).toBe(45);
  });

  it.each([undefined, null, "soon", NaN, 0, -5, {}])("falls back to the configured default for %p", (raw) => {
    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", timeoutSec: 30 });
    expect(resolve(tool, raw)).toBe(30);
  });

  it("clamps a value that would disable the sandbox time budget", () => {
    const tool = new ShellTool({ workspaceRoot: "/tmp/ws", timeoutSec: 30 });
    expect(resolve(tool, 10 ** 9)).toBe(ShellTool.MAX_TIMEOUT_SEC);
  });
});
