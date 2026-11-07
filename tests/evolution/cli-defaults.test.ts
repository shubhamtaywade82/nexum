import {
  resolveGithubDeliveryEnabled,
  resolveGeneralizationPolicy,
  resolveRuntimeActivationEnabled,
  type GithubDeliveryEnvConfig,
} from "../../src/evolution/cli.js";

const GITHUB_CONFIG: GithubDeliveryEnvConfig = {
  owner: "owner",
  repo: "repo",
  token: "token",
  baseBranch: "main",
};

describe("evolution delivery defaults", () => {
  it("enables GitHub delivery automatically when the destination is configured", () => {
    expect(resolveGithubDeliveryEnabled({}, GITHUB_CONFIG)).toBe(true);
  });

  it("keeps GitHub delivery local when no destination is configured", () => {
    expect(resolveGithubDeliveryEnabled({}, null)).toBe(false);
  });

  it("allows a per-run opt-out of configured GitHub delivery", () => {
    expect(resolveGithubDeliveryEnabled({ "no-github": true }, GITHUB_CONFIG)).toBe(false);
  });

  it("uses the production generalization policy whenever automatic GitHub delivery is active", () => {
    expect(resolveGeneralizationPolicy({}, true)).toBe("required-for-production");
  });

  it("enables runtime activation by default", () => {
    expect(resolveRuntimeActivationEnabled({})).toBe(true);
  });

  it("supports a per-run runtime activation opt-out", () => {
    expect(resolveRuntimeActivationEnabled({ "no-activate-runtime": true })).toBe(false);
  });
});
