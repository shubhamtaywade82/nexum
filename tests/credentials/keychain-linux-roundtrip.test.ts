/**
 * Real Linux keychain round-trip test (Phase 3 / beta gate).
 *
 * RELEASE-READINESS.md §3 requires a real Linux keychain round-trip test
 * before 2.0.0-beta.1. The sibling `vault-keychain.test.ts` is fully
 * deterministic — it injects fake `exec` and `fetch` functions, so it never
 * touches the OS. That suite catches contract regressions in the provider
 * code, but it cannot catch integration drift: a libsecret API change, a
 * D-Bus session-bus issue, a `secret-tool` CLI flag rename, or a
 * gnome-keyring permission problem. This suite closes that gap.
 *
 * The test is skipped unless `NEXUM_KEYCHAIN_LIVE_TESTS=1` is set AND the
 * platform is Linux, because it needs:
 *   - libsecret-tools (provides `secret-tool`)
 *   - a D-Bus session bus
 *   - a Secret Service implementation (gnome-keyring, keepassxc, …)
 *
 * CI runs it nightly in `.github/workflows/nightly.yml` (job `keychain`)
 * against an Ubuntu runner with `libsecret-tools` + `dbus-x11` +
 * `gnome-keyring` installed inside a D-Bus session. Developers can run it
 * locally with the same setup:
 *
 *   sudo apt install -y libsecret-tools dbus-x11 gnome-keyring
 *   dbus-run-session --env NEXUM_KEYCHAIN_LIVE_TESTS=1 \
 *     node --experimental-vm-modules node_modules/jest/bin/jest.js \
 *     tests/credentials/keychain-linux-roundtrip.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { KeychainCredentialProvider } from "../../src/credentials/index.js";

const isLive = process.env.NEXUM_KEYCHAIN_LIVE_TESTS === "1" && process.platform === "linux";

// Service prefix that won't collide with a user's real nexum secrets; the
// teardown clears every item under it so parallel runs don't fight.
const SERVICE = "nexum-test-roundtrip";

(isLive ? describe : describe.skip)("KeychainCredentialProvider against real libsecret (live round-trip)", () => {
  let provider: KeychainCredentialProvider;

  beforeAll(() => {
    // Fail fast with a clear message if the host can't actually run the test.
    // The nightly job installs the deps; a developer running locally without
    // them gets an actionable error instead of a confusing failure.
    const probe = spawnSync("secret-tool", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        "secret-tool not available. Install libsecret-tools and ensure a D-Bus session bus + Secret Service implementation are running. See the file header.",
      );
    }
    provider = new KeychainCredentialProvider({ service: SERVICE, platform: "linux" });
    // Clean any leftover items from a previous interrupted run so the
    // round-trip is genuinely from-scratch.
    spawnSync("secret-tool", ["clear", "service", SERVICE], { encoding: "utf8" });
  });

  afterAll(() => {
    // Tear down every item we stored, plus any strays from a prior crash.
    spawnSync("secret-tool", ["clear", "service", SERVICE], { encoding: "utf8" });
  });

  it("stores, resolves, and deletes a secret via the real Secret Service", async () => {
    const key = `roundtrip-${randomUUID().slice(0, 8)}`;
    const secret = `s3cret-value-${randomBytes(8).toString("hex")}`;

    // 1. Initially absent
    const initial = await provider.resolve(key);
    expect(initial).toBeUndefined();

    // 2. Store secret
    await provider.set(key, secret);

    // 3. Round-trip read — must return exactly what we wrote (no trailing
    // newline, no encoding drift).
    const resolved = await provider.resolve(key);
    expect(resolved).toBe(secret);

    // 4. Delete via the provider's delete() (secret-tool clear)
    const deleted = await provider.delete(key);
    expect(deleted).toBe(true);

    // 5. Subsequent read returns undefined, not an error
    const afterDelete = await provider.resolve(key);
    expect(afterDelete).toBeUndefined();
  });

  it("round-trips multiple accounts under the same service without cross-contamination", async () => {
    const a1 = `multi-a-${randomUUID().slice(0, 8)}`;
    const a2 = `multi-b-${randomUUID().slice(0, 8)}`;
    const s1 = `value-a-${randomBytes(4).toString("hex")}`;
    const s2 = `value-b-${randomBytes(4).toString("hex")}`;

    await provider.set(a1, s1);
    await provider.set(a2, s2);

    expect(await provider.resolve(a1)).toBe(s1);
    expect(await provider.resolve(a2)).toBe(s2);

    // Deleting a1 must not affect a2.
    expect(await provider.delete(a1)).toBe(true);
    expect(await provider.resolve(a1)).toBeUndefined();
    expect(await provider.resolve(a2)).toBe(s2);
  });

  it("overwrites an existing item on re-store (idempotent set)", async () => {
    const key = `overwrite-${randomUUID().slice(0, 8)}`;
    const first = `first-${randomBytes(4).toString("hex")}`;
    const second = `second-${randomBytes(4).toString("hex")}`;

    await provider.set(key, first);
    expect(await provider.resolve(key)).toBe(first);

    // Second store with the same account must replace, not append or error.
    await provider.set(key, second);
    expect(await provider.resolve(key)).toBe(second);
  });

  it("resolve() returns undefined for a never-stored account (not an error)", async () => {
    // The provider contract says missing items resolve undefined (not
    // throw), so the credential chain can continue to the next provider.
    const got = await provider.resolve(`never-stored-${randomUUID().slice(0, 8)}`);
    expect(got).toBeUndefined();
  });
});
