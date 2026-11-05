# Capability Attestation

When a plugin calls `ctx.provide(token)` or `ctx.declareCapability(tag)`, the host grants it a capability — but by default nothing records who granted what to whom in a form an auditor can check later. Capability attestation turns those grants into **signed, independently verifiable statements**.

```
plugin host (running)                AttestationAuthority (Ed25519)
  snapshotGrants()  ───────────────►  attest(grant)
  { pluginId, tokens,                    │ canonical payload → sha256 → sign
    capabilities }                       ▼
                                   CapabilityAttestation (JSON)
                                   { grant, payloadHash, keyId, signature }
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
        AttestationLedger         verify() by the host      verify() by an
        (append-only audit        (expiry + revocation      auditor holding
         trail, JSON file)         aware)                    the public key
```

## The artifact

A `CapabilityAttestation` is a small JSON object:

```ts
{
  version: 1,
  grant: {
    id: "grant_k3x9q2z1",
    subject: { type: "plugin", id: "tool-registry" },
    grants: ["nexum:tools:catalog", "nexum:tools:gateway", "capability:tools"],
    grantedBy: "nexum:host@2.0.0",
    grantedAt: "2026-09-26T10:12:33.114Z",
    expiresAt: "2026-12-26T00:00:00.000Z", // optional
    conditions: "workspace-scope",          // optional
  },
  payloadHash: "sha256 of the canonical grant…",
  algorithm: "ed25519",
  keyId: "a91f…16 hex chars…",
  signedAt: "2026-09-26T10:12:33.118Z",
  signature: "base64…",
}
```

The payload hash is computed over a canonical form (sorted keys, sorted grant list, explicit nulls), so any post-signing mutation — an added capability, a changed subject, a stretched expiry — breaks verification. The signature is Ed25519 over the hash; anyone holding the authority's public key can verify the attestation **offline**, with no access to the host that produced it.

## Issuing attestations

```ts
import { AttestationAuthority, AttestationLedger, attestHostGrants, loadOrCreateAuthority } from "@nemesis-oss/nexum";

// Persistent authority key — generated once, stored at 0600
const authority = loadOrCreateAuthority(".nexum/attestation/authority.pem", {
  ledger: new AttestationLedger(".nexum/attestation/ledger.json"),
});

// Attest every plugin's grants on a running host
await host.start();
const attestations = attestHostGrants(host, authority, { grantedBy: "nexum:host@2.0.0" });
```

`DefaultPluginHost.snapshotGrants()` produces the capability-ownership snapshot (which plugin provides which tokens, which tags it declared); `attestHostGrants` seals one attestation per plugin that actually holds grants. Grants work for any subject type, not just plugins — agents, tools, and MCP servers fit the same shape:

```ts
authority.attest({
  subject: { type: "mcp-server", id: "github" },
  grants: ["mcp:github:create_issue"],
  grantedBy: "config:mcpServers",
  expiresAt: "2026-10-26T00:00:00.000Z",
});
```

## Verifying

```ts
const result = authority.verify(attestation);
// { valid: true }
// { valid: false, reason: "payload hash mismatch — grant was modified after signing" }
// { valid: false, reason: "grant expired at …", expired: true }
// { valid: false, reason: "grant \"grant_…\" has been revoked" }
// { valid: false, reason: "attestation was signed by authority \"…\", this authority is \"…\"" }
```

Verification checks, in order: version, authority key id, payload hash, signature, revocation, then expiry (with an injectable clock, so tests are deterministic). Revocation is irreversible and works by grant id or by subject:

```ts
authority.revoke({ subject: "tool-registry" }); // every grant of that plugin
authority.verify(previouslyAttested); // → { valid: false, reason: "…revoked" }
```

## The ledger

Attach an `AttestationLedger` and every attestation and revocation is appended to an append-only JSON file — the audit trail for "what was this system authorized to do on Tuesday":

```ts
const ledger = new AttestationLedger(".nexum/attestation/ledger.json");
ledger.list(); // full history: attestations + revocations
ledger.bySubject("tool-registry"); // every attestation for one plugin
```

## Threat model

Attestations prove a grant **existed** and what it contained, and they make the authorization state of a running system tamper-evident and inspectable after the fact. They do not _constrain_ the grantee at runtime — that is the [plugin sandbox](/guide/plugin-sandbox)'s job, and the [MCP trust policy](/guide/mcp)'s for MCP servers. Use the three together: policy decides what is granted, the sandbox enforces it, attestation records it.

## CLI

```bash
nexum capabilities attest --subject plugin:my-plugin --grant "capability:tools" --expires-in 30d
nexum capabilities verify --id grant_k3x9q2z1
nexum capabilities revoke --grant-id grant_k3x9q2z1
```

See the [Trust & Security CLI reference](/guide/security-cli).
