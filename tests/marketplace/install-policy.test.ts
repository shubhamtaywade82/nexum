/**
 * MarketplaceService install policy — how publisher signatures gate installs.
 *
 * Uses a fake MarketplaceSource writing real artifacts to a temp root so the
 * full install path (trust gate → download → integrity → record) is exercised
 * without network.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketplaceService, type MarketplaceEntry, type MarketplaceSource } from "../../src/marketplace/index.js";
import { generatePublisherKeyPair, signEntry, PublisherTrustStore } from "../../src/marketplace/trust.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-install-policy-"));
  root = join(dir, ".nexum");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Fake source: "downloads" by writing a deterministic artifact to disk. */
class FakeSource implements MarketplaceSource {
  readonly id = "fake";
  downloads = 0;

  async fetchCatalog(): Promise<MarketplaceEntry[]> {
    return [];
  }

  async fetchEntry(id: string): Promise<MarketplaceEntry | undefined> {
    return { id, name: id, version: "1.0.0", source: this.id };
  }

  async download(entry: MarketplaceEntry, destPath: string): Promise<void> {
    this.downloads++;
    writeFileSync(destPath, `artifact-bytes:${entry.id}:${entry.version}`);
  }
}

function entryFor(source: FakeSource, overrides: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  const merged: MarketplaceEntry = {
    id: "cool-tools",
    name: "Cool Tools",
    version: "1.4.2",
    source: source.id,
    author: "alice",
    license: "MIT",
    ...overrides,
  };
  const artifact = `artifact-bytes:${merged.id}:${merged.version}`;
  return {
    ...merged,
    sha256: "sha256" in overrides ? overrides.sha256 : createHash("sha256").update(artifact).digest("hex"),
  };
}

describe("MarketplaceService install policy", () => {
  it("default (warn) records verification for signed entries and still installs unsigned ones", async () => {
    const source = new FakeSource();
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const service = new MarketplaceService({ rootDir: root, sources: [source], installPolicy: { trustStore: store } });

    const signedEntry = entryFor(source, {
      signature: signEntry(entryFor(source), keys.privateKeyPem),
      publisher: "alice",
    });
    const signed = await service.install(signedEntry);
    expect(signed.verification).toMatchObject({ status: "valid", publisher: "alice", trust: "verified" });
    expect(signed.trustScore).toBe(75);
    expect(signed.publisher).toBe("alice");

    const unsigned = await service.install(entryFor(source, { id: "unsigned-tool", version: "0.1.0" }));
    expect(unsigned.verification).toMatchObject({ status: "unsigned" });
    expect(unsigned.trustScore).toBe(25);
    expect(service.isInstalled("unsigned-tool")).toBe(true);
  });

  it("default (warn) REJECTS a tampered signature even in warn mode", async () => {
    const source = new FakeSource();
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const service = new MarketplaceService({ rootDir: root, sources: [source], installPolicy: { trustStore: store } });

    const goodEntry = entryFor(source);
    const tampered = entryFor(source, {
      // Signature covers the ORIGINAL hash; swapping it breaks the signature.
      sha256: "0".repeat(64),
      signature: signEntry(goodEntry, keys.privateKeyPem),
    });
    await expect(service.install(tampered)).rejects.toThrow(/install policy rejected/);
    expect(service.isInstalled("cool-tools")).toBe(false);
    expect(source.downloads).toBe(0); // rejected BEFORE download
  });

  it("require mode rejects unsigned entries", async () => {
    const source = new FakeSource();
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "community" },
    ]);
    const service = new MarketplaceService({
      rootDir: root,
      sources: [source],
      installPolicy: { signatures: "require", trustStore: store },
    });

    await expect(service.install(entryFor(source))).rejects.toThrow(/unsigned and policy requires signatures/);

    // A community-signed entry passes "require" (integrity, not identity).
    const goodEntry = entryFor(source);
    const signed = await service.install(entryFor(source, { signature: signEntry(goodEntry, keys.privateKeyPem) }));
    expect(signed.verification).toMatchObject({ status: "valid", trust: "community" });
  });

  it("require-verified mode rejects non-verified publishers", async () => {
    const source = new FakeSource();
    const keys = generatePublisherKeyPair();
    const communityStore = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "bob", trust: "community" },
    ]);
    const service = new MarketplaceService({
      rootDir: root,
      sources: [source],
      installPolicy: { signatures: "require-verified", trustStore: communityStore },
    });

    const goodEntry = entryFor(source);
    await expect(
      service.install(entryFor(source, { signature: signEntry(goodEntry, keys.privateKeyPem) })),
    ).rejects.toThrow(/policy requires "verified"/);
  });

  it("require-verified mode accepts verified publishers", async () => {
    const source = new FakeSource();
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const service = new MarketplaceService({
      rootDir: root,
      sources: [source],
      installPolicy: { signatures: "require-verified", trustStore: store },
    });

    const goodEntry = entryFor(source);
    const record = await service.install(
      entryFor(source, { signature: signEntry(goodEntry, keys.privateKeyPem), publisher: "alice" }),
    );
    expect(record.verification?.status).toBe("valid");
    expect(record.publisher).toBe("alice");
  });

  it("off mode skips verification entirely (no verification recorded)", async () => {
    const source = new FakeSource();
    const service = new MarketplaceService({
      rootDir: root,
      sources: [source],
      installPolicy: { signatures: "off" },
    });

    const goodEntry = entryFor(source);
    // A garbage signature is ignored entirely in "off" mode.
    const consistent = entryFor(source, { signature: signEntry(goodEntry, generatePublisherKeyPair().privateKeyPem) });
    const record = await service.install(consistent);
    expect(record.verification).toBeUndefined();
    expect(record.trustScore).toBeUndefined();
  });

  it("requireSha256 demands an artifact hash before download", async () => {
    const source = new FakeSource();
    const service = new MarketplaceService({
      rootDir: root,
      sources: [source],
      installPolicy: { requireSha256: true },
    });
    await expect(
      service.install(entryFor(source, { sha256: undefined, id: "hashless", version: "0.0.1" })),
    ).rejects.toThrow(/no sha256 artifact hash/);
    expect(source.downloads).toBe(0);
  });

  it("persisted installed.json round-trips verification metadata", async () => {
    const source = new FakeSource();
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const service = new MarketplaceService({ rootDir: root, sources: [source], installPolicy: { trustStore: store } });
    const goodEntry = entryFor(source);
    await service.install(entryFor(source, { signature: signEntry(goodEntry, keys.privateKeyPem) }));

    const raw = JSON.parse(readFileSync(join(root, "plugins", "installed.json"), "utf8")) as Array<{
      verification?: { status: string };
      trustScore?: number;
    }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].verification?.status).toBe("valid");
    expect(raw[0].trustScore).toBe(75);
  });

  describe("verifyInstalled", () => {
    it("confirms the on-disk artifact still hashes to the recorded value", async () => {
      const source = new FakeSource();
      const service = new MarketplaceService({ rootDir: root, sources: [source] });
      await service.install(entryFor(source));

      expect(service.verifyInstalled("cool-tools")).toEqual({ ok: true });
    });

    it("detects artifact tampering after install", async () => {
      const source = new FakeSource();
      const service = new MarketplaceService({ rootDir: root, sources: [source] });
      const record = await service.install(entryFor(source));

      writeFileSync(join(record.path, "plugin.tar.gz"), "tampered-bytes");
      const result = service.verifyInstalled("cool-tools");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("hash drift");
    });

    it("detects a missing artifact and missing plugins", async () => {
      const source = new FakeSource();
      const service = new MarketplaceService({ rootDir: root, sources: [source] });
      expect(service.verifyInstalled("never-installed")).toEqual({ ok: false, reason: "not installed" });

      const record = await service.install(entryFor(source));
      rmSync(join(record.path, "plugin.tar.gz"));
      const result = service.verifyInstalled("cool-tools");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("artifact missing");
    });
  });
});
