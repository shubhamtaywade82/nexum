/**
 * Tests for the ProfileRegistry, ProfileLoader, ProfileComposer.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceStateDir } from "../../src/platform/paths.js";
import {
  ProfileRegistry,
  ProfileLoader,
  ProfileComposer,
  ProfileResolver,
  registerBuiltinProfiles,
  cliProfileBundle,
  serverProfileBundle,
  cryptoBotProfileBundle,
  type ProfileBundle,
} from "../../src/profiles/index.js";

describe("ProfileRegistry", () => {
  let registry: ProfileRegistry;

  beforeEach(() => {
    registry = new ProfileRegistry();
  });

  it("registers and retrieves a profile", () => {
    registry.register(cliProfileBundle());
    expect(registry.has("nexum-cli")).toBe(true);
    expect(registry.get("nexum-cli")?.bundle.name).toBe("Nexum CLI");
  });

  it("throws on duplicate registration", () => {
    registry.register(cliProfileBundle());
    expect(() => registry.register(cliProfileBundle())).toThrow(/already registered/);
  });

  it("require throws with helpful message for unknown profile", () => {
    registry.register(cliProfileBundle());
    expect(() => registry.require("nonexistent")).toThrow(/unknown profile.*nexum-cli/);
  });

  it("lists all profiles", () => {
    registerBuiltinProfiles(registry);
    const ids = registry.ids();
    expect(ids).toContain("nexum-cli");
    expect(ids).toContain("nexum-server");
    expect(ids).toContain("nexum-crypto-bot");
  });

  it("filters by tag", () => {
    registerBuiltinProfiles(registry);
    const serverProfiles = registry.byTag("server");
    expect(serverProfiles.length).toBe(1);
    expect(serverProfiles[0].bundle.id).toBe("nexum-server");
  });

  it("filters by capability", () => {
    registerBuiltinProfiles(registry);
    const cryptoProfiles = registry.byCapability("crypto");
    expect(cryptoProfiles.length).toBe(1);
    expect(cryptoProfiles[0].bundle.id).toBe("nexum-crypto-bot");
  });

  it("unregisters a profile", () => {
    registry.register(cliProfileBundle());
    expect(registry.unregister("nexum-cli")).toBe(true);
    expect(registry.has("nexum-cli")).toBe(false);
  });
});

describe("ProfileLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-profiles-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads profiles from .nexum/profiles/", () => {
    const profilesDir = join(workspaceStateDir(tmpDir), "profiles");
    mkdirSync(profilesDir, { recursive: true });
    const bundle: ProfileBundle = {
      id: "user-profile",
      name: "User Profile",
      version: "1.0.0",
      plugins: [],
      capabilities: ["custom"],
      tags: ["user"],
    };
    writeFileSync(join(profilesDir, "user-profile.json"), JSON.stringify(bundle));

    const loader = new ProfileLoader({ workspaceRoot: tmpDir });
    const records = loader.load();
    expect(records.length).toBe(1);
    expect(records[0].bundle.id).toBe("user-profile");
    expect(records[0].source).toBe("user");
  });

  it("returns empty array when no profiles dir", () => {
    const loader = new ProfileLoader({ workspaceRoot: tmpDir });
    expect(loader.load().length).toBe(0);
  });

  it("skips corrupt files", () => {
    const profilesDir = join(workspaceStateDir(tmpDir), "profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "corrupt.json"), "{not json");
    const loader = new ProfileLoader({ workspaceRoot: tmpDir });
    expect(loader.load().length).toBe(0);
  });
});

describe("ProfileComposer", () => {
  it("composes multiple profiles", () => {
    const registry = new ProfileRegistry();
    registry.register({
      id: "base",
      name: "Base",
      version: "1.0.0",
      plugins: [],
      capabilities: ["cli"],
      tags: ["interactive"],
    });
    registry.register({
      id: "ext",
      name: "Ext",
      version: "1.0.0",
      plugins: [],
      capabilities: ["crypto"],
      tags: ["trading"],
      settings: { "ui.theme": "dark" },
    });

    const composed = ProfileComposer.compose(registry, ["base", "ext"]);
    expect(composed.capabilities).toContain("cli");
    expect(composed.capabilities).toContain("crypto");
    expect(composed.tags).toContain("interactive");
    expect(composed.tags).toContain("trading");
    expect(composed.settings["ui.theme"]).toBe("dark");
    expect(composed.sources).toEqual(["base", "ext"]);
  });

  it("respects dependsOn order", () => {
    const registry = new ProfileRegistry();
    registry.register({
      id: "child",
      name: "Child",
      version: "1.0.0",
      plugins: [],
      dependsOn: ["parent"],
    });
    registry.register({
      id: "parent",
      name: "Parent",
      version: "1.0.0",
      plugins: [],
    });
    const composed = ProfileComposer.compose(registry, ["child", "parent"]);
    // Parent should come before child due to dependsOn.
    expect(composed.sources.indexOf("parent")).toBeLessThan(composed.sources.indexOf("child"));
  });
});

describe("ProfileResolver", () => {
  it("resolves a composed profile to plugins + settings", () => {
    const composed = {
      plugins: [],
      settings: { "ui.theme": "dark" },
      capabilities: ["cli"],
      tags: [],
      sources: ["test"],
    };
    const resolved = ProfileResolver.resolve(composed);
    expect(resolved.plugins).toEqual([]);
    expect(resolved.settings["ui.theme"]).toBe("dark");
  });
});

describe("built-in profile bundles", () => {
  it("cliProfileBundle has expected shape", () => {
    const b = cliProfileBundle();
    expect(b.id).toBe("nexum-cli");
    expect(b.capabilities).toContain("cli");
  });

  it("serverProfileBundle has expected shape", () => {
    const b = serverProfileBundle();
    expect(b.id).toBe("nexum-server");
    expect(b.capabilities).toContain("rpc");
  });

  it("cryptoBotProfileBundle depends on server", () => {
    const b = cryptoBotProfileBundle();
    expect(b.id).toBe("nexum-crypto-bot");
    expect(b.dependsOn).toContain("nexum-server");
  });
});
