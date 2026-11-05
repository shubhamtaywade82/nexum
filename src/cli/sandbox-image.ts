import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../platform/brand.js";

/** True when the Docker daemon answers and `image` exists locally (any image when omitted). */
export function checkSandboxImage(image?: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = spawn("docker", ["info"], { stdio: "ignore" });
    probe.on("close", (code) => {
      if (code !== 0) return resolveProbe(false);
      if (!image) return resolveProbe(true);
      const imgProbe = spawn("docker", ["image", "inspect", image], { stdio: "ignore" });
      imgProbe.on("close", (imgCode) => resolveProbe(imgCode === 0));
      imgProbe.on("error", () => resolveProbe(false));
    });
    probe.on("error", () => resolveProbe(false));
  });
}

/** Directory holding the sandbox Dockerfile, shipped with the package (`docker/nexum-sandbox/`). */
export function sandboxDockerfileDir(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  // src/cli or dist/cli -> package root
  const dir = resolve(from, "..", "..", "docker", "nexum-sandbox");
  return existsSync(join(dir, "Dockerfile")) ? dir : undefined;
}

export interface BuildResult {
  ok: boolean;
  message: string;
}

export interface BuildOptions {
  timeoutMs?: number;
  dockerfileDir?: string;
  spawnImpl?: typeof spawn;
}

const TAIL_CHARS = 2000;

/**
 * Builds the default sandbox image from the shipped Dockerfile. Only the
 * default image name is built: a custom `shellImage` is the user's own image
 * and is never overwritten with ours.
 */
export function buildSandboxImage(image: string, opts: BuildOptions = {}): Promise<BuildResult> {
  if (image !== BRAND.sandboxImage) {
    return Promise.resolve({
      ok: false,
      message: `"${image}" is a custom sandbox image; build it yourself (only ${BRAND.sandboxImage} is built automatically)`,
    });
  }
  const dir = opts.dockerfileDir ?? sandboxDockerfileDir();
  if (!dir) {
    return Promise.resolve({
      ok: false,
      message:
        "sandbox Dockerfile not found in this installation; run: docker build -t nexum-sandbox:latest docker/nexum-sandbox/",
    });
  }

  const spawnFn = opts.spawnImpl ?? spawn;
  return new Promise((resolveBuild) => {
    let tail = "";
    let settled = false;
    const finish = (result: BuildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBuild(result);
    };
    const child = spawnFn("docker", ["build", "-t", image, dir], { stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer | string): void => {
      tail = (tail + chunk.toString()).slice(-TAIL_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        finish({ ok: false, message: `docker build timed out\n${tail}` });
      },
      opts.timeoutMs ?? 10 * 60 * 1000,
    );
    child.on("error", (err) => finish({ ok: false, message: `could not run docker: ${err.message}` }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, message: `built ${image}` }
          : { ok: false, message: `docker build failed (exit ${code})\n${tail}` },
      ),
    );
  });
}
