/**
 * Tests for the real keychain + vault credential providers (P2).
 * Fully deterministic: exec and fetch are injected fakes, no OS or network.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  KeychainCredentialProvider,
  VaultCredentialProvider,
  HttpVaultClient,
  CredentialService,
  defaultVaultNameMapping,
  type ExecFn,
  type ExecResult,
  type VaultClient,
} from "../../src/credentials/index.js";

// ── KeychainCredentialProvider ──────────────────────────────────────────────

function fakeExec(scripts: Record<string, ExecResult>): ExecFn & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const fn = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, args]);
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(scripts)) {
      if (key.startsWith(pattern) || key === pattern) return result;
    }
    return { code: 1, stdout: "", notFound: false };
  };
  return Object.assign(fn, { calls });
}

const OK_STDOUT: ExecResult = { code: 0, stdout: "super-secret-value\n", notFound: false };
const NOT_FOUND: ExecResult = { code: 44, stdout: "", notFound: false }; // macOS "item not found"
const NO_BINARY: ExecResult = { code: 127, stdout: "", notFound: true }; // ENOENT

describe("KeychainCredentialProvider", () => {
  it("macOS: reads via security find-generic-password with service+account", async () => {
    const exec = fakeExec({ "security find-generic-password": OK_STDOUT });
    const p = new KeychainCredentialProvider({ platform: "darwin", service: "nexum-test", exec });
    await expect(p.resolve("github-token")).resolves.toBe("super-secret-value");
    expect(exec.calls[0]).toEqual([
      "security",
      ["find-generic-password", "-s", "nexum-test", "-a", "github-token", "-w"],
    ]);
  });

  it("macOS: missing item / locked keychain / missing binary all resolve undefined", async () => {
    for (const result of [NOT_FOUND, NO_BINARY]) {
      const exec = fakeExec({ "security find-generic-password": result });
      const p = new KeychainCredentialProvider({ platform: "darwin", exec });
      await expect(p.resolve("x")).resolves.toBeUndefined();
    }
  });

  it("linux: reads via secret-tool lookup", async () => {
    const exec = fakeExec({ "secret-tool lookup": OK_STDOUT });
    const p = new KeychainCredentialProvider({ platform: "linux", service: "nexum-test", exec });
    await expect(p.resolve("github-token")).resolves.toBe("super-secret-value");
    expect(exec.calls[0]).toEqual(["secret-tool", ["lookup", "service", "nexum-test", "account", "github-token"]]);
  });

  it("linux: writes via secret-tool store (stdin-based backends aside)", async () => {
    const exec = fakeExec({ "secret-tool store": { code: 0, stdout: "", notFound: false } });
    const p = new KeychainCredentialProvider({ platform: "linux", exec });
    await expect(p.set("k", "v")).resolves.toBeUndefined();
    expect(exec.calls[0][0]).toBe("secret-tool");
    expect(exec.calls[0][1]).toContain("store");
  });

  it("macOS: writes via security add-generic-password -U (update-or-add)", async () => {
    const exec = fakeExec({ "security add-generic-password": { code: 0, stdout: "", notFound: false } });
    const p = new KeychainCredentialProvider({ platform: "darwin", exec });
    await expect(p.set("k", "v")).resolves.toBeUndefined();
    expect(exec.calls[0][1]).toContain("-U");
  });

  it("set() reports missing tooling instead of silently succeeding", async () => {
    const exec = fakeExec({ "security add-generic-password": NO_BINARY });
    const p = new KeychainCredentialProvider({ platform: "darwin", exec });
    await expect(p.set("k", "v")).rejects.toThrow(/security\(1\) not available/);
  });

  it("unsupported platforms resolve undefined and refuse writes", async () => {
    const p = new KeychainCredentialProvider({ platform: "win32" });
    await expect(p.resolve("x")).resolves.toBeUndefined();
    await expect(p.set("x", "y")).rejects.toThrow(/unsupported/);
    expect(p.list()).toEqual([]);
  });

  it("empty stdout resolves undefined (blank secret = absent secret)", async () => {
    const exec = fakeExec({ "security find-generic-password": { code: 0, stdout: "\n", notFound: false } });
    const p = new KeychainCredentialProvider({ platform: "darwin", exec });
    await expect(p.resolve("x")).resolves.toBeUndefined();
  });

  it("composes in the CredentialService chain after env/file", async () => {
    const exec = fakeExec({ "security find-generic-password": OK_STDOUT });
    const keychain = new KeychainCredentialProvider({ platform: "darwin", exec });
    const svc = new CredentialService({ providers: [keychain] });
    const record = await svc.resolve({ name: "only-in-keychain" });
    expect(record?.provider).toBe("keychain");
    expect(record?.value).toBe("super-secret-value");
  });
});

// ── VaultCredentialProvider + HttpVaultClient ───────────────────────────────

describe("defaultVaultNameMapping", () => {
  it("splits name#field and defaults the field to 'value'", () => {
    expect(defaultVaultNameMapping("team/api#token")).toEqual({ path: "team/api", key: "token" });
    expect(defaultVaultNameMapping("team/api")).toEqual({ path: "team/api", key: "value" });
    // last # wins (paths can contain #? unlikely, but be predictable)
    expect(defaultVaultNameMapping("a#b#c")).toEqual({ path: "a#b", key: "c" });
  });
});

describe("VaultCredentialProvider", () => {
  function fakeClient(
    secrets: Record<string, Record<string, string>>,
    opts: { throwOn?: string } = {},
  ): VaultClient & {
    reads: string[];
  } {
    const reads: string[] = [];
    const client: VaultClient = {
      readSecret: async (path) => {
        reads.push(path);
        if (opts.throwOn === path) throw new Error("vault is sealed");
        return secrets[path];
      },
    };
    return Object.assign(client, { reads });
  }

  it("resolves via the client with the default name mapping", async () => {
    const client = fakeClient({ "team/api": { token: "vault-secret" } });
    const p = new VaultCredentialProvider(client);
    await expect(p.resolve("team/api#token")).resolves.toBe("vault-secret");
    expect(client.reads).toEqual(["team/api"]);
  });

  it("missing path / missing field / throwing client resolve undefined (chain continues)", async () => {
    const client = fakeClient({ "team/api": { token: "x" } }, { throwOn: "boom" });
    const p = new VaultCredentialProvider(client);
    await expect(p.resolve("nowhere#token")).resolves.toBeUndefined();
    await expect(p.resolve("team/api#wrongfield")).resolves.toBeUndefined();
    await expect(p.resolve("boom#token")).resolves.toBeUndefined();
  });

  it("prefix restricts and namespaces paths", async () => {
    const client = fakeClient({ "nexum/team/api": { value: "prefixed" } });
    const p = new VaultCredentialProvider(client, { prefix: "nexum/" });
    await expect(p.resolve("team/api")).resolves.toBe("prefixed");
    expect(client.reads).toEqual(["nexum/team/api"]);
  });

  it("TTL cache: one read while fresh, re-read after expiry", async () => {
    const secrets: Record<string, Record<string, string>> = { a: { value: "v1" } };
    const client = fakeClient({});
    (client as never as { readSecret: unknown }).readSecret = async (path: string) => {
      client.reads.push(path);
      return secrets[path];
    };
    let clock = 1000;
    const p = new VaultCredentialProvider(client, { ttlMs: 5_000, now: () => clock });
    await expect(p.resolve("a")).resolves.toBe("v1");
    clock += 4_999;
    await expect(p.resolve("a")).resolves.toBe("v1"); // cached
    expect(client.reads).toHaveLength(1);
    clock += 2;
    secrets.a = { value: "v2" };
    await expect(p.resolve("a")).resolves.toBe("v2"); // expired → re-read
    expect(client.reads).toHaveLength(2);
  });

  it("invalidate() forces a re-read even inside the TTL", async () => {
    const secrets: Record<string, Record<string, string>> = { a: { value: "v1" } };
    const client = fakeClient({});
    (client as never as { readSecret: unknown }).readSecret = async (path: string) => {
      client.reads.push(path);
      return secrets[path];
    };
    const p = new VaultCredentialProvider(client, { ttlMs: 60_000 });
    await p.resolve("a");
    p.invalidate();
    secrets.a = { value: "v2" };
    await expect(p.resolve("a")).resolves.toBe("v2");
  });

  it("list() requires listPaths + prefix; failures degrade to []", async () => {
    const listing: VaultClient & { listPaths: (p: string) => Promise<string[]> } = {
      readSecret: async () => undefined,
      listPaths: async () => {
        throw new Error("no list endpoint");
      },
    };
    const p = new VaultCredentialProvider(listing, { prefix: "nexum" });
    await expect(p.list()).resolves.toEqual([]);
    const withoutPrefix = new VaultCredentialProvider({ readSecret: async () => undefined });
    await expect(withoutPrefix.list()).resolves.toEqual([]);
  });
});

describe("HttpVaultClient (KV v2)", () => {
  function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): jest.Mock {
    return jest.fn(handler) as unknown as jest.Mock;
  }

  it("GETs the KV v2 data path with the X-Vault-Token header", async () => {
    const fetchMock = fakeFetch(
      () => new Response(JSON.stringify({ data: { data: { token: "kv2-secret" } } }), { status: 200 }),
    );
    const client = new HttpVaultClient({
      baseUrl: "https://vault.example.com:8200/",
      token: "hvs.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.readSecret("team/api")).resolves.toEqual({ token: "kv2-secret" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vault.example.com:8200/v1/secret/data/team/api");
    expect((init.headers as Record<string, string>)["X-Vault-Token"]).toBe("hvs.test");
  });

  it("custom mounts land in the URL; 404 and network failures resolve undefined", async () => {
    const fetchMock = fakeFetch((url: string) => {
      if (url.includes("/v1/kv/data/x")) return new Response("{}", { status: 404 });
      throw new Error("ECONNREFUSED");
    });
    const client = new HttpVaultClient({
      baseUrl: "https://vault.example.com:8200",
      token: "t",
      mount: "kv",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.readSecret("x")).resolves.toBeUndefined(); // 404
    await expect(client.readSecret("y")).resolves.toBeUndefined(); // network throw
  });

  it("malformed JSON bodies resolve undefined (never throw)", async () => {
    const fetchMock = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const client = new HttpVaultClient({
      baseUrl: "https://v",
      token: "t",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.readSecret("x")).resolves.toBeUndefined();
  });

  it("composes into the CredentialService with provider id 'vault'", async () => {
    const fetchMock = fakeFetch(
      () => new Response(JSON.stringify({ data: { data: { value: "from-vault" } } }), { status: 200 }),
    );
    const client = new HttpVaultClient({
      baseUrl: "https://vault.example.com",
      token: "t",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const svc = new CredentialService({ providers: [new VaultCredentialProvider(client, { prefix: "nexum" })] });
    const record = await svc.resolve({ name: "db-password" });
    expect(record?.provider).toBe("vault");
    expect(record?.value).toBe("from-vault");
    // the prefixed KV v2 path was requested
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vault.example.com/v1/secret/data/nexum/db-password");
  });
});
