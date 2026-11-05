# Trust & Security CLI

The P2 trust layer is not just a library — every subsystem has an operator-facing CLI. This page is the single reference for all of them; each feature page (sandbox, marketplace, attestations, MCP trust, credentials) links back here for the command surface.

All commands share a few conventions worth knowing before you use them. First, they are **read-only by default**: `verify`, `list`, and `policy` never mutate state, while `approve`, `add`, `attest`, and `revoke` write to the workspace state dir (`.nexum/`) and nowhere else. Second, every command honors a `--json` flag that prints pure JSON with no headers, so output pipes cleanly into `jq` or scripts. Third, exit codes are stable and scripting-friendly: `0` = ok, `1` = verification or runtime failure, `2` = usage error — which makes the commands directly usable as CI gates.

```
nexum plugins sandbox <file>      # trial-run a plugin in the worker sandbox
nexum plugins verify [id…]        # re-verify installed marketplace plugins
nexum marketplace keys list|add|remove
nexum mcp trust list|policy|approve|revoke
nexum credentials list|get <name>
nexum capabilities attest|verify|revoke|list
```

## nexum plugins sandbox

Runs an untrusted plugin module through the full Tier-2 lifecycle (worker isolation + policy mediation) without mounting it on a live host — the safest way to answer "what does this plugin try to do?".

```
nexum plugins sandbox ./plugin.mjs \
  --allow-lookup "cache:*" \
  --allow-provide "tools:*" \
  --max-provides 4 \
  --setup-timeout-ms 5000
```

| Flag                            | Effect                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| `--allow-provide`               | Token patterns the plugin may provide (repeatable)                |
| `--allow-lookup`                | Token patterns the plugin may lookup (repeatable)                 |
| `--allow-declare`               | Capability tags it may declare (repeatable)                       |
| `--max-provides`                | Cap on provide calls (default 16)                                 |
| `--setup/start/stop-timeout-ms` | Lifecycle timeboxes (defaults 10s/10s/5s, `0` disables)           |
| `--json`                        | Machine-readable result: manifest, phases, audit, provided values |

The output prints the manifest, per-phase timing, and the **complete audit trail** — every mediated operation with its `ALLOWED`/`DENIED` verdict. A plugin that swallows a denial in a try/catch still fails the run: the exit code reflects the audit trail, not just whether lifecycle completed. In trial mode, allowed lookups resolve `undefined` (there is no live host to serve capabilities) and provides are recorded for the report instead of being mounted.

## nexum plugins verify

Re-hashes every installed marketplace plugin's artifact against the sha256 recorded at install time and reports the stored publisher signature status, trust score, and publisher. Tampering with `.nexum/plugins/cache/**` after install makes this command fail — that is its entire job.

```
nexum plugins verify            # all installed plugins
nexum plugins verify cool-tools # just one (exit 1 when missing)
nexum plugins verify --json     # { ok, rows: [...] } for CI
```

Unsigned plugins do **not** fail verification (they print a note instead) — that matches the default `warn` install policy. Switch the policy to `require`/`require-verified` to make unsigned installs impossible in the first place; see the [marketplace guide](/guide/marketplace).

## nexum marketplace keys

Manages the publisher trust store at `.nexum/publisher-trust.json` — the keyId → publisher registry that `verifyEntrySignature` consults during installs.

```
nexum marketplace keys list
nexum marketplace keys add ./publisher.pem --publisher alice --level verified
nexum marketplace keys add ./key.b64    --publisher bob            # raw base64 DER also works
nexum marketplace keys remove <keyId>
```

`add` accepts either a PEM public key (`-----BEGIN PUBLIC KEY-----`) or a raw base64 DER blob, validates it parses as an SPKI key, derives the keyId (sha256-16 of the DER), and records it with a trust level (`verified` or `community`, default `community`).

## nexum mcp trust

The operator side of the MCP trust policy: inspect the TOFU approval store and preview exactly what the agent will do with each configured server.

```
nexum mcp trust list                     # approved servers + pinned fingerprints
nexum mcp trust policy                   # effective decisions per configured server
nexum mcp trust approve github-mcp       # pin the CURRENT config fingerprint
nexum mcp trust approve odd-one --fingerprint abc123   # explicit fingerprint escape hatch
nexum mcp trust revoke github-mcp
```

`policy` builds the same policy the agent uses (`mcpTrustPolicyFromConfig`) and shows, per server: its fingerprint, effective trust level, whether the agent may connect, and any tool gates. A server marked `trust: "ask"` shows `no` until you approve it — and approvals are fingerprint-pinned, so changing the server's command or args invalidates them automatically. See the [MCP guide](/guide/mcp) for the config fields.

## nexum credentials

Resolves credentials through the same provider chain the agent uses and prints the result **always redacted** — raw values are never printed, by design. Scripting that needs the raw value should read it from the provider directly (env var, keychain, vault), not from this command.

```
nexum credentials list                       # enumerable names + previews
nexum credentials get OPENAI_API_KEY         # provider + redacted preview
nexum credentials get SECRET --keychain      # add the OS keychain to the chain
nexum credentials get api/key#token --vault https://vault:8200   # + Vault KV v2
```

The base chain is env (`NEXUM_*`/`DEVAGENT_*`) + file (`.nexum/credentials.json`). `--keychain` extends it with the OS keychain (macOS Keychain / Secret Service), `--vault` with HashiCorp Vault KV v2 (token from `VAULT_TOKEN`). Keychain and vault entries are not enumerable — `list` shows only env/file names, `get` resolves from all providers in the chain. Provider details live in the [credentials guide](/guide/credentials).

## nexum capabilities

Drives the attestation authority: the Ed25519 key at `.nexum/attestation-authority.pem` and the append-only ledger at `.nexum/attestation-ledger.json`. The key is created on first use with `0600` permissions.

```
# issue a signed grant (recorded in the ledger)
nexum capabilities attest \
  --subject plugin:my-plugin \
  --grant "nexum:tools:catalog" --grant "capability:tools" \
  --expires-in 30d --conditions "read-only"

# verify — from a file, or by grant id against the ledger
nexum capabilities verify attestation.json
nexum capabilities verify --id grant_k3x9q2z1

# revoke (irreversible; survives fresh processes via ledger replay)
nexum capabilities revoke --grant-id grant_k3x9q2z1
nexum capabilities revoke --subject plugin:compromised

nexum capabilities list       # full ledger history
```

`--subject` takes `<type>:<id>` where type is one of `plugin`, `agent`, `tool`, `mcp-server`, `host`. `--expires-in` accepts `90s`, `45m`, `12h`, `30d`, or raw milliseconds. Revocations are honored by every later `verify` — a fresh CLI process replays the ledger's revocation entries into the authority at startup, so revoking a grant invalidates it permanently, not just in the session that revoked it. The attestation model itself is documented in the [attestation guide](/guide/attestations).

## CI recipe

Because exit codes are stable, the commands compose into pipeline gates:

```bash
# fail the build when an installed plugin was tampered with
nexum plugins verify --json | jq -e '.ok'

# fail when any MCP server that should be gated is not approved
nexum mcp trust policy --json | jq -e '[.servers[] | select(.level != "trusted" and .allowed != "yes")] | length == 0'

# fail when a capability grant no longer verifies
nexum capabilities verify --id grant_k3x9q2z1
```

## State files

| File (under `.nexum/`)      | Written by                        |
| --------------------------- | --------------------------------- |
| `mcp-trust.json`            | `mcp trust approve/revoke`        |
| `publisher-trust.json`      | `marketplace keys add/remove`     |
| `attestation-authority.pem` | `capabilities attest` (first use) |
| `attestation-ledger.json`   | `capabilities attest/revoke`      |
| `plugins/installed.json`    | marketplace installs (read here)  |
