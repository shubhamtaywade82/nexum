/**
 * A hardlink is the same file under another name: aliases of secrets (in the
 * workspace or in credential stores like ~/.ssh) are treated as secrets.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGuard } from "../../src/core/fs/workspace-guard.js";
import { ReadFileTool, SensitivePathError } from "../../src/tools/filesystem.js";
import { CopyFileTool } from "../../src/tools/directory-tools.js";
import { SearchCodeTool } from "../../src/tools/search-tools.js";
import { ShellTool } from "../../src/tools/shell.js";
import { DockerTool } from "../../src/tools/docker-tools.js";

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  // one temp tree so workspace and "home" share a filesystem (hardlinks cannot cross devices)
  base = realpathSync(mkdtempSync(join(tmpdir(), "nexum-hardlink-")));
  root = join(base, "ws");
  home = join(base, "home");
  mkdirSync(root);
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY NEEDLE\n");
  writeFileSync(join(root, ".env"), "API_KEY=sk-live NEEDLE\n");
  writeFileSync(join(root, "app.ts"), "const NEEDLE = 1;\n");
  linkSync(join(root, ".env"), join(root, "notes.txt"));
  linkSync(join(home, ".ssh", "id_ed25519"), join(root, "deploy-key.txt"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function guard(): WorkspaceGuard {
  return new WorkspaceGuard({ root, protectSensitiveReads: true, credentialLocations: [join(home, ".ssh")] });
}

describe("hardlinked secrets", () => {
  it("the guard treats aliases of workspace and home-directory secrets as secrets", () => {
    const g = guard();
    expect(g.check("read", "notes.txt").code).toBe("sensitive_path");
    expect(g.check("read", "deploy-key.txt").code).toBe("sensitive_path");
    expect(g.check("copy", "deploy-key.txt").code).toBe("sensitive_path");
    expect(g.check("read", "app.ts").allowed).toBe(true);
  });

  it("ordinary hardlinks between non-secret files stay readable", () => {
    linkSync(join(root, "app.ts"), join(root, "app-copy.ts"));
    expect(guard().check("read", "app-copy.ts").allowed).toBe(true);
  });

  it("read_file and copy_file refuse aliases", async () => {
    await expect(new ReadFileTool(guard()).call({ path: "notes.txt" })).rejects.toThrow(SensitivePathError);
    await expect(new CopyFileTool(guard()).call({ source: "deploy-key.txt", destination: "leak.txt" })).rejects.toThrow(
      SensitivePathError,
    );
  });

  it("search_code drops lines from aliases", async () => {
    const result = (await new SearchCodeTool(guard()).call({ query: "NEEDLE" })) as {
      matches: Array<{ path: string }>;
    };
    expect(result.matches.map((m) => m.path)).toEqual(["app.ts"]);
  });

  it("the shell sandbox masks aliases of workspace secrets", () => {
    const args = (
      new ShellTool({ workspaceRoot: root }) as unknown as { dockerArgs: (c: string, cmd: string) => string[] }
    ).dockerArgs("c1", "cat notes.txt");
    expect(args).toContain("type=bind,source=/dev/null,target=/workspace/notes.txt,readonly");
  });

  it("docker build refuses a context holding an alias of a secret that lives outside the context", () => {
    mkdirSync(join(root, "keys"));
    writeFileSync(join(root, "keys", "server.key"), "KEY");
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "Dockerfile"), "FROM alpine\n");
    expect(new DockerTool(root).plan(["build", "app"]).ok).toBe(true);

    linkSync(join(root, "keys", "server.key"), join(root, "app", "readme-copy.txt"));
    const plan = new DockerTool(root).plan(["build", "app"]);
    expect(plan.ok).toBe(false);
    expect(plan.ok ? "" : plan.message).toContain("readme-copy.txt");
  });
});
