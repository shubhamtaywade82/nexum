/**
 * Builds real plugin artifacts (deterministic tar via packDirectory) so
 * marketplace tests exercise the actual extract → validate → activate path.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packDirectory } from "../../src/marketplace/tar.js";

export interface FixtureOptions {
  /** Extra/overriding package.json fields. */
  pkg?: Record<string, unknown>;
  /** Files relative to the package root (overrides the default index.js). */
  files?: Record<string, string>;
}

export function pluginModule(
  id: string,
  version: string,
  setupBody = `ctx.provide("greeting:${id}", "hello");`,
): string {
  return `export default {
  manifest: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, version: ${JSON.stringify(version)} },
  async setup(ctx) { ${setupBody} },
};
`;
}

export function pluginArtifact(id: string, version: string, opts: FixtureOptions = {}): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "nexum-plugin-fixture-"));
  try {
    const pkg = {
      name: id,
      version,
      type: "module",
      main: "index.js",
      nexum: { permissions: { provide: ["greeting:*"] } },
      ...opts.pkg,
    };
    const files: Record<string, string> = {
      "package.json": JSON.stringify(pkg, null, 2),
      "index.js": pluginModule(id, version),
      ...opts.files,
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return packDirectory(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");
