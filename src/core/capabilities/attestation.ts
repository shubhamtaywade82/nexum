/**
 * Capability attestation (P2 trust tier).
 *
 * The plugin host's `provide(token)` / `declareCapability(tag)` calls grant
 * capabilities, but nothing records WHO granted WHAT to WHOM in a way an
 * auditor can verify later. This module turns grants into signed,
 * independently verifiable statements:
 *
 *   CapabilityGrant      — subject (plugin/agent/tool/mcp-server) received
 *                          these capabilities from this grantor
 *   AttestationAuthority — Ed25519 keypair that signs grants
 *                          (attest / verify / revoke, expiry aware)
 *   CapabilityAttestation— the signed artifact: canonical grant + hash +
 *                          signature, verifiable offline by anyone holding
 *                          the authority's public key
 *   AttestationLedger    — append-only JSON record of attestations and
 *                          revocations for audit trails
 *   attestHostGrants     — snapshot a running plugin host's capability
 *                          ownership and attest every plugin's grants
 *
 * Threat model: attestations prove a grant EXISTED and what it contained.
 * They do not constrain the grantee (that is the sandbox's job) — they make
 * the authorization state of a running system inspectable and tamper-evident.
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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── Contracts ───────────────────────────────────────────────────────────────

export type AttestationSubjectType = "plugin" | "agent" | "tool" | "mcp-server" | "host";

export interface AttestationSubject {
  type: AttestationSubjectType;
  /** Plugin id / agent id / tool name / MCP server name. */
  id: string;
}

/** A grant of capabilities to a subject, before signing. */
export interface CapabilityGrant {
  /** Grant id (assigned at attest time when omitted). */
  id?: string;
  subject: AttestationSubject;
  /** Granted capability tags / tokens (order-insensitive). */
  grants: string[];
  /** Who or what issued the grant (host version, user, config file…). */
  grantedBy: string;
  /** ISO timestamp (assigned at attest time when omitted). */
  grantedAt?: string;
  /** ISO timestamp — verification fails after this point. */
  expiresAt?: string;
  /** Free-form conditions ("read-only", "workspace-scope", …). */
  conditions?: string;
}

/** A grant with all attest-time fields filled in. */
export type SealedGrant = Required<Pick<CapabilityGrant, "id" | "grantedAt">> & CapabilityGrant;

/** Signed, verifiable statement of a capability grant. */
export interface CapabilityAttestation {
  version: 1;
  grant: SealedGrant;
  /** sha256 hex of the canonical grant payload. */
  payloadHash: string;
  algorithm: "ed25519";
  /** sha256-16 fingerprint of the authority public key. */
  keyId: string;
  signedAt: string;
  /** Base64 Ed25519 signature over payloadHash. */
  signature: string;
}

export interface AttestationVerification {
  valid: boolean;
  /** Failure reason when valid === false. */
  reason?: string;
  /** True when the only failure was expiry (signature itself was good). */
  expired?: boolean;
}

export interface AttestationAuthorityOptions {
  /** PKCS#8 PEM private key (generated when omitted). */
  privateKeyPem?: string;
  /** Override for `new Date()` — deterministic expiry tests. */
  now?: () => Date;
  /** Ledger that records attestations + revocations when attached. */
  ledger?: AttestationLedger;
  /**
   * Revocations replayed from a persisted ledger at construction time.
   * Seeding does NOT append to the ledger again — it restores prior state
   * (a fresh process must still honor revocations recorded earlier).
   */
  revocations?: { grantIds?: string[]; subjects?: string[] };
}

export interface AuthorityKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

/** Capability ownership snapshot of a running host (DefaultPluginHost). */
export interface CapabilityGrantsSnapshot {
  pluginId: string;
  tokens: string[];
  capabilities: string[];
}

// ── Key material ────────────────────────────────────────────────────────────

/** Generate an Ed25519 authority keypair. */
export function generateAttestationKeyPair(): AuthorityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: fingerprintKey(publicKey),
  };
}

/** sha256-16 fingerprint of a KeyObject (SPKI DER). */
function fingerprintKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

// ── Canonical payload ───────────────────────────────────────────────────────

/** Canonical JSON of a grant: sorted keys, sorted grants list. */
export function canonicalGrantPayload(grant: SealedGrant): string {
  return JSON.stringify({
    conditions: grant.conditions ?? null,
    expiresAt: grant.expiresAt ?? null,
    grantedAt: grant.grantedAt,
    grantedBy: grant.grantedBy,
    grants: [...grant.grants].sort(),
    id: grant.id,
    subject: { type: grant.subject.type, id: grant.subject.id },
  });
}

function newGrantId(): string {
  return `grant_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// ── Authority ───────────────────────────────────────────────────────────────

/**
 * Signs and verifies capability grants. Hold one per installation
 * (`loadOrCreateAuthority` persists the key); share the public key with
 * anyone who needs to verify attestations offline.
 */
export class AttestationAuthority {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  readonly keyId: string;
  private readonly revokedGrantIds: Set<string>;
  private readonly revokedSubjects: Set<string>;
  private readonly now: () => Date;
  private readonly ledger?: AttestationLedger;

  constructor(opts: AttestationAuthorityOptions = {}) {
    const pair = opts.privateKeyPem ? authorityFromPrivatePem(opts.privateKeyPem) : generateAttestationKeyPair();
    this.privateKey = createPrivateKey(pair.privateKeyPem);
    this.publicKey = createPublicKey(pair.publicKeyPem);
    this.keyId = pair.keyId;
    this.now = opts.now ?? (() => new Date());
    this.ledger = opts.ledger;
    this.revokedGrantIds = new Set(opts.revocations?.grantIds ?? []);
    this.revokedSubjects = new Set(opts.revocations?.subjects ?? []);
  }

  /** Sign a grant, producing a verifiable attestation. */
  attest(grant: CapabilityGrant): CapabilityAttestation {
    const sealed: SealedGrant = {
      ...grant,
      id: grant.id ?? newGrantId(),
      grantedAt: grant.grantedAt ?? this.now().toISOString(),
      grants: [...grant.grants],
    };
    const payload = canonicalGrantPayload(sealed);
    const payloadHash = createHash("sha256").update(payload, "utf8").digest("hex");
    const signature = cryptoSign(null, Buffer.from(payloadHash, "utf8"), this.privateKey).toString("base64");
    const attestation: CapabilityAttestation = {
      version: 1,
      grant: sealed,
      payloadHash,
      algorithm: "ed25519",
      keyId: this.keyId,
      signedAt: this.now().toISOString(),
      signature,
    };
    this.ledger?.append(attestation);
    return attestation;
  }

  /** Verify an attestation: hash, signature, expiry, revocation. */
  verify(attestation: CapabilityAttestation): AttestationVerification {
    if (attestation.version !== 1) {
      return { valid: false, reason: `unsupported attestation version ${String(attestation.version)}` };
    }
    if (attestation.keyId !== this.keyId) {
      return {
        valid: false,
        reason: `attestation was signed by authority "${attestation.keyId}", this authority is "${this.keyId}"`,
      };
    }
    const recomputed = createHash("sha256").update(canonicalGrantPayload(attestation.grant), "utf8").digest("hex");
    if (recomputed !== attestation.payloadHash) {
      return { valid: false, reason: "payload hash mismatch — grant was modified after signing" };
    }
    let signatureOk: boolean;
    try {
      signatureOk = cryptoVerify(
        null,
        Buffer.from(attestation.payloadHash, "utf8"),
        this.publicKey,
        Buffer.from(attestation.signature, "base64"),
      );
    } catch {
      return { valid: false, reason: "malformed signature" };
    }
    if (!signatureOk) {
      return { valid: false, reason: "signature does not verify (forged or wrong authority key)" };
    }
    if (this.revokedGrantIds.has(attestation.grant.id) || this.revokedSubjects.has(attestation.grant.subject.id)) {
      return { valid: false, reason: `grant "${attestation.grant.id}" has been revoked` };
    }
    if (attestation.grant.expiresAt) {
      const expiry = Date.parse(attestation.grant.expiresAt);
      if (!Number.isNaN(expiry) && this.now().getTime() > expiry) {
        return { valid: false, reason: `grant expired at ${attestation.grant.expiresAt}`, expired: true };
      }
    }
    return { valid: true };
  }

  /** Revoke a grant by id, or every grant of a subject. Revocation is irreversible. */
  revoke(input: { grantId?: string; subject?: string }): void {
    if (input.grantId) this.revokedGrantIds.add(input.grantId);
    if (input.subject) this.revokedSubjects.add(input.subject);
    this.ledger?.appendRevocation({
      grantId: input.grantId,
      subject: input.subject,
      at: this.now().toISOString(),
    });
  }

  /** True when a grant id or subject has been revoked. */
  isRevoked(input: { grantId?: string; subject?: string }): boolean {
    return (
      (input.grantId !== undefined && this.revokedGrantIds.has(input.grantId)) ||
      (input.subject !== undefined && this.revokedSubjects.has(input.subject))
    );
  }
}

function authorityFromPrivatePem(privateKeyPem: string): AuthorityKeyPair {
  const publicKey = createPublicKey(privateKeyPem);
  return {
    privateKeyPem,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: fingerprintKey(publicKey),
  };
}

/**
 * Load (or create) a persistent authority key. The private key is written
 * with 0600 permissions next to the caller's chosen path.
 */
export function loadOrCreateAuthority(
  keyFile: string,
  opts: Omit<AttestationAuthorityOptions, "privateKeyPem"> = {},
): AttestationAuthority {
  if (existsSync(keyFile)) {
    const privateKeyPem = readFileSync(keyFile, "utf8");
    return new AttestationAuthority({ ...opts, privateKeyPem });
  }
  const pair = generateAttestationKeyPair();
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, pair.privateKeyPem, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600); // umask may have tightened the mode further
  } catch {
    // best-effort — file exists, permissions are as strict as the fs allows
  }
  return new AttestationAuthority({ ...opts, privateKeyPem: pair.privateKeyPem });
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export type LedgerEntry =
  | { kind: "attestation"; at: string; attestation: CapabilityAttestation }
  | { kind: "revocation"; at: string; grantId?: string; subject?: string };

/**
 * Append-only JSON ledger of attestations and revocations. Durability of the
 * audit trail — the authority works without one, but audits want history.
 */
export class AttestationLedger {
  private entries: LedgerEntry[] = [];
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (this.file && existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as LedgerEntry[];
        if (Array.isArray(data)) this.entries = data;
      } catch {
        // corrupt — start fresh (matches other Nexum JSON stores)
      }
    }
  }

  append(attestation: CapabilityAttestation): void {
    this.entries.push({ kind: "attestation", at: new Date().toISOString(), attestation });
    this.persist();
  }

  appendRevocation(revocation: { grantId?: string; subject?: string; at: string }): void {
    this.entries.push({ kind: "revocation", ...revocation });
    this.persist();
  }

  list(): LedgerEntry[] {
    return [...this.entries];
  }

  /** All attestations whose subject id matches. */
  bySubject(subjectId: string): CapabilityAttestation[] {
    return this.entries
      .filter((e) => e.kind === "attestation" && e.attestation.grant.subject.id === subjectId)
      .map((e) => (e as { kind: "attestation"; at: string; attestation: CapabilityAttestation }).attestation);
  }

  private persist(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
      renameSync(tmp, this.file);
    } catch {
      // best-effort
    }
  }
}

// ── Host integration ────────────────────────────────────────────────────────

/**
 * Snapshot a plugin host's capability ownership and attest every plugin's
 * grants. The host just needs a `snapshotGrants()` method (DefaultPluginHost
 * has one) — no other coupling.
 */
export function attestHostGrants(
  host: { snapshotGrants(): CapabilityGrantsSnapshot[] },
  authority: AttestationAuthority,
  opts: { grantedBy: string; conditions?: string } = { grantedBy: "nexum:host" },
): CapabilityAttestation[] {
  const attestations: CapabilityAttestation[] = [];
  for (const snapshot of host.snapshotGrants()) {
    if (snapshot.tokens.length === 0 && snapshot.capabilities.length === 0) continue;
    attestations.push(
      authority.attest({
        subject: { type: "plugin", id: snapshot.pluginId },
        grants: [...snapshot.tokens, ...snapshot.capabilities.map((tag) => `capability:${tag}`)],
        grantedBy: opts.grantedBy,
        conditions: opts.conditions,
      }),
    );
  }
  return attestations;
}
