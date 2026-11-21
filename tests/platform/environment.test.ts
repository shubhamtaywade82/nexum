import { beforeEach, describe, expect, it } from "@jest/globals";
import { envIs, readEnv, readEnvFlag } from "../../src/platform/environment.js";
import { budgetFromEnv } from "../../src/observability/budget.js";

const savedEnv = { ...process.env };

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("platform/environment — NEXUM_* product variables", () => {
  beforeEach(() => {
    process.env = { ...savedEnv };
    setEnv("NEXUM_MODEL", undefined);
    setEnv("NEXUM_TIER", undefined);
  });

  it("reads a NEXUM_* variable", () => {
    setEnv("NEXUM_MODEL", "qwen3.5:8b");
    expect(readEnv("MODEL")).toBe("qwen3.5:8b");
  });

  it("returns the empty string when NEXUM_* is set to empty (?? semantics)", () => {
    setEnv("NEXUM_MODEL", "");
    expect(readEnv("MODEL")).toBe("");
  });

  it("returns undefined when unset", () => {
    expect(readEnv("MODEL")).toBeUndefined();
  });

  it("ignores unprefixed and legacy-prefixed names", () => {
    setEnv("MODEL", "bare");
    setEnv("DEVAGENT_MODEL", "legacy");
    expect(readEnv("MODEL")).toBeUndefined();
  });

  it("readEnvFlag parses booleans in both directions, else fallback", () => {
    expect(readEnvFlag("TIER", true)).toBe(true);
    setEnv("NEXUM_VERIFIER", "false");
    expect(readEnvFlag("VERIFIER", true)).toBe(false);
    setEnv("NEXUM_VERIFIER", "1");
    expect(readEnvFlag("VERIFIER", false)).toBe(true);
    setEnv("NEXUM_VERIFIER", "0");
    expect(readEnvFlag("VERIFIER", true)).toBe(false);
  });

  it("envIs matches the NEXUM_* form exactly", () => {
    setEnv("NEXUM_TEST_NO_GLOBAL", "true");
    expect(envIs("TEST_NO_GLOBAL", "true")).toBe(true);
    expect(envIs("TEST_NO_GLOBAL", "1")).toBe(false);
  });

  it("budgetFromEnv reads NEXUM_TOKEN_BUDGET only", () => {
    expect(budgetFromEnv({ NEXUM_TOKEN_BUDGET: "100" } as NodeJS.ProcessEnv).limit).toBe(100);
    expect(budgetFromEnv({ DEVAGENT_TOKEN_BUDGET: "5" } as NodeJS.ProcessEnv).limit).toBe(0);
    expect(budgetFromEnv({} as NodeJS.ProcessEnv).limit).toBe(0);
  });
});
