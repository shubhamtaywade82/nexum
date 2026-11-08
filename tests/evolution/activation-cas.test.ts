import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ManifestRuntimeActivationController,
  RuntimeSwitchConflictError,
} from "../../src/evolution/monitoring/manifest-runtime-activation.js";

/**
 * Conditional activation: a switch lands only while the runtime still executes the harness the
 * caller expected. Two competing activations that captured the same expectation must not both land.
 */

const exec = promisify(execFile);

async function makeRepo(): Promise<{ root: string; first: string; second: string }> {
  const root = mkdtempSync(join(tmpdir(), "nexumcas-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "one\n");
  await exec("git", ["add", "-A"], { cwd: root });
  await exec("git", ["commit", "-q", "-m", "first"], { cwd: root });
  const first = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  writeFileSync(join(root, "a.txt"), "two\n");
  await exec("git", ["commit", "-qam", "second"], { cwd: root });
  const second = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { root, first, second };
}

describe("conditional runtime activation (compare-and-swap)", () => {
  let root: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    ({ root, first, second } = await makeRepo());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lets exactly one of two competing activations land when both expected the same harness", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });

    const results = await Promise.allSettled([
      controller.switchTo("H1", first, "unversioned"),
      controller.switchTo("H2", second, "unversioned"),
    ]);

    const landed = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(RuntimeSwitchConflictError);

    const winner = controller.readPointer();
    expect(winner?.id === "H1" || winner?.id === "H2").toBe(true);
    expect(winner?.commitSha).toBe(winner?.id === "H1" ? first : second);
  });

  it("refuses a conditional switch whose expectation is stale, and writes nothing", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    await controller.switchTo("H1", first);

    await expect(controller.switchTo("H2", second, "unversioned")).rejects.toBeInstanceOf(RuntimeSwitchConflictError);
    expect(controller.readPointer()?.id).toBe("H1");
    expect(controller.readPointer()?.commitSha).toBe(first);
  });

  it("proceeds when the expectation matches, and the next expectation must match the new state", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    await controller.switchTo("H1", first, "unversioned");
    await controller.switchTo("H2", second, "H1");
    expect(controller.readPointer()?.id).toBe("H2");

    await expect(controller.switchTo("H3", first, "H1")).rejects.toBeInstanceOf(RuntimeSwitchConflictError);
    expect(controller.readPointer()?.id).toBe("H2");
  });

  it("releases the switch lock after every switch, including refused ones", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    const lockDir = join(root, "nexum.harness.json.switch.lock");

    await controller.switchTo("H1", first, "unversioned");
    expect(existsSync(lockDir)).toBe(false);

    await expect(controller.switchTo("H2", second, "unversioned")).rejects.toThrow();
    expect(existsSync(lockDir)).toBe(false);
  });

  it("keeps the unconditional switch working for rollback callers", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    await controller.switchTo("H1", first);
    await controller.switchTo("H2", second);
    expect(controller.readPointer()?.id).toBe("H2");
  });
});
