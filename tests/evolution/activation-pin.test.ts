import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ManifestRuntimeActivationController,
  NEXUM_HARNESS_MANIFEST_PATH,
} from "../../src/evolution/monitoring/manifest-runtime-activation.js";

/**
 * The runtime pointer is the thing the launcher executes. An activation pinned to
 * a commit must write exactly that commit, and must write nothing when the pin is
 * malformed or the commit is absent from the repository.
 */

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<{ root: string; head: string }> {
  const root = mkdtempSync(join(tmpdir(), "nexumpin-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "README.md"), "repo\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { root, head };
}

describe("ManifestRuntimeActivationController: pinned activation", () => {
  let root: string;
  let head: string;

  beforeEach(async () => {
    ({ root, head } = await makeRepo());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes exactly the pinned commit into the pointer", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    await controller.switchTo("H1", head);

    const pointer = controller.readPointer();
    expect(pointer?.id).toBe("H1");
    expect(pointer?.commitSha).toBe(head);
  });

  it("refuses a pin that is not a full 40-character sha, and writes nothing", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    await expect(controller.switchTo("H1", "main")).rejects.toThrow(/full 40-character sha/);
    await expect(controller.switchTo("H1", head.slice(0, 12))).rejects.toThrow(/full 40-character sha/);
    expect(controller.readPointer()).toBeNull();
  });

  it("refuses a well-formed pin to a commit that is absent from the repository, and writes nothing", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    const absent = "f".repeat(40);
    await expect(controller.switchTo("H1", absent)).rejects.toThrow(/missing from the repository/);
    expect(controller.readPointer()).toBeNull();
    expect(existsSync(join(root, NEXUM_HARNESS_MANIFEST_PATH))).toBe(false);
  });

  it("leaves an existing pointer untouched when a later pinned switch is refused", async () => {
    const controller = new ManifestRuntimeActivationController({ repoRoot: root });
    await controller.switchTo("H1", head);
    const before = readFileSync(join(root, NEXUM_HARNESS_MANIFEST_PATH), "utf8");

    await expect(controller.switchTo("H2", "e".repeat(40))).rejects.toThrow();
    expect(readFileSync(join(root, NEXUM_HARNESS_MANIFEST_PATH), "utf8")).toBe(before);
  });
});
