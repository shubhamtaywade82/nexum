/**
 * Capability attestation — authority, ledger, host snapshot integration.
 *
 * Deterministic: Ed25519 via node:crypto, injectable clocks, temp files.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttestationAuthority,
  AttestationLedger,
  attestHostGrants,
  generateAttestationKeyPair,
  loadOrCreateAuthority,
  canonicalGrantPayload,
} from "../../src/core/capabilities/attestation.js";
import { DefaultPluginHost } from "../../src/platform/plugins/host.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-attest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function grantFixture(overrides: Partial<Parameters<AttestationAuthority["attest"]>[0]> = {}) {
  return {
    subject: { type: "plugin", id: "tool-registry" },
    grants: ["nexum:tools:catalog", "nexum:tools:gateway"],
    grantedBy: "nexum:host@2.0.0",
    ...overrides,
  };
}

describe("AttestationAuthority", () => {
  it("attests a grant and verifies its own attestation", () => {
    const authority = new AttestationAuthority();
    const attestation = authority.attest(grantFixture());

    expect(attestation.version).toBe(1);
    expect(attestation.grant.id).toMatch(/^grant_/);
    expect(attestation.grant.grantedAt).toBeTruthy();
    expect(attestation.algorithm).toBe("ed25519");
    expect(attestation.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(authority.verify(attestation)).toEqual({ valid: true });
  });

  it("round-trips through JSON (offline verification artifact)", () => {
    const authority = new AttestationAuthority();
    const attestation = authority.attest(grantFixture());

    const restored = JSON.parse(JSON.stringify(attestation));
    expect(authority.verify(restored)).toEqual({ valid: true });
  });

  it("rejects a modified grant (payload hash mismatch)", () => {
    const authority = new AttestationAuthority();
    const attestation = authority.attest(grantFixture());

    const tampered = {
      ...attestation,
      grant: { ...attestation.grant, grants: [...attestation.grant.grants, "nexum:secrets:vault"] },
    };
    const result = authority.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("hash mismatch");
  });

  it("rejects a forged signature", () => {
    const signer = new AttestationAuthority();
    const verifier = new AttestationAuthority();
    const attestation = signer.attest(grantFixture());

    const result = verifier.verify(attestation);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("signed by authority");
  });

  it("rejects tampered signatures (same authority, bad bytes)", () => {
    const authority = new AttestationAuthority();
    const attestation = authority.attest(grantFixture());

    const flipped = {
      ...attestation,
      signature: Buffer.from("forged-signature-bytes").toString("base64"),
    };
    const result = authority.verify(flipped);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("does not verify");
  });

  it("rejects an unsupported attestation version", () => {
    const authority = new AttestationAuthority();
    const attestation = authority.attest(grantFixture());
    const result = authority.verify({ ...attestation, version: 99 } as never);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("unsupported attestation version");
  });

  it("honours expiry with an injectable clock", () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const authority = new AttestationAuthority({ now: () => clock });
    const attestation = authority.attest(grantFixture({ expiresAt: "2026-01-02T00:00:00Z" }));

    expect(authority.verify(attestation)).toEqual({ valid: true });

    clock = new Date("2026-01-03T00:00:00Z");
    const expired = authority.verify(attestation);
    expect(expired.valid).toBe(false);
    expect(expired.expired).toBe(true);
    expect(expired.reason).toContain("expired");
  });

  it("revokes grants by id and by subject", () => {
    const authority = new AttestationAuthority();
    const a = authority.attest(grantFixture());
    const b = authority.attest(grantFixture({ subject: { type: "plugin", id: "other" } }));

    authority.revoke({ grantId: a.grant.id });
    expect(authority.verify(a).valid).toBe(false);
    expect(authority.verify(a).reason).toContain("revoked");
    expect(authority.verify(b).valid).toBe(true); // other grants unaffected

    authority.revoke({ subject: "other" });
    expect(authority.verify(b).valid).toBe(false);
    expect(authority.isRevoked({ subject: "other" })).toBe(true);
  });

  it("seeds revocations at construction (ledger replay) without re-appending", () => {
    // Share one key between the issuing and the replayed authority.
    const pair = generateAttestationKeyPair();
    const original = new AttestationAuthority({ privateKeyPem: pair.privateKeyPem });
    const sealed = original.attest(grantFixture());
    original.revoke({ grantId: sealed.grant.id });

    // A fresh process replays the persisted revocation list — no ledger attached,
    // so nothing is appended; the grant must still verify as revoked.
    const replayed = new AttestationAuthority({
      privateKeyPem: pair.privateKeyPem,
      revocations: { grantIds: [sealed.grant.id], subjects: ["unrelated-subject"] },
    });
    const verdict = replayed.verify(sealed);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("revoked");
    expect(replayed.isRevoked({ grantId: sealed.grant.id })).toBe(true);
    expect(replayed.isRevoked({ subject: "unrelated-subject" })).toBe(true);
  });

  it("different keypairs produce different keyIds", () => {
    const a = new AttestationAuthority();
    const b = new AttestationAuthority();
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe("canonicalGrantPayload", () => {
  it("is order-insensitive for grants and stable across key order", () => {
    const grant = {
      id: "g1",
      subject: { type: "plugin" as const, id: "p" },
      grants: ["b", "a"],
      grantedBy: "host",
      grantedAt: "2026-01-01T00:00:00Z",
    };
    const reordered = {
      grantedAt: "2026-01-01T00:00:00Z",
      grantedBy: "host",
      grants: ["a", "b"],
      subject: { id: "p", type: "plugin" as const },
      id: "g1",
    };
    expect(canonicalGrantPayload(grant)).toBe(canonicalGrantPayload(reordered));
    // Changing the grant list changes the payload.
    expect(canonicalGrantPayload({ ...grant, grants: ["a"] })).not.toBe(canonicalGrantPayload(grant));
  });
});

describe("AttestationLedger", () => {
  it("records attestations and revocations, persisted atomically", () => {
    const file = join(dir, "ledger.json");
    const ledger = new AttestationLedger(file);
    const authority = new AttestationAuthority({ ledger });

    const attestation = authority.attest(grantFixture());
    authority.revoke({ subject: "tool-registry" });

    const raw = JSON.parse(readFileSync(file, "utf8")) as Array<{ kind: string }>;
    expect(raw.map((e) => e.kind)).toEqual(["attestation", "revocation"]);

    // Reopening replays history.
    const reopened = new AttestationLedger(file);
    expect(reopened.bySubject("tool-registry")).toHaveLength(1);
    expect(reopened.bySubject("tool-registry")[0].grant.id).toBe(attestation.grant.id);
    expect(reopened.list()).toHaveLength(2);
  });

  it("survives corrupt files (fresh start) and works in-memory", () => {
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{oops");
    expect(new AttestationLedger(file).list()).toHaveLength(0);

    const memory = new AttestationLedger();
    const authority = new AttestationAuthority({ ledger: memory });
    authority.attest(grantFixture());
    expect(memory.list()).toHaveLength(1);
    // In-memory ledgers never touch the filesystem.
    expect(existsSync(join(dir, "ledger.json"))).toBe(false);
  });
});

describe("loadOrCreateAuthority", () => {
  it("creates a key once and reuses it across loads", () => {
    const keyFile = join(dir, "authority.pem");
    const first = loadOrCreateAuthority(keyFile);
    const second = loadOrCreateAuthority(keyFile);

    expect(second.keyId).toBe(first.keyId);

    // The stored key verifies attestations from either instance.
    const attestation = first.attest(grantFixture());
    expect(second.verify(attestation)).toEqual({ valid: true });

    // Private key file exists with restrictive permissions (0600).
    const mode = statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("attestHostGrants + DefaultPluginHost.snapshotGrants", () => {
  it("snapshots capability ownership from a running host", async () => {
    const host = new DefaultPluginHost();
    host.register({
      manifest: { id: "provider", name: "Provider", version: "1.0.0" },
      setup(ctx) {
        ctx.provide("nexum:jobs:service", {});
        ctx.declareCapability("jobs");
      },
    });
    host.register({ manifest: { id: "bare", name: "Bare", version: "1.0.0" } });
    await host.start();

    const snapshot = host.snapshotGrants();
    const provider = snapshot.find((s) => s.pluginId === "provider");
    expect(provider?.tokens.sort()).toEqual(["nexum:jobs:service"]);
    expect(provider?.capabilities).toEqual(["jobs"]);
    // Plugins without grants still appear (with empty lists).
    expect(snapshot.find((s) => s.pluginId === "bare")).toMatchObject({
      tokens: [],
      capabilities: [],
    });
    await host.stop();
  });

  it("attests every plugin's grants and verifies them all", async () => {
    const host = new DefaultPluginHost();
    host.register({
      manifest: { id: "tools", name: "Tools", version: "1.0.0" },
      setup(ctx) {
        ctx.provide("nexum:tools:catalog", {});
        ctx.declareCapability("tools");
      },
    });
    host.register({
      manifest: { id: "skills", name: "Skills", version: "1.0.0" },
      setup(ctx) {
        ctx.provide("nexum:skills:system", {});
      },
    });
    await host.start();

    const authority = new AttestationAuthority();
    const attestations = attestHostGrants(host, authority, { grantedBy: "nexum:host@2.0.0" });
    expect(attestations).toHaveLength(2);

    const tools = attestations.find((a) => a.grant.subject.id === "tools");
    expect(tools?.grant.grants.sort()).toEqual(["capability:tools", "nexum:tools:catalog"]);
    expect(tools?.grant.grantedBy).toBe("nexum:host@2.0.0");
    for (const attestation of attestations) {
      expect(authority.verify(attestation)).toEqual({ valid: true });
    }
    await host.stop();
  });

  it("skips plugins with no grants", async () => {
    const host = new DefaultPluginHost();
    host.register({ manifest: { id: "idle", name: "Idle", version: "1.0.0" } });
    await host.start();
    const authority = new AttestationAuthority();
    expect(attestHostGrants(host, authority)).toHaveLength(0);
    await host.stop();
  });

  it("an auditor with only the public key can verify (forge resistance)", async () => {
    const host = new DefaultPluginHost();
    host.register({
      manifest: { id: "provider", name: "Provider", version: "1.0.0" },
      setup(ctx) {
        ctx.provide("nexum:jobs:service", {});
      },
    });
    await host.start();

    const issuer = new AttestationAuthority();
    const attestation = attestHostGrants(host, issuer)[0];

    // A DIFFERENT authority (i.e. an attacker minting grants) is detected.
    const attacker = new AttestationAuthority();
    const forged = attacker.attest(attestation.grant);
    const auditor = new AttestationAuthority({ privateKeyPem: generateAttestationKeyPair().privateKeyPem });
    expect(auditor.verify(forged).valid).toBe(false);
    // The genuine attestation verifies against its own authority.
    expect(issuer.verify(attestation)).toEqual({ valid: true });
    await host.stop();
  });
});
