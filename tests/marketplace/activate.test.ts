/**
 * Marketplace install → activate: the plugin really runs, in a separate
 * Node process under the permission model, only after the signature (against
 * the current trust store) and the artifact hash are re-checked.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_FILE,
  MarketplaceService,
  type MarketplaceEntry,
  type MarketplaceSource,
} from "../../src/marketplace/index.js";
import { generatePublisherKeyPair, signEntry, PublisherTrustStore } from "../../src/marketplace/trust.js";
import { DefaultPluginHost } from "../../src/platform/plugins/host.js";
import type { PluginLogger } from "../../src/platform/plugins/types.js";
import { pluginArtifact, pluginModule, sha256, type FixtureOptions } from "./plugin-fixture.js";

let dir: string;
let root: string;
const TIMEOUT = 30_000;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "nexum-activate-")));
  root = join(dir, ".nexum");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const quiet: PluginLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

class ArtifactSource implements MarketplaceSource {
  readonly id = "fixture";
  constructor(private readonly artifacts: Map<string, Buffer>) {}
  async fetchCatalog(): Promise<MarketplaceEntry[]> {
    return [];
  }
  async fetchEntry(): Promise<MarketplaceEntry | undefined> {
    return undefined;
  }
  async download(entry: MarketplaceEntry, destPath: string): Promise<void> {
    const artifact = this.artifacts.get(`${entry.id}@${entry.version}`);
    if (!artifact) throw new Error("no such artifact");
    writeFileSync(destPath, artifact);
  }
}

function setup(id = "hello-plugin", version = "1.0.0", opts: FixtureOptions = {}) {
  const artifact = pluginArtifact(id, version, opts);
  const source = new ArtifactSource(new Map([[`${id}@${version}`, artifact]]));
  const keys = generatePublisherKeyPair();
  const trustStore = PublisherTrustStore.inMemory([
    { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
  ]);
  const unsigned: MarketplaceEntry = { id, name: id, version, source: source.id, sha256: sha256(artifact) };
  const entry = { ...unsigned, signature: signEntry(unsigned, keys.privateKeyPem) };
  const service = new MarketplaceService({ rootDir: root, sources: [source], installPolicy: { trustStore } });
  return { service, entry, keys, trustStore };
}

const tempPluginDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith("nexum-plugin-") && !n.includes("fixture"));

describe("install validates the package", () => {
  it("records the entry module and declared permissions", async () => {
    const { service, entry } = setup();
    const record = await service.install(entry);
    expect(record).toMatchObject({ main: "index.js", permissions: { provide: ["greeting:*"] } });
    expect(record.entry?.signature).toBeDefined();
    expect(existsSync(join(record.path, ARTIFACT_FILE))).toBe(true);
  });

  it.each([
    ["no nexum field", { pkg: { nexum: undefined } }, /no "nexum" object/],
    ["id mismatch", { pkg: { name: "other-plugin" } }, /declares id "other-plugin"/],
    ["version mismatch", { pkg: { version: "9.9.9" } }, /package version 9.9.9/],
    ["main outside the package", { pkg: { main: "../../evil.js" } }, /outside the package/],
    ["main missing", { pkg: { main: "dist/index.js" } }, /not found in the artifact/],
    ["bad permissions", { pkg: { nexum: { permissions: { lookup: "*" } } } }, /must be an array/],
  ])("rejects a package with %s", async (_label, opts, error) => {
    const { service, entry } = setup("hello-plugin", "1.0.0", opts as FixtureOptions);
    await expect(service.install(entry)).rejects.toThrow(error);
    expect(service.isInstalled("hello-plugin")).toBe(false);
  });

  it("rejects ids and versions that would escape the cache directory", async () => {
    const { service, entry } = setup();
    await expect(service.install({ ...entry, id: "../../evil" })).rejects.toThrow(/invalid plugin id/);
    await expect(service.install({ ...entry, version: "../1" })).rejects.toThrow(/invalid version/);
  });
});

describe("activate", () => {
  it(
    "runs the plugin in a separate process and bridges its capabilities to the host",
    async () => {
      const { service, entry } = setup();
      await service.install(entry);
      const before = tempPluginDirs().length;
      const plugin = await service.activate("hello-plugin");
      expect(tempPluginDirs().length).toBe(before + 1);

      const host = new DefaultPluginHost({ logger: quiet });
      host.register(plugin);
      await host.start();
      expect(host.lookup("greeting:hello-plugin")).toBe("hello");
      await host.stop();
      expect(plugin.sandbox.terminated()).toBe(true);
      expect(tempPluginDirs().length).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "the plugin cannot read outside its package, write, spawn processes or see the host environment",
    async () => {
      const secret = join(dir, "secret.txt");
      writeFileSync(secret, "TOP SECRET");
      const probe = `
        const fs = await import("node:fs");
        const cp = await import("node:child_process");
        const attempt = (fn) => { try { fn(); return "ALLOWED"; } catch (e) { return e.code ?? String(e); } };
        ctx.provide("probe:result", JSON.stringify({
          read: attempt(() => fs.readFileSync(${JSON.stringify(secret)}, "utf8")),
          write: attempt(() => fs.writeFileSync(${JSON.stringify(join(dir, "pwned.txt"))}, "x")),
          spawn: attempt(() => cp.execSync("id")),
          env: Object.keys(process.env).filter((k) => k !== "NEXUM_PLUGIN_DATA"),
        }));`;
      const { service, entry } = setup("probe-plugin", "1.0.0", {
        pkg: { nexum: { permissions: { provide: ["probe:*"] } } },
        files: { "index.js": pluginModule("probe-plugin", "1.0.0", probe) },
      });
      await service.install(entry);
      const host = new DefaultPluginHost({ logger: quiet });
      host.register(await service.activate("probe-plugin"));
      await host.start();
      const result = JSON.parse(host.lookup<string>("probe:result")!);
      await host.stop();
      expect(result).toEqual({
        read: "ERR_ACCESS_DENIED",
        write: "ERR_ACCESS_DENIED",
        spawn: "ERR_ACCESS_DENIED",
        env: [],
      });
      expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "capabilities outside the declared permissions are denied",
    async () => {
      const { service, entry } = setup("greedy-plugin", "1.0.0", {
        files: {
          "index.js": pluginModule("greedy-plugin", "1.0.0", `await ctx.provide("model:default", "hijacked");`),
        },
      });
      await service.install(entry);
      const plugin = await service.activate("greedy-plugin");
      const host = new DefaultPluginHost({ logger: quiet });
      host.register(plugin);
      await host.start();
      expect(host.lookup("model:default")).toBeUndefined();
      expect(plugin.sandbox.audit()).toEqual([
        expect.objectContaining({ operation: "provide", target: "model:default", decision: "denied" }),
      ]);
      await host.stop();
    },
    TIMEOUT,
  );

  it("refuses when the publisher key was removed from the trust store after install", async () => {
    const { service, entry, keys, trustStore } = setup();
    await service.install(entry);
    trustStore.remove(keys.keyId);
    await expect(service.activate("hello-plugin")).rejects.toThrow(/install policy rejected/);
  });

  it("refuses a tampered artifact", async () => {
    const { service, entry } = setup();
    const record = await service.install(entry);
    writeFileSync(
      join(record.path, ARTIFACT_FILE),
      pluginArtifact("hello-plugin", "1.0.0", { files: { "index.js": "evil" } }),
    );
    await expect(service.activate("hello-plugin")).rejects.toThrow(/hash drift/);
  });

  it("refuses a record edited to point at a different entry", async () => {
    const { service, entry } = setup();
    const record = await service.install(entry);
    record.entry = { ...record.entry!, sha256: "0".repeat(64) };
    await expect(service.activate("hello-plugin")).rejects.toThrow(/install policy rejected/);
  });

  it(
    "refuses a module whose manifest does not match the installed id",
    async () => {
      const { service, entry } = setup("hello-plugin", "1.0.0", {
        files: { "index.js": pluginModule("impostor", "1.0.0") },
      });
      await service.install(entry);
      const before = tempPluginDirs().length;
      await expect(service.activate("hello-plugin")).rejects.toThrow(/declares impostor@1.0.0/);
      expect(tempPluginDirs().length).toBe(before);
    },
    TIMEOUT,
  );
});
