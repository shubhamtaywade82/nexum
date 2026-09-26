# Plugin Marketplace & Publisher Signing

The marketplace discovers, downloads, and installs plugins from remote sources. A source is anything that can list entries and produce an artifact — the built-ins cover HTTP catalogs, npm packages, and git repositories.

```
MarketplaceSource (http · npm · git)        your publisher keys
        │ catalog entries                        │
        ▼                                        ▼
MarketplaceService ─── install policy ─── PublisherTrustStore
        │   1. trust gate (signatures)           keyId → publisher,
        │   2. download artifact                 trust level
        │   3. sha256 integrity check
        ▼
.nexum/plugins/cache/<id>@<version>/   +   installed.json
```

## Sources

| Source                  | Discovery                                          | Download                        |
| ----------------------- | -------------------------------------------------- | ------------------------------- |
| `HttpMarketplaceSource` | catalog JSON at a URL                              | `entry.downloadUrl`             |
| `NpmMarketplaceSource`  | npm search in a scope (default `@nexum-plugin`)    | registry tarball                |
| `GitMarketplaceSource`  | `marketplace.json` or `<id>/plugin.json` in a repo | tar of the entry's subdirectory |

## Publisher signing

Integrity (sha256) answers "did I get what the catalog listed?". Signatures answer "do I trust the catalog itself?". Publishers sign the canonical form of each entry's security-relevant fields with an Ed25519 key — `node:crypto`, no extra dependencies:

```ts
import { generatePublisherKeyPair, signEntry, PublisherTrustStore } from "@nemesis-oss/nexum";

// Publisher side — once per release
const keys = generatePublisherKeyPair(); // keep the private half secret
entry.signature = signEntry(entry, keys.privateKeyPem);

// Consumer side — once per publisher you decide to trust
const trustStore = PublisherTrustStore.open(".nexum/marketplace/publishers.json");
trustStore.add({
  keyId: keys.keyId,
  publicKey: keys.publicKeyBase64,
  publisher: "alice",
  trust: "verified", // or "community" / "unknown"
});
```

The signature covers `id`, `version`, `sha256`, `downloadUrl`, `npmPackage`, `gitUrl`, `author`, and `capabilities` — swapping the artifact hash, bumping the version, or changing the download URL invalidates it. An embedded public key that disagrees with the trust store is rejected outright.

## Install policy

`MarketplaceService` applies the policy **before** anything touches the disk:

| `signatures` mode    | Unsigned entry | Valid signature                             | Invalid/tampered signature |
| -------------------- | -------------- | ------------------------------------------- | -------------------------- |
| `"off"`              | install        | install, unchecked                          | install, unchecked         |
| `"warn"` (default)   | install        | install + record                            | **reject**                 |
| `"require"`          | **reject**     | install + record                            | **reject**                 |
| `"require-verified"` | **reject**     | install only if the publisher is `verified` | **reject**                 |

A present-but-broken signature is rejected in every mode except `"off"` — a broken signature is tamper evidence, not a warning. `requireSha256: true` additionally rejects entries without an artifact hash.

```ts
import { MarketplaceService, HttpMarketplaceSource } from "@nemesis-oss/nexum";

const market = new MarketplaceService({
  rootDir: workspaceStateDir,
  sources: [new HttpMarketplaceSource("official", "https://plugins.nexum.dev/catalog.json")],
  installPolicy: {
    signatures: "require-verified",
    requireSha256: true,
    trustStore, // PublisherTrustStore
  },
});

const results = await market.search("redis");
const installed = await market.install(results[0]);
installed.verification; // { status: "valid", publisher: "alice", trust: "verified" }
installed.trustScore; // 0–100 heuristic (identity + entry hygiene)
```

The verification result and trust score are persisted on the installed record, so `listInstalled()` shows exactly what was accepted, under which key, and when.

## Trust scoring

`computeTrustScore(entry, verification)` is a deterministic 0–100 heuristic: publisher identity dominates (verified 50 · community 30 · unknown-with-valid-signature 10 · unsigned 0), plus hygiene bonuses for a `sha256` (+15), an author (+5), and a license (+5). `trustRiskBand(score)` buckets it into `low` (≥ 60) / `medium` (≥ 30) / `high` for UI badges and coarse policy gates. Invalid signatures always score 0.

## Post-install verification

```ts
market.verifyInstalled("cool-tools");
// { ok: true } | { ok: false, reason: "artifact hash drift: expected …" }
```

`verifyInstalled` re-hashes the on-disk artifact against the recorded value, catching modifications that happen after installation.
