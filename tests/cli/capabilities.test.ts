import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCapabilities,
  commandOnPath,
  formatCapability,
  startupWarnings,
  type CapabilityInputs,
} from "../../src/cli/capabilities.js";

const PROVIDERS = [
  { language: "TypeScript", serverCommand: "typescript-language-server" },
  { language: "Ruby", serverCommand: "ruby-lsp" },
  { language: "Go", serverCommand: "gopls" },
];

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "caps-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function inputs(root: string, over: Partial<CapabilityInputs> = {}): CapabilityInputs {
  return {
    workspaceRoot: root,
    sandbox: { enabled: true, image: "nexum-sandbox:latest", imageReady: true },
    railsIndexEnabled: false,
    lspProviders: PROVIDERS,
    docsCached: [],
    mcpServersConfigured: 0,
    localWorkerEnabled: true,
    dockerToolEnabled: false,
    commandExists: () => true,
    chromiumInstalled: () => true,
    githubRemote: () => false,
    ...over,
  };
}

const ids = (caps: { id: string }[]) => caps.map((c) => c.id);

describe("collectCapabilities", () => {
  it("reports only the language servers this workspace uses", async () => {
    const root = workspace({ "package.json": JSON.stringify({ devDependencies: { typescript: "5" } }) });
    const caps = await collectCapabilities(inputs(root));
    expect(ids(caps)).toContain("lsp:TypeScript");
    expect(ids(caps)).not.toContain("lsp:Ruby");
    expect(ids(caps)).not.toContain("lsp:Go");
  });

  it("flags a missing language server as degraded with a fix", async () => {
    const root = workspace({ "go.mod": "module x" });
    const caps = await collectCapabilities(inputs(root, { commandExists: (c) => c !== "gopls" }));
    const go = caps.find((c) => c.id === "lsp:Go");
    expect(go).toMatchObject({ state: "degraded" });
    expect(go?.fix).toMatch(/gopls/);
    expect(startupWarnings(caps).map((c) => c.id)).toContain("lsp:Go");
  });

  it("marks the sandbox degraded when the image is unavailable and off when disabled", async () => {
    const root = workspace({});
    const degraded = await collectCapabilities(
      inputs(root, { sandbox: { enabled: true, image: "img", imageReady: false } }),
    );
    expect(degraded.find((c) => c.id === "sandbox")).toMatchObject({ state: "degraded" });
    expect(degraded.find((c) => c.id === "sandbox")?.fix).toContain("docker build");

    const off = await collectCapabilities(
      inputs(root, { sandbox: { enabled: false, image: "img", imageReady: undefined } }),
    );
    expect(off.find((c) => c.id === "sandbox")?.state).toBe("off");
    expect(startupWarnings(off)).toEqual([]);
  });

  it("only mentions GitHub for repos with a github remote", async () => {
    const root = workspace({});
    expect(ids(await collectCapabilities(inputs(root)))).not.toContain("github");
    const caps = await collectCapabilities(
      inputs(root, { githubRemote: () => true, commandExists: (c) => c !== "gh" }),
    );
    expect(caps.find((c) => c.id === "github")).toMatchObject({ state: "degraded" });
  });

  it("does not warn at startup about a missing browser", async () => {
    const root = workspace({});
    const caps = await collectCapabilities(inputs(root, { chromiumInstalled: () => false }));
    expect(caps.find((c) => c.id === "browser")?.state).toBe("degraded");
    expect(startupWarnings(caps).map((c) => c.id)).not.toContain("browser");
  });

  it("describes docs scoping from the detected stack", async () => {
    const root = workspace({ "package.json": JSON.stringify({ dependencies: { react: "18" } }) });
    const docs = (await collectCapabilities(inputs(root, { docsCached: ["react"] }))).find((c) => c.id === "docs");
    expect(docs?.detail).toContain("1 source(s) cached");
    expect(docs?.detail).toContain("react");
  });

  it("includes Rails only when the index is enabled", async () => {
    const root = workspace({});
    expect(ids(await collectCapabilities(inputs(root)))).not.toContain("rails");
    expect(ids(await collectCapabilities(inputs(root, { railsIndexEnabled: true })))).toContain("rails");
  });

  it("formats a degraded capability with its fix", () => {
    expect(formatCapability({ id: "x", label: "X", state: "degraded", detail: "broken", fix: "repair" })).toBe(
      "X: degraded — broken (fix: repair)",
    );
  });
});

describe("commandOnPath", () => {
  it("finds an executable on PATH and rejects a missing one", () => {
    expect(commandOnPath("node")).toBe(true);
    expect(commandOnPath("definitely-not-a-real-binary-xyz")).toBe(false);
    expect(commandOnPath("node", "")).toBe(false);
  });
});
