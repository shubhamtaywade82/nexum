import type { IncomingMessage } from "node:http";

import {
  checkRequestGuard,
  isLoopbackHostHeader,
  normalizeOrigin,
  parseAllowedOrigins,
  tokensMatch,
  type RequestGuardOptions,
} from "../../src/host/request-guard.js";

function request(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const loopback: RequestGuardOptions = { isLoopbackHost: true, allowedOrigins: new Set() };
const jsonPost = { host: "127.0.0.1:3777", "content-type": "application/json", "content-length": "2" };

describe("isLoopbackHostHeader", () => {
  it.each(["127.0.0.1", "127.0.0.1:3777", "localhost", "LOCALHOST:3777", "[::1]", "[::1]:3777"])(
    "accepts %s",
    (value) => {
      expect(isLoopbackHostHeader(value)).toBe(true);
    },
  );

  it.each([
    "attacker.example",
    "attacker.example:3777",
    "127.0.0.1.attacker.example",
    "localhost.attacker.example",
    "",
  ])("refuses %s", (value) => {
    expect(isLoopbackHostHeader(value)).toBe(false);
  });

  it("refuses a missing Host header", () => {
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });
});

describe("checkRequestGuard — Host (DNS rebinding)", () => {
  it("refuses a foreign Host on a loopback-bound host, even for a GET", () => {
    const rejection = checkRequestGuard(request({ host: "attacker.example:3777" }), loopback);
    expect(rejection).toMatchObject({ status: 403, error: "forbidden_host" });
  });

  it("accepts the loopback names on a loopback-bound host", () => {
    expect(checkRequestGuard(request({ host: "localhost:3777" }), loopback)).toBeNull();
  });

  it("does not apply the Host rule to a non-loopback bind, where the operator chose the name", () => {
    const remote: RequestGuardOptions = { isLoopbackHost: false, allowedOrigins: new Set() };
    expect(checkRequestGuard(request({ host: "nexum.internal:3777" }), remote)).toBeNull();
  });
});

describe("checkRequestGuard — Origin (cross-site browser requests)", () => {
  it("refuses a request from a foreign origin", () => {
    const rejection = checkRequestGuard(request({ ...jsonPost, origin: "https://attacker.example" }), loopback);
    expect(rejection).toMatchObject({ status: 403, error: "forbidden_origin" });
  });

  it("refuses a sandboxed or file origin, which browsers report as null", () => {
    const rejection = checkRequestGuard(request({ ...jsonPost, origin: "null" }), loopback);
    expect(rejection).toMatchObject({ status: 403, error: "forbidden_origin" });
  });

  it("accepts an origin on the allowlist, compared case-insensitively and ignoring a trailing slash", () => {
    const allowed: RequestGuardOptions = {
      isLoopbackHost: true,
      allowedOrigins: new Set(parseAllowedOrigins("http://localhost:5173/, https://Chat.Example.org")),
    };
    expect(checkRequestGuard(request({ ...jsonPost, origin: "http://localhost:5173" }), allowed)).toBeNull();
    expect(checkRequestGuard(request({ ...jsonPost, origin: "https://chat.example.org" }), allowed)).toBeNull();
  });

  it("accepts requests with no Origin, as non-browser clients send", () => {
    expect(checkRequestGuard(request(jsonPost), loopback)).toBeNull();
  });
});

describe("checkRequestGuard — body type (cross-site form and simple requests)", () => {
  it("refuses a text/plain body, the content type a cross-site form can send without preflight", () => {
    const rejection = checkRequestGuard(
      request({ host: "127.0.0.1:3777", "content-type": "text/plain", "content-length": "15" }),
      loopback,
    );
    expect(rejection).toMatchObject({ status: 415, error: "unsupported_media_type" });
  });

  it("refuses a form-encoded body", () => {
    const rejection = checkRequestGuard(
      request({ host: "127.0.0.1:3777", "content-type": "application/x-www-form-urlencoded", "content-length": "9" }),
      loopback,
    );
    expect(rejection).toMatchObject({ status: 415 });
  });

  it("refuses a chunked body without a JSON content type", () => {
    const rejection = checkRequestGuard(
      request({ host: "127.0.0.1:3777", "transfer-encoding": "chunked", "content-type": "text/plain" }),
      loopback,
    );
    expect(rejection).toMatchObject({ status: 415 });
  });

  it("accepts application/json with a charset parameter", () => {
    const headers = {
      host: "127.0.0.1:3777",
      "content-type": "application/json; charset=utf-8",
      "content-length": "2",
    };
    expect(checkRequestGuard(request(headers), loopback)).toBeNull();
  });

  it("does not require a content type when there is no body", () => {
    expect(checkRequestGuard(request({ host: "127.0.0.1:3777", "content-length": "0" }), loopback)).toBeNull();
    expect(checkRequestGuard(request({ host: "127.0.0.1:3777" }), loopback)).toBeNull();
  });
});

describe("parseAllowedOrigins and normalizeOrigin", () => {
  it("returns no origins for an unset or blank value", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("  ,  ")).toEqual([]);
  });

  it("splits, trims and normalises a comma-separated list", () => {
    expect(parseAllowedOrigins(" HTTP://A.example:1/ , https://b.example ")).toEqual([
      "http://a.example:1",
      "https://b.example",
    ]);
    expect(normalizeOrigin("https://X.example/")).toBe("https://x.example");
  });
});

describe("tokensMatch", () => {
  it("accepts the exact token", () => {
    expect(tokensMatch("sec_token_abc", "sec_token_abc")).toBe(true);
  });

  it("refuses a different token, a prefix, and a longer token", () => {
    expect(tokensMatch("sec_token_abd", "sec_token_abc")).toBe(false);
    expect(tokensMatch("sec_token", "sec_token_abc")).toBe(false);
    expect(tokensMatch("sec_token_abc_extra", "sec_token_abc")).toBe(false);
  });
});
