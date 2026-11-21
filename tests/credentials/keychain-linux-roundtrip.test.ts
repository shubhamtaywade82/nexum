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
 * The test is skipped unless `NEXUM_KEYCHAIN_LIVE_TESTS=1` is set, because
 * it needs:
 *   - libsecret-tools (provides `secret-tool`)
 *   - a D-Bus session bus
 *   - a Secret Service implementation (gnome-keyring, keepassxc, libsecret's
 *     mock service, etc.)
 *
 * CI runs it nightly in `.github/workflows/nightly.yml` (job `keychain`)
 * against an Ubuntu runner with `libsecret-tools` + `dbus-x11` +
 * `gnome-keyring` installed and an unlocked session keyring. Developers can
 * run it locally with the same setup:
 *
 *   sudo apt install -y libsecret-tools dbus-x11 gnome-keyring
 *   export $(dbus-launch)
 *   echo -n "" | gnome-keyring-daemon --unlock
 *   NEXUM_KEYCHAIN_LIVE_TESTS=1 \
 *     node --experimental-vm-modules node_modules/jest/bin/jest.js \
 *     tests/credentials/keychain-linux-roundtrip.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const LIVE = process.env.NEXUM_KEYCHAIN_LIVE_TESTS === "1";
const describeLive = LIVE ? describe : describe.skip;

// Use a service prefix that won't collide with a user's real nexum secrets,
// and a per-run account suffix so parallel runs don't fight over the same
// item. The teardown at the end of the run clears every item under this
// service prefix.
const SERVICE = "nexum-test-roundtrip";
const RUN_ID = randomBytes(4).toString("hex");
const ACCOUNTS: string[] = [];

function secretTool(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("secret-tool", args, {
    input: input,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function secretToolClear(service: string): void {
  // `secret-tool clear` removes every item matching the attributes; we use it
  // for teardown. Errors here are best-effort — a missing item is success.
  spawnSync("secret-tool", ["clear", "service", service], { encoding: "utf8" });
}

describe("keychain Linux round-trip (live)", () => {
  beforeAll(() => {
    if (!LIVE) return;
    // Fail fast with a clear message if the host can't actually run the test.
    // The nightly job installs the deps; a developer running locally without
    // them gets an actionable error instead of a confusing failure.
    const probe = spawnSync("secret-tool", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        "secret-tool not available. Install libsecret-tools and ensure a D-Bus session bus + Secret Service implementation are running. See the file header.",
      );
    }
    // Clean any leftover items from a previous interrupted run before we
    // start, so the round-trip is genuinely from-scratch.
    secretToolClear(SERVICE);
  });

  afterAll(() => {
    if (!LIVE) return;
    // Tear down every item we stored, plus any strays from a prior crash.
    secretToolClear(SERVICE);
    for (const account of ACCOUNTS) {
      // Per-account clear is belt-and-suspenders; `clear service=...` above
      // already covered them. Kept so a future contributor reading the test
      // sees the per-item contract.
      void account;
    }
  });

  describeLive("KeychainCredentialProvider against real libsecret", () => {
    it("stores a secret, reads it back, and clears it", async () => {
      // Lazy import so the suite can be collected (and skipped) on hosts
      // without the build artifacts present.
      const { KeychainCredentialProvider } = await import("../../src/credentials/index.js");
      const provider = new KeychainCredentialProvider({
        service: SERVICE,
        platform: "linux",
      });
      const account = `roundtrip-${RUN_ID}-1`;
      ACCOUNTS.push(account);
      const secret = `secret-value-${randomBytes(8).toString("hex")}`;

      // Write — must not throw, must exit 0.
      await provider.set(account, secret);

      // Read — must return exactly what we wrote (no trailing newline, no
      // encoding drift). The provider trims stdout; libsecret's lookup does
      // not append a newline, so equality should be exact.
      const got = await provider.resolve(account);
      expect(got).toBe(secret);

      // Clear via the same secret-tool CLI the provider uses, then confirm
      // the provider now reports the item as missing (resolve → undefined).
      // The provider does not expose a delete() method by design (see class
      // doc: enumeration is unsupported), so we use the CLI directly — this
      // also tests that the provider's lookup correctly distinguishes
      // "missing item" from "empty value".
      const clear = secretTool(["clear", "service", SERVICE, "account", account]);
      expect(clear.code).toBe(0);

      const after = await provider.resolve(account);
      expect(after).toBeUndefined();
    });

    it("round-trips multiple accounts under the same service without cross-contamination", async () => {
      const { KeychainCredentialProvider } = await import("../../src/credentials/index.js");
      const provider = new KeychainCredentialProvider({
        service: SERVICE,
        platform: "linux",
      });
      const a1 = `roundtrip-${RUN_ID}-multi-a`;
      const a2 = `roundtrip-${RUN_ID}-multi-b`;
      ACCOUNTS.push(a1, a2);
      const s1 = `multi-a-${randomBytes(4).toString("hex")}`;
      const s2 = `multi-b-${randomBytes(4).toString("hex")}`;

      await provider.set(a1, s1);
      await provider.set(a2, s2);

      expect(await provider.resolve(a1)).toBe(s1);
      expect(await provider.resolve(a2)).toBe(s2);

      // Removing a1 must not affect a2.
      const clearA1 = secretTool(["clear", "service", SERVICE, "account", a1]);
      expect(clearA1.code).toBe(0);
      expect(await provider.resolve(a1)).toBeUndefined();
      expect(await provider.resolve(a2)).toBe(s2);
    });

    it("overwrites an existing item on re-store (idempotent set)", async () => {
      const { KeychainCredentialProvider } = await import("../../src/credentials/index.js");
      const provider = new KeychainCredentialProvider({
        service: SERVICE,
        platform: "linux",
      });
      const account = `roundtrip-${RUN_ID}-overwrite`;
      ACCOUNTS.push(account);
      const first = `first-${randomBytes(4).toString("hex")}`;
      const second = `second-${randomBytes(4).toString("hex")}`;

      await provider.set(account, first);
      expect(await provider.resolve(account)).toBe(first);

      // Second store with the same account must replace, not append or error.
      await provider.set(account, second);
      expect(await provider.resolve(account)).toBe(second);
    });

    it("resolve() returns undefined for a never-stored account (not an error)", async () => {
      const { KeychainCredentialProvider } = await import("../../src/credentials/index.js");
      const provider = new KeychainCredentialProvider({
        service: SERVICE,
        platform: "linux",
      });
      // An account name nobody has stored under this service. The provider
      // contract says missing items resolve undefined (not throw), so the
      // credential chain can continue to the next provider.
      const got = await provider.resolve(`roundtrip-${RUN_ID}-never-stored`);
      expect(got).toBeUndefined();
    });
  });
});
