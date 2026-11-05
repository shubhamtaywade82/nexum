import { redactText, redactObject } from "../../src/safety/redact.js";

describe("Safety - Redact", () => {
  it("redacts AWS key patterns", () => {
    const text = "Found key AKIAIOSFODNN7EXAMPLE in config";
    expect(redactText(text)).toBe("Found key [REDACTED] in config");
  });

  it("redacts Bearer tokens and generic api keys", () => {
    const text = "Authorization: Bearer mySecretToken1234567890";
    expect(redactText(text)).toContain("[REDACTED]");
  });

  it("deeply redacts object properties", () => {
    const obj = {
      api_key: "secret12345",
      user: {
        password: "supersecretpassword",
        name: "Alice",
      },
      tags: ["AKIAIOSFODNN7EXAMPLE"],
    };
    const redacted = redactObject(obj);
    expect(redacted.api_key).toBe("[REDACTED]");
    expect(redacted.user.password).toBe("[REDACTED]");
    expect(redacted.user.name).toBe("Alice");
    expect(redacted.tags[0]).toBe("[REDACTED]");
  });
});
