/**
 * Live Linux keychain integration test using real libsecret/secret-tool.
 *
 * Gated by NEXUM_KEYCHAIN_LIVE_TESTS=1 (run on Linux with libsecret-tools installed,
 * or executed in the nightly CI lane inside a D-Bus session).
 * Standard CI and local test runs skip this suite hermetically.
 */
import { describe, it, expect } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { KeychainCredentialProvider } from "../../src/credentials/index.js";

const isLive = process.env.NEXUM_KEYCHAIN_LIVE_TESTS === "1" && process.platform === "linux";

(isLive ? describe : describe.skip)("KeychainCredentialProvider (live Linux secret-tool roundtrip)", () => {
  const service = "nexum-integration-test";
  const provider = new KeychainCredentialProvider({ service, platform: "linux" });

  it("stores, resolves, and clears a secret via secret-tool", async () => {
    const key = `test-key-${randomUUID().slice(0, 8)}`;
    const secret = `s3cret-value-${randomUUID()}`;

    // 1. Initially absent
    const initial = await provider.resolve(key);
    expect(initial).toBeUndefined();

    // 2. Store secret
    await provider.set(key, secret);

    // 3. Round-trip read
    const resolved = await provider.resolve(key);
    expect(resolved).toBe(secret);

    // 4. Delete secret
    const deleted = await provider.delete(key);
    expect(deleted).toBe(true);

    // 5. Subsequent read returns undefined
    const afterDelete = await provider.resolve(key);
    expect(afterDelete).toBeUndefined();
  });
});
