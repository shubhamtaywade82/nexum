import { afterEach, beforeEach } from "@jest/globals";

/**
 * The decision plane (System One) and self-consistency are on by default, and
 * both make model calls of their own. Suites that script one model response per
 * turn (see mockChatFetch) would see those extra calls consume the scripted
 * turns, so they test the wrong path. Such suites call this helper to turn both
 * subsystems off through their env overrides for the duration of each test.
 *
 * An explicit `enableDecision: true` or `enableSelfConsistency: true` in a test's
 * config still wins: Agent spreads the config literal after loadConfig(), so
 * suites that exercise those subsystems keep working.
 */
const ISOLATED_ENV = ["NEXUM_DECISION", "NEXUM_SELF_CONSISTENCY"] as const;

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
