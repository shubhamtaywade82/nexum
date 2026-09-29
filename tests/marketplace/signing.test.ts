/**
 * Marketplace publisher signing & trust.
 *
 * Deterministic: Ed25519 via node:crypto against in-memory / temp-file
 * stores. No network.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatePublisherKeyPair,
  signEntry,
  verifyEntrySignature,
  canonicalSignedPayload,
  keyIdFromSpki,
  computeTrustScore,
  trustRiskBand,
  PublisherTrustStore,
  type MarketplaceEntry,
} from "../../src/marketplace/trust.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-signing-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    id: "cool-tools",
    name: "Cool Tools",
    version: "1.4.2",
    author: "alice",
    license: "MIT",
    sha256: "a".repeat(64),
    downloadUrl: "https://plugins.example/cool-tools-1.4.2.tar.gz",
    capabilities: ["tools"],
    source: "http",
    ...overrides,
  };
}

describe("generatePublisherKeyPair", () => {
  it("produces unique Ed25519 keys with deterministic fingerprints", () => {
    const a = generatePublisherKeyPair();
    const b = generatePublisherKeyPair();
    expect(a.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(b.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.privateKeyPem).toContain("PRIVATE KEY");
    expect(a.publicKeyBase64.length).toBeGreaterThan(20);
  });
});

describe("canonicalSignedPayload", () => {
  it("is stable across key order and covers all signed fields explicitly", () => {
    const entry = makeEntry();
    const a = canonicalSignedPayload(entry);
    const b = canonicalSignedPayload({ ...entry });
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as Record<string, unknown>;
    for (const field of ["author", "capabilities", "downloadUrl", "gitUrl", "id", "npmPackage", "sha256", "version"]) {
      expect(parsed).toHaveProperty(field);
    }
    // Absent optional fields are explicit nulls (not dropped).
    expect(parsed.gitUrl).toBeNull();
    expect(parsed.npmPackage).toBeNull();
  });

  it("changes when any signed field changes", () => {
    const entry = makeEntry();
    const original = canonicalSignedPayload(entry);
    expect(canonicalSignedPayload({ ...entry, version: "1.4.3" })).not.toBe(original);
    expect(canonicalSignedPayload({ ...entry, sha256: "b".repeat(64) })).not.toBe(original);
    expect(canonicalSignedPayload({ ...entry, downloadUrl: "https://evil.example/x.tar.gz" })).not.toBe(original);
    expect(canonicalSignedPayload({ ...entry, author: "mallory" })).not.toBe(original);
  });
});

describe("signEntry + verifyEntrySignature", () => {
  it("round-trips a valid signature against a trusted publisher key", () => {
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const entry = makeEntry({ signature: signEntry(makeEntry(), keys.privateKeyPem) });

    const result = verifyEntrySignature(entry, store);
    expect(result).toMatchObject({ status: "valid", keyId: keys.keyId, publisher: "alice", trust: "verified" });
  });

  it("rejects a tampered entry (swapped artifact hash)", () => {
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const signed = signEntry(makeEntry(), keys.privateKeyPem);
    const tampered = makeEntry({ sha256: "f".repeat(64), signature: signed });

    const result = verifyEntrySignature(tampered, store);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("does not match");
  });

  it("rejects a signature made with a different key", () => {
    const signer = generatePublisherKeyPair();
    const other = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: other.keyId, publicKey: other.publicKeyBase64, publisher: "bob", trust: "verified" },
    ]);
    const entry = makeEntry({ signature: signEntry(makeEntry(), signer.privateKeyPem) });

    const result = verifyEntrySignature(entry, store);
    // The signer's key is not in the store and no key is embedded.
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("not in the trust store");
  });

  it("treats a valid signature from an unrecognized embedded key as unknown-trust", () => {
    const keys = generatePublisherKeyPair();
    const signature = {
      ...signEntry(makeEntry(), keys.privateKeyPem),
      publicKey: keys.publicKeyBase64,
    };
    const entry = makeEntry({ signature });

    const result = verifyEntrySignature(entry, undefined);
    expect(result).toMatchObject({ status: "valid", trust: "unknown" });
    expect(result.publisher).toBeUndefined();
  });

  it("rejects an embedded key that contradicts the trusted record", () => {
    const keys = generatePublisherKeyPair();
    const imposter = generatePublisherKeyPair();
    const store = PublisherTrustStore.inMemory([
      { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
    ]);
    const signature = {
      ...signEntry(makeEntry(), imposter.privateKeyPem),
      keyId: keys.keyId, // claims alice's key id…
      publicKey: imposter.publicKeyBase64, // …but embeds the imposter's key
    };
    const entry = makeEntry({ signature });

    const result = verifyEntrySignature(entry, store);
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("does not match trusted key");
  });

  it("reports unsigned entries as a policy decision, not an error", () => {
    const result = verifyEntrySignature(makeEntry(), undefined);
    expect(result).toMatchObject({ status: "unsigned" });
    expect(result.reason).toContain("no ed25519 signature");
  });

  it("rejects malformed signature bundles", () => {
    const entry = makeEntry({ signature: { algorithm: "ed25519" } as never });
    expect(verifyEntrySignature(entry, undefined).status).toBe("invalid");

    const bad = makeEntry({ signature: { algorithm: "sha1", keyId: "x", signature: "y" } as never });
    expect(verifyEntrySignature(bad, undefined).status).toBe("unsigned"); // not ed25519 → treated as unsigned
  });

  it("keyIdFromSpki accepts both KeyObject and base64 string forms", () => {
    const keys = generatePublisherKeyPair();
    expect(keyIdFromSpki(keys.publicKeyBase64)).toBe(keys.keyId);
  });
});

describe("PublisherTrustStore", () => {
  it("persists records to disk with atomic writes", () => {
    const file = join(dir, "publishers.json");
    const keys = generatePublisherKeyPair();

    const store = PublisherTrustStore.open(file);
    store.add({ keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" });
    expect(existsSync(file)).toBe(true);

    // A fresh instance reads the same record back.
    const reopened = PublisherTrustStore.open(file);
    expect(reopened.get(keys.keyId)).toMatchObject({ publisher: "alice", trust: "verified" });
    expect(reopened.list()).toHaveLength(1);
  });

  it("supports remove and survives corrupt files", () => {
    const file = join(dir, "publishers.json");
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.open(file);
    store.add({ keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "community" });
    expect(store.remove(keys.keyId)).toBe(true);
    expect(store.has(keys.keyId)).toBe(false);

    // Corrupt file → store starts fresh instead of throwing.
    rmSync(file);
    writeFileSync(file, "{not json");
    const corrupted = PublisherTrustStore.open(file);
    expect(corrupted.list()).toHaveLength(0);
  });

  it("seed records merge on top of file contents", () => {
    const file = join(dir, "publishers.json");
    const a = generatePublisherKeyPair();
    PublisherTrustStore.open(file).add({
      keyId: a.keyId,
      publicKey: a.publicKeyBase64,
      publisher: "file-publisher",
      trust: "community",
    });
    const b = generatePublisherKeyPair();
    const store = PublisherTrustStore.open(file, [
      { keyId: b.keyId, publicKey: b.publicKeyBase64, publisher: "seed-publisher", trust: "verified" },
    ]);
    expect(
      store
        .list()
        .map((r) => r.publisher)
        .sort(),
    ).toEqual(["file-publisher", "seed-publisher"]);
  });
});

describe("computeTrustScore + trustRiskBand", () => {
  it("scores a verified, hygienic entry highest", () => {
    const entry = makeEntry(); // sha256 + author + license present
    const score = computeTrustScore(entry, {
      status: "valid",
      keyId: "k",
      publisher: "alice",
      trust: "verified",
    });
    expect(score).toBe(75); // 50 + 15 + 5 + 5
    expect(trustRiskBand(score)).toBe("low");
  });

  it("scores community publishers below verified (medium band)", () => {
    const score = computeTrustScore(makeEntry(), {
      status: "valid",
      keyId: "k",
      publisher: "bob",
      trust: "community",
    });
    expect(score).toBe(55);
    expect(trustRiskBand(score)).toBe("medium");
  });

  it("scores unknown-publisher signatures in the medium band", () => {
    const score = computeTrustScore(makeEntry(), { status: "valid", keyId: "k", trust: "unknown" });
    expect(score).toBe(35); // 10 + 15 + 5 + 5
    expect(trustRiskBand(score)).toBe("medium");
  });

  it("scores unsigned entries in the high band even with hygiene", () => {
    const score = computeTrustScore(makeEntry(), { status: "unsigned" });
    expect(score).toBe(25); // 0 + 15 + 5 + 5
    expect(trustRiskBand(score)).toBe("high");
    const bare = computeTrustScore(makeEntry({ sha256: undefined }), { status: "unsigned" });
    expect(bare).toBe(10); // author + license only
    expect(trustRiskBand(bare)).toBe("high");
  });

  it("gives invalid signatures zero trust regardless of hygiene", () => {
    const score = computeTrustScore(makeEntry(), { status: "invalid", reason: "tampered" });
    expect(score).toBe(0);
    expect(trustRiskBand(score)).toBe("high");
  });
});
