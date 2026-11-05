import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxImage, sandboxDockerfileDir } from "../../src/cli/sandbox-image.js";
import { BRAND } from "../../src/platform/brand.js";

function fakeSpawn(exitCode: number, output = "", error?: Error) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const impl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    setImmediate(() => {
      if (error) return child.emit("error", error);
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", exitCode);
    });
    return child;
  }) as any;
  return { impl, calls };
}

describe("sandboxDockerfileDir", () => {
  it("finds the Dockerfile shipped in this repository", () => {
    expect(sandboxDockerfileDir()).toMatch(/docker[\\/]nexum-sandbox$/);
  });

  it("returns undefined when there is no Dockerfile", () => {
    const root = mkdtempSync(join(tmpdir(), "nodocker-"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(sandboxDockerfileDir(join(root, "a", "b"))).toBeUndefined();
  });
});

describe("buildSandboxImage", () => {
  const dir = mkdtempSync(join(tmpdir(), "dockerfile-"));
  writeFileSync(join(dir, "Dockerfile"), "FROM node:22-slim\n");

  it("runs docker build for the default image with the Dockerfile directory", async () => {
    const { impl, calls } = fakeSpawn(0, "ok");
    const result = await buildSandboxImage(BRAND.sandboxImage, { dockerfileDir: dir, spawnImpl: impl });
    expect(result).toEqual({ ok: true, message: `built ${BRAND.sandboxImage}` });
    expect(calls[0]).toEqual({ cmd: "docker", args: ["build", "-t", BRAND.sandboxImage, dir] });
  });

  it("reports the output tail when the build fails", async () => {
    const { impl } = fakeSpawn(1, "no space left on device");
    const result = await buildSandboxImage(BRAND.sandboxImage, { dockerfileDir: dir, spawnImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("exit 1");
    expect(result.message).toContain("no space left on device");
  });

  it("reports a missing docker binary", async () => {
    const { impl } = fakeSpawn(0, "", new Error("spawn docker ENOENT"));
    const result = await buildSandboxImage(BRAND.sandboxImage, { dockerfileDir: dir, spawnImpl: impl });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("ENOENT");
  });

  it("never builds over a custom image name", async () => {
    const { impl, calls } = fakeSpawn(0);
    const result = await buildSandboxImage("my-own:1", { dockerfileDir: dir, spawnImpl: impl });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
