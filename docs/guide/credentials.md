# Credentials & Secret Providers

Nexum's `CredentialService` resolves credentials through a chain of providers, so tools never need to know whether a value came from an environment variable, a file, the OS keychain, or a remote vault. Every value is wrapped with redaction so accidental logging shows `sk-a***0xyz` instead of the secret.

```
get("GITHUB_TOKEN")
      ↓ provider chain, first hit wins
[1] env        process.env / NEXUM_* / DEVAGENT_*
[2] file       .nexum/credentials.json (gitignored, mode 0600)
[3] keychain   macOS Keychain (security) · Linux Secret Service (secret-tool)
[4] vault      remote secret managers behind the VaultClient port
      ↓
cached CredentialRecord (value + provider + resolvedAt)
```

## Providers

| Provider                     | Source                     | Notes                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnvCredentialProvider`      | `process.env`              | Always first in the chain. Resolves `NAME`, `NEXUM_NAME`, then `DEVAGENT_NAME`                                                                                                                                                   |
| `FileCredentialProvider`     | `<state>/credentials.json` | Atomic writes with `0600`; `write()` / `remove()` for management                                                                                                                                                                 |
| `KeychainCredentialProvider` | OS keychain                | macOS `security find-generic-password`, Linux `secret-tool lookup`. No native modules — plain CLI tools behind an injectable executor. Missing binary/item/backend resolves `undefined` (the chain moves on); `set()` for writes |
| `VaultCredentialProvider`    | Remote secret manager      | Any backend behind the `VaultClient` port; TTL cache (default 5 min), path prefixing, `name#field` mapping                                                                                                                       |

Providers degrade rather than throw: a sealed vault, a locked keychain, or a missing `secret-tool` simply yields `undefined` and the next provider is consulted.

## Using the service

```ts
import { CredentialService } from "@nemesis-oss/nexum";

const credentials = new CredentialService({
  rootDir: workspaceStateDir, // enables the file provider
  providers: [
    new KeychainCredentialProvider({ service: "nexum" }),
    new VaultCredentialProvider(new HttpVaultClient({ baseUrl: "https://vault.example.com:8200", token }), {
      prefix: "nexum",
    }),
  ],
});

const token = await credentials.require("GITHUB_TOKEN"); // throws listing the checked providers
const record = await credentials.resolve({ name: "db-password", tags: ["trading"] });
const safe = await credentials.listRedacted(); // [{ name, provider, preview: "sk-a***0xyz" }]
```

### Scopes and rotation

`scope()` returns a filtered view (by names/tags) — hand it to a subsystem so a trading tool pack can only see trading credentials. `rotate(name, fn)` + `refresh(name)` hot-swap a value without a restart (e.g. an OAuth refresh flow); `invalidate()` clears the resolution cache.

## OS keychain details

The keychain provider stores each credential under a service name (default `nexum`) with the credential name as the account. Manual inspection:

```bash
# macOS
security find-generic-password -s nexum -a GITHUB_TOKEN -w
# Linux (Secret Service / libsecret)
secret-tool lookup service nexum account GITHUB_TOKEN
```

Enumeration is deliberately not implemented (`security dump-keychain` is slow and touches unrelated items), so `list()` returns nothing for this provider — resolve by name.

## Vault details

`HttpVaultClient` speaks HashiCorp Vault **KV v2** (`GET /v1/{mount}/data/{path}` with the token in the `X-Vault-Token` header; mount defaults to `secret`). Credential names map to secrets as `path#field`:

```
"team/api#token"  →  secret "team/api", field "token"
"db-password"     →  secret "db-password", field "value"
```

The `prefix` option namespaces every lookup (e.g. `nexum/`), and any other backend (AWS Secrets Manager, GCP Secret Manager, Doppler, …) plugs in by implementing the two-method `VaultClient` port. Failures — unreachable host, 404, malformed body — resolve `undefined`; the token is only ever sent in the header, never logged.

The full behavior matrix (degradation, TTL expiry, invalidation, KV v2 request shape) is pinned by `tests/credentials/vault-keychain.test.ts` and `tests/credentials/credential-service.test.ts`.

## CLI

```bash
nexum credentials get OPENAI_API_KEY --keychain   # redacted preview
nexum credentials list                            # enumerable names
```

Raw values are never printed — see the [Trust & Security CLI reference](/guide/security-cli).
