/**
 * Marketplace signing & publisher trust (P2 trust tier).
 *
 * `MarketplaceService` already verified artifact *integrity* (sha256 from the
 * catalog entry). That answers "did I download what the catalog listed?" but
 * not "do I trust the catalog itself?" — a compromised or malicious registry
 * can list a perfectly self-consistent bad artifact. This module adds the
 * missing authenticity layer:
 *
 *   PublisherKeyPair    — Ed25519 key material for plugin publishers
 *                         (node:crypto, no native deps)
 *   EntrySignature      — detached signature over the canonical form of a
 *                         catalog entry's security-relevant fields
 *   PublisherTrustStore — keyId → {publicKey, publisher, trust level} registry
 *                         persisted as JSON (e.g. .nexum/marketplace/publishers.json)
 *   verifyEntrySignature— signature check + trust resolution
 *   computeTrustScore   — deterministic 0–100 heuristic + risk band used for
 *                         install gating and UI badges
 *
 * Verification results feed `MarketplaceService.install()` through a
 * `MarketplaceInstallPolicy`:
 *
 *   signatures: "off"               never verify (not recommended)
 *               "warn"  (default)   verify when possible, record result,
 *                                   reject tampered signatures, allow unsigned
 *               "require"           signature must exist and be valid
 *               "require-verified"  … and the publisher must be "verified"
 *
 * A present-but-invalid signature is rejected in every mode except "off":
 * a broken signature is tamper evidence, not a warning.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MarketplaceEntry } from "./index.js";

// ── Contracts ───────────────────────────────────────────────────────────────

export type PublisherTrustLevel = "verified" | "community" | "unknown";

/** Detached Ed25519 signature over an entry's canonical signed fields. */
export interface EntrySignature {
  algorithm: "ed25519";
  /** Fingerprint of the signing key (sha256-16 of the SPKI DER). */
  keyId: string;
  /** Base64 Ed25519 signature over `canonicalSignedPayload(entry)`. */
  signature: string;
  /** Fields covered by the signature (defaults to SIGNED_FIELDS). */
  signedFields?: string[];
}

/** Entry fields covered by a signature — everything security-relevant. */
export const SIGNED_FIELDS: readonly string[] = [
  "id",
  "version",
  "sha256",
  "downloadUrl",
  "npmPackage",
  "gitUrl",
  "author",
  "capabilities",
] as const;

export interface PublisherKeyRecord {
  /** Key fingerprint (matches EntrySignature.keyId). */
  keyId: string;
  /** SPKI public key, base64 (DER). */
  publicKey: string;
  /** Human-readable publisher name. */
  publisher: string;
  trust: PublisherTrustLevel;
  /** ISO timestamp when the key was added to the store. */
  addedAt: string;
  note?: string;
}

/** A generated publisher keypair. Keep the private half secret. */
export interface PublisherKeyPair {
  /** PKCS#8 PEM private key. */
  privateKeyPem: string;
  /** SPKI public key, base64 (DER). */
  publicKeyBase64: string;
  /** sha256-16 fingerprint of the SPKI DER. */
  keyId: string;
}

export type SignatureStatus = "valid" | "invalid" | "unsigned";

export interface SignatureVerification {
  status: SignatureStatus;
  /** Present when status === "valid". */
  keyId?: string;
  publisher?: string;
  trust?: PublisherTrustLevel;
  /** Present when status !== "valid". */
  reason?: string;
}

export interface PublisherTrustStoreOptions {
  /** Path of the JSON file backing the store (in-memory when omitted). */
  file?: string;
  /** Seed records (merged on top of the file contents). */
  seed?: PublisherKeyRecord[];
}

export interface MarketplaceInstallPolicy {
  /**
   * Signature enforcement for installs. Default "warn". See module doc.
   * "invalid" signatures are always fatal except in "off" mode.
   */
  signatures?: "off" | "warn" | "require" | "require-verified";
  /** Require entries to carry a sha256 (artifact integrity). Default false. */
  requireSha256?: boolean;
  /** Publisher key registry used for verification. */
  trustStore?: PublisherTrustStore;
}

// ── Key material ────────────────────────────────────────────────────────────

/** Generate an Ed25519 publisher keypair. */
export function generatePublisherKeyPair(): PublisherKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    keyId: keyIdFromSpki(publicKey),
  };
}

/** sha256-16 fingerprint of an SPKI public key. */
export function keyIdFromSpki(publicKey: KeyObject | string): string {
  const der =
    typeof publicKey === "string"
      ? Buffer.from(publicKey, "base64")
      : (publicKey.export({ type: "spki", format: "der" }) as Buffer);
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

function publicKeyFromBase64(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

// ── Canonical payload + signing ─────────────────────────────────────────────

/**
 * Canonical signed payload: the entry's security-relevant fields, explicit
 * `null` for absent ones, keys sorted, stable JSON. Any change to these
 * fields (version bump, different artifact hash, swapped download URL…)
 * invalidates the signature.
 */
export function canonicalSignedPayload(entry: MarketplaceEntry, fields?: readonly string[]): string {
  const useFields = fields ?? SIGNED_FIELDS;
  const obj: Record<string, unknown> = {};
  for (const field of [...useFields].sort()) {
    const value = (entry as unknown as Record<string, unknown>)[field];
    obj[field] = value === undefined ? null : value;
  }
  return JSON.stringify(obj);
}

/** Sign a marketplace entry with a publisher private key. */
export function signEntry(entry: MarketplaceEntry, privateKeyPem: string, keyId?: string): EntrySignature {
  const privateKey = privateKeyFromPem(privateKeyPem);
  // Derive the matching public key from the PEM (works for Ed25519 PKCS#8).
  const derivedKeyId = keyIdFromSpki(createPublicKey(privateKeyPem));
  const payload = Buffer.from(canonicalSignedPayload(entry), "utf8");
  const signature = cryptoSign(null, payload, privateKey).toString("base64");
  return {
    algorithm: "ed25519",
    keyId: keyId ?? derivedKeyId,
    signature,
    signedFields: [...SIGNED_FIELDS],
  };
}

// ── Publisher trust store ───────────────────────────────────────────────────

/**
 * keyId → publisher key registry, persisted as JSON with atomic writes.
 * Open with a file path for durability, or without for an in-memory store
 * (useful for tests and ephemeral installs).
 */
export class PublisherTrustStore {
  private readonly records = new Map<string, PublisherKeyRecord>();
  private readonly file?: string;

  constructor(opts: PublisherTrustStoreOptions = {}) {
    this.file = opts.file;
    if (this.file && existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as PublisherKeyRecord[];
        if (Array.isArray(data)) {
          for (const r of data) {
            if (r && typeof r.keyId === "string" && typeof r.publicKey === "string") {
              this.records.set(r.keyId, r);
            }
          }
        }
      } catch {
        // corrupt — start fresh (matches MarketplaceService.loadIndex semantics)
      }
    }
    for (const r of opts.seed ?? []) {
      this.records.set(r.keyId, r);
    }
  }

  static inMemory(seed?: PublisherKeyRecord[]): PublisherTrustStore {
    return new PublisherTrustStore({ seed });
  }

  static open(file: string, seed?: PublisherKeyRecord[]): PublisherTrustStore {
    return new PublisherTrustStore({ file, seed });
  }

  add(record: Omit<PublisherKeyRecord, "addedAt"> & { addedAt?: string }): this {
    this.records.set(record.keyId, {
      ...record,
      addedAt: record.addedAt ?? new Date().toISOString(),
    });
    this.persist();
    return this;
  }

  get(keyId: string): PublisherKeyRecord | undefined {
    return this.records.get(keyId);
  }

  has(keyId: string): boolean {
    return this.records.has(keyId);
  }

  remove(keyId: string): boolean {
    const removed = this.records.delete(keyId);
    if (removed) this.persist();
    return removed;
  }

  list(): PublisherKeyRecord[] {
    return [...this.records.values()];
  }

  private persist(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
      renameSync(tmp, this.file);
    } catch {
      // best-effort, matches other Nexum JSON stores
    }
  }
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * Verify an entry's signature and resolve publisher trust.
 *
 * Resolution order for the verifying key:
 *   1. trust store record for `signature.keyId` (trusted source of truth;
 *      an embedded public key that disagrees with the store is rejected)
 *   2. no store record → the signature's embedded/absent key cannot establish
 *      identity, so even a cryptographically valid signature is "unknown"
 *
 * Unsigned entries return `{status: "unsigned"}` — a policy decision, not an
 * error; `MarketplaceInstallPolicy` decides what happens next.
 */
export function verifyEntrySignature(entry: MarketplaceEntry, trustStore?: PublisherTrustStore): SignatureVerification {
  const signature = (entry as { signature?: EntrySignature }).signature;
  if (!signature || signature.algorithm !== "ed25519") {
    return { status: "unsigned", reason: "entry carries no ed25519 signature" };
  }
  if (typeof signature.keyId !== "string" || typeof signature.signature !== "string") {
    return { status: "invalid", reason: "malformed signature bundle" };
  }

  const record = trustStore?.get(signature.keyId);
  let publicKeyBase64: string | undefined = record?.publicKey;

  // If the signature embeds a public key (future-proofing: self-describing
  // bundles), it must agree with the store when both exist.
  const embedded = (signature as { publicKey?: string }).publicKey;
  if (embedded) {
    if (publicKeyBase64 && embedded !== publicKeyBase64) {
      return {
        status: "invalid",
        reason: `embedded public key does not match trusted key ${signature.keyId}`,
      };
    }
    if (!publicKeyBase64) {
      // Unrecognized embedded key: usable for integrity, not identity.
      publicKeyBase64 = embedded;
    }
  }

  if (!publicKeyBase64) {
    // No trusted record and no embedded key — the bundle cannot be checked.
    return {
      status: "invalid",
      reason: `signing key "${signature.keyId}" is not in the trust store and no public key is embedded`,
    };
  }

  let valid: boolean;
  try {
    const key = publicKeyFromBase64(publicKeyBase64);
    const payload = Buffer.from(canonicalSignedPayload(entry, signature.signedFields), "utf8");
    const sig = Buffer.from(signature.signature, "base64");
    valid = cryptoVerify(null, payload, key, sig);
  } catch {
    return { status: "invalid", reason: "signature verification threw (malformed key or signature)" };
  }
  if (!valid) {
    return {
      status: "invalid",
      reason: "signature does not match the entry's signed fields (tampered entry or wrong key)",
    };
  }

  return {
    status: "valid",
    keyId: signature.keyId,
    publisher: record?.publisher,
    trust: record?.trust ?? "unknown",
  };
}

// ── Trust score ─────────────────────────────────────────────────────────────

export type TrustRiskBand = "low" | "medium" | "high";

/**
 * Deterministic 0–100 trust heuristic. Inputs: signature verification result
 * (publisher identity is the dominant term) + entry hygiene (artifact hash,
 * author, license). Same inputs → same score; no network, no clocks.
 */
export function computeTrustScore(entry: MarketplaceEntry, verification: SignatureVerification): number {
  let score = 0;
  switch (verification.status) {
    case "valid":
      if (verification.trust === "verified") score += 50;
      else if (verification.trust === "community") score += 30;
      else score += 10; // valid signature, unrecognized publisher
      break;
    case "unsigned":
      score += 0;
      break;
    default:
      return 0; // invalid signature → no trust at all
  }
  if (entry.sha256) score += 15;
  if (entry.author) score += 5;
  if (entry.license) score += 5;
  return Math.min(100, score);
}

/** Map a trust score to a coarse risk band for UI / policy gates. */
export function trustRiskBand(score: number): TrustRiskBand {
  if (score >= 60) return "low";
  if (score >= 30) return "medium";
  return "high";
}
