/**
 * Tests for the GitMarketplaceSource.
 *
 * These tests verify the catalog discovery and download logic without
 * actually cloning a remote repo (the test creates a local "remote" git
 * repo in a temp directory and uses file:// URL).
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GitMarketplaceSource } from "../../src/marketplace/index.js";

describe("GitMarketplaceSource", () => {
  let tmpDir: string;
  let remoteRepoDir: string;
  let source: GitMarketplaceSource;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-mkt-test-"));
    remoteRepoDir = mkdtempSync(join(tmpdir(), "nexum-mkt-remote-"));
    // Initialize a git repo in remoteRepoDir.
    spawnSync("git", ["init"], { cwd: remoteRepoDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: remoteRepoDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: remoteRepoDir });
    source = new GitMarketplaceSource("test", `file://${remoteRepoDir}`, { cacheTtlMs: 0 });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(remoteRepoDir, { recursive: true, force: true });
  });

  describe("fetchCatalog", () => {
    it("returns empty array for empty repo", async () => {
      // Commit an empty repo.
      spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: remoteRepoDir });
      const entries = await source.fetchCatalog();
      expect(entries).toEqual([]);
    });

    it("discovers marketplace.json in repo root", async () => {
      const catalog = [
        {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.0.0",
          description: "A test plugin",
          tags: ["test"],
        },
      ];
      writeFileSync(join(remoteRepoDir, "marketplace.json"), JSON.stringify(catalog));
      spawnSync("git", ["add", "marketplace.json"], { cwd: remoteRepoDir });
      spawnSync("git", ["commit", "-m", "add catalog"], { cwd: remoteRepoDir });
      const entries = await source.fetchCatalog();
      expect(entries.length).toBe(1);
      expect(entries[0].id).toBe("test-plugin");
      expect(entries[0].source).toBe("test");
    });

    it("discovers per-directory plugin.json manifests", async () => {
      const pluginDir = join(remoteRepoDir, "my-plugin");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "plugin.json"),
        JSON.stringify({
          id: "my-plugin",
          name: "My Plugin",
          version: "2.0.0",
        }),
      );
      spawnSync("git", ["add", "."], { cwd: remoteRepoDir });
      spawnSync("git", ["commit", "-m", "add plugin"], { cwd: remoteRepoDir });
      const entries = await source.fetchCatalog();
      expect(entries.length).toBe(1);
      expect(entries[0].id).toBe("my-plugin");
      expect(entries[0].version).toBe("2.0.0");
    });

    it("skips corrupt marketplace.json", async () => {
      writeFileSync(join(remoteRepoDir, "marketplace.json"), "{not valid json");
      spawnSync("git", ["add", "."], { cwd: remoteRepoDir });
      spawnSync("git", ["commit", "-m", "corrupt catalog"], { cwd: remoteRepoDir });
      const entries = await source.fetchCatalog();
      expect(entries).toEqual([]);
    });
  });

  describe("fetchEntry", () => {
    it("finds an entry by id", async () => {
      const catalog = [{ id: "findable", name: "Findable", version: "1.0.0" }];
      writeFileSync(join(remoteRepoDir, "marketplace.json"), JSON.stringify(catalog));
      spawnSync("git", ["add", "."], { cwd: remoteRepoDir });
      spawnSync("git", ["commit", "-m", "add"], { cwd: remoteRepoDir });
      const entry = await source.fetchEntry("findable");
      expect(entry).toBeDefined();
      expect(entry?.id).toBe("findable");
    });

    it("returns undefined for unknown id", async () => {
      const catalog = [{ id: "other", name: "Other", version: "1.0.0" }];
      writeFileSync(join(remoteRepoDir, "marketplace.json"), JSON.stringify(catalog));
      spawnSync("git", ["add", "."], { cwd: remoteRepoDir });
      spawnSync("git", ["commit", "-m", "add"], { cwd: remoteRepoDir });
      const entry = await source.fetchEntry("nonexistent");
      expect(entry).toBeUndefined();
    });
  });

  describe("download", () => {
    it("tars a subdirectory from the cloned repo", async () => {
      // Set up a plugin subdir with content.
      const pluginDir = join(remoteRepoDir, "my-plugin");
      mkdirSync(pluginDir);
      writeFileSync(join(pluginDir, "SKILL.md"), "# My Plugin\n\nPlugin body.");
      writeFileSync(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ id: "my-plugin", name: "My Plugin", version: "1.0.0", downloadUrl: "my-plugin" }),
      );
      spawnSync("git", ["add", "."], { cwd: remoteRepoDir });
      spawnSync("git", ["commit", "-m", "add plugin"], { cwd: remoteRepoDir });

      const destPath = join(tmpDir, "plugin.tar.gz");
      const entry = {
        id: "my-plugin",
        name: "My Plugin",
        version: "1.0.0",
        downloadUrl: "my-plugin",
        source: "test",
      };
      await source.download(entry, destPath);
      // Verify the tarball was created.
      const { existsSync, statSync } = await import("node:fs");
      expect(existsSync(destPath)).toBe(true);
      expect(statSync(destPath).size).toBeGreaterThan(0);

      // Extract and verify contents.
      const extractDir = join(tmpDir, "extracted");
      mkdirSync(extractDir, { recursive: true });
      const result = spawnSync("tar", ["-xzf", destPath, "-C", extractDir]);
      expect(result.status).toBe(0);
      const { readFileSync } = await import("node:fs");
      const skillContent = readFileSync(join(extractDir, "SKILL.md"), "utf8");
      expect(skillContent).toContain("My Plugin");
    });
  });
});
