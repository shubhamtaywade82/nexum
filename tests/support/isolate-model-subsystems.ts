import { afterEach, beforeEach } from "@jest/globals";

/**
 * The decision plane, self-consistency and verifier are on by default and each
 * can make additional model calls. Suites that script one model response per
 * turn (see mockChatFetch) must isolate those calls unless they explicitly test
 * the subsystem; otherwise the fixture's turn sequence no longer represents
 * the behavior under test.
 *
 * An explicit `enableDecision: true`, `enableSelfConsistency: true`, or
 * `enableVerifier: true` in a test config still wins because Agent spreads
 * the config literal after loadConfig().
 */
const ISOLATED_ENV = ["NEXUM_DECISION", "NEXUM_SELF_CONSISTENCY", "NEXUM_VERIFIER"] as const;

export function isolateModelSubsystems(): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of ISOLATED_ENV) {
      saved[name] = process.env[name];
      process.env[name] = "false";
    }
  });
  afterEach(() => {
    for (const name of ISOLATED_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
}
