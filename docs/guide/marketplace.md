# Plugin Marketplace & Publisher Signing

The marketplace discovers, downloads, installs and runs plugins from remote sources. A source is anything that can list entries and produce an artifact — the built-ins cover HTTP catalogs, npm packages, and git repositories.

```
MarketplaceSource (http · npm · git)        your publisher keys
        │ catalog entries                        │
        ▼                                        ▼
MarketplaceService ─── install policy ─── PublisherTrustStore
        │ install()                              keyId → publisher,
        │   1. trust gate (signatures)           trust level
        │   2. download artifact
        │   3. sha256 integrity check
        │   4. strict unpack + package.json validation
        ▼
.nexum/plugins/cache/<id>@<version>/plugin.artifact   +   installed.json
        │ activate()
        │   5. re-check signature (current trust store) + artifact hash
        │   6. unpack into a fresh private temp dir
        ▼
Node process: --permission, reads only its own package, empty env
        │ capability bridge (provide / lookup / declare allowlist)
        ▼
DefaultPluginHost
```

## Sources

| Source                  | Discovery                                          | Download                                                                                       |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `HttpMarketplaceSource` | catalog JSON at a URL                              | `entry.downloadUrl`                                                                            |
| `NpmMarketplaceSource`  | npm search in a scope (default `@nexum-plugin`)    | registry tarball                                                                               |
| `GitMarketplaceSource`  | `marketplace.json` or `<id>/plugin.json` in a repo | deterministic tar of the entry's subdirectory (same commit → same sha256, so it can be signed) |

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

| `signatures` mode     | Unsigned entry | Valid signature                             | Invalid/tampered signature |
| --------------------- | -------------- | ------------------------------------------- | -------------------------- |
| `"off"`               | install        | install, unchecked                          | install, unchecked         |
| `"warn"`              | install        | install + record                            | **reject**                 |
| `"require"` (default) | **reject**     | install if the key is in the trust store    | **reject**                 |
| `"require-verified"`  | **reject**     | install only if the publisher is `verified` | **reject**                 |

A present-but-broken signature is rejected in every mode except `"off"` — a broken signature is tamper evidence, not a warning. Under `"require"` and `"require-verified"` the signing key must come from the trust store (a signature that verifies only against a key embedded in the entry says nothing about who made it) and the entry must carry a `sha256`, since that is what ties the signature to the artifact. `requireSha256: true` adds the hash requirement to `"warn"`. The same policy is re-applied on every `activate()`, so removing a publisher key revokes their installed plugins.

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

## Plugin package format

The artifact is a tar archive (gzip optional; npm's `package/` root is stripped). Only regular files and directories are accepted — symlinks, hardlinks, devices, absolute paths, `..` components, duplicate entries and archives over 10,000 entries / 20 MiB per file / 100 MiB total are rejected. The root must hold a `package.json`:

```json
{
  "name": "cool-tools",
  "version": "1.4.2",
  "type": "module",
  "main": "index.js",
  "nexum": {
    "id": "cool-tools",
    "permissions": { "provide": ["tools:cool-*"], "lookup": ["config:cool-tools"] }
  }
}
```

`nexum.id` (or `name`) and `version` must equal the catalog entry; the entry module (`nexum.main`, else `main`, else `index.js`) must be a `.js`/`.mjs`/`.cjs` file inside the package, bundling its own dependencies. It default-exports `{ manifest, setup?, start?, stop? }` with the same id and version.

## Activation

```ts
const plugin = await market.activate("cool-tools"); // throws if signature, hash or manifest do not check out
host.register(plugin);
await host.start();
```

`activate()` never runs implicitly. The plugin runs in its own Node process under the permission model: it can read only its unpacked package (a private temp directory, deleted when the process exits), cannot write files, spawn processes, start workers or load native addons, starts with an empty environment, and has no network: before the plugin loads, every network entry point (`net`, `tls`, `http2`, `dgram`, `dns`, `inspector` — and so `http`, `fetch`, `WebSocket`) is replaced with one that throws `ERR_ACCESS_DENIED`. Pass `{ sandbox: { allowNetwork: true } }` to let a specific plugin reach the network. Everything it does on the host goes through the capability bridge, limited to the `permissions` the package declared (recorded on the install record for review); pass `{ policy }` to grant less. Capability values cross the bridge by structured clone, so functions and live objects cannot be looked up.

## Trust scoring

`computeTrustScore(entry, verification)` is a deterministic 0–100 heuristic: publisher identity dominates (verified 50 · community 30 · unknown-with-valid-signature 10 · unsigned 0), plus hygiene bonuses for a `sha256` (+15), an author (+5), and a license (+5). `trustRiskBand(score)` buckets it into `low` (≥ 60) / `medium` (≥ 30) / `high` for UI badges and coarse policy gates. Invalid signatures always score 0.

## Post-install verification

```ts
market.verifyInstalled("cool-tools");
// { ok: true } | { ok: false, reason: "artifact hash drift: expected …" }
```

`verifyInstalled` re-hashes the on-disk artifact against the recorded value, catching modifications that happen after installation.

## CLI

```bash
nexum plugins verify cool-tools   # re-verify an installed plugin
nexum marketplace keys list       # publisher trust store
```

See the [Trust & Security CLI reference](/guide/security-cli).
