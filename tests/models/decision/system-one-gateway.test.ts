import {
  SystemOneDecisionGateway,
  type SystemOneClient,
  type SystemOneEnvironment,
} from "../../../src/models/decision/system-one-gateway.js";
import {
  DecisionUnavailableError,
  DecisionTransportError,
  DecisionProtocolError,
} from "../../../src/models/decision/errors.js";
import type { DecisionRequest } from "../../../src/models/decision/types.js";

// ── Fake System One client ─────────────────────────────────────────────────
// Models the upstream SDK seam: `systemOne(request: Record<string, unknown>):
// Promise<unknown>`. The gateway is the ONLY consumer of this interface, and
// the SDK is the only production implementor. Tests use this fake.

class FakeSystemOneClient implements SystemOneClient {
  constructor(
    private readonly responder: (req: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<unknown>,
  ) {}

  systemOne(request: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> {
    return this.responder(request, opts);
  }
}

class StaticEnvironment implements SystemOneEnvironment {
  constructor(
    readonly tier: "local" | "cloud",
    private readonly version: string | undefined,
  ) {}

  async getVersion(): Promise<string | undefined> {
    return this.version;
  }
}

function choiceRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: "d1",
    model: "mpuig/system-one-minicpm5-2b-q8",
    mode: "choice",
    context: "User asked: 'read config.json and patch a typo'. Tools available include filesystem and shell.",
    questions: [
      {
        id: "domain",
        prompt: "Which domain best matches this request?",
        choices: [
          { id: "filesystem", description: "read/write/patch files" },
          { id: "shell", description: "run shell commands" },
          { id: "git", description: "git operations" },
        ],
      },
    ],
    ...overrides,
  };
}

// A well-formed System One wire response. The exact field names will be
// finalized when the SDK exposes the public API; the gateway is written to
// parse a small, reasonable surface and preserve the rest as raw evidence.
function wireResponse(decisions: Array<Record<string, unknown>>): unknown {
  return {
    model: "mpuig/system-one-minicpm5-2b-q8",
    decisions,
    // The server may include metadata that Nexum does not interpret but
    // should preserve verbatim on the raw field for replay/debugging.
    meta: { server_version: "0.35.0", eval_ms: 42 },
  };
}

describe("SystemOneDecisionGateway — success", () => {
  it("parses a choice response with probabilities into DecisionResult", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([
        {
          questionId: "domain",
          selected: "filesystem",
          probabilities: { filesystem: 0.92, shell: 0.05, git: 0.03 },
        },
      ]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    const result = await gw.decide(choiceRequest());

    expect(result.model).toBe("mpuig/system-one-minicpm5-2b-q8");
    expect(result.mode).toBe("choice");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].questionId).toBe("domain");
    expect(result.decisions[0].selected).toBe("filesystem");
    expect(result.decisions[0].probabilities?.filesystem).toBe(0.92);
    expect(result.decisions[0].raw).toEqual({
      questionId: "domain",
      selected: "filesystem",
      probabilities: { filesystem: 0.92, shell: 0.05, git: 0.03 },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("parses a score response", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse([{ questionId: "complexity", score: 0.83 }]));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.36.0"),
    });

    const result = await gw.decide(
      choiceRequest({
        mode: "score",
        questions: [{ id: "complexity", prompt: "How complex is this request? 0..1" }],
      }),
    );

    expect(result.decisions[0].score).toBe(0.83);
  });

  it("parses a noul response where the model returns no selected id", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([
        {
          questionId: "domain",
          selected: null,
          probabilities: { filesystem: 0.1, shell: 0.1, git: 0.05 },
        },
      ]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    const result = await gw.decide(choiceRequest({ mode: "noul" }));
    expect(result.decisions[0].selected).toBeUndefined();
  });

  it("echoes the request id when supplied", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([{ questionId: "domain", selected: "filesystem" }]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    const result = await gw.decide(choiceRequest({ id: "rid-123" }));
    expect(result.id).toBe("rid-123");
  });

  it("synthesizes a decision id when none was supplied", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([{ questionId: "domain", selected: "filesystem" }]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    const req = choiceRequest();
    delete req.id;
    const result = await gw.decide(req);
    expect(result.id).toMatch(/^decision-/);
  });

  it("builds the wire request with the model/context/mode/questions fields", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = new FakeSystemOneClient(async (req) => {
      seen = req;
      return wireResponse([{ questionId: "domain", selected: "filesystem" }]);
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    await gw.decide(choiceRequest());

    expect(seen).toBeDefined();
    expect(seen!.model).toBe("mpuig/system-one-minicpm5-2b-q8");
    expect(seen!.mode).toBe("choice");
    expect(seen!.context).toContain("config.json");
    expect(Array.isArray(seen!.questions)).toBe(true);
  });
});

describe("SystemOneDecisionGateway — environment rules", () => {
  it("rejects with DecisionUnavailableError when the runtime tier is cloud", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse([]));
    const gw = new SystemOneDecisionGateway({
      client,
      // Cloud tier is forbidden by the System One contract.
      environment: new StaticEnvironment("cloud", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionUnavailableError);
  });

  it("rejects with DecisionUnavailableError when the Ollama version is below 0.35.0", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse([]));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.34.2"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionUnavailableError);
  });

  it("proceeds when the version is unknown (lets the server speak for itself)", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([{ questionId: "domain", selected: "filesystem" }]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", undefined),
    });
    // No throw — gateway honors the request and lets the server reject if
    // the local Ollama is genuinely too old, surfacing that as a typed error
    // at the transport/protocol layer instead of a preemptive refusal.
    await expect(gw.decide(choiceRequest())).resolves.toBeDefined();
  });

  it("accepts a custom minimum version override", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse([]));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.36.0"),
      minVersion: "0.37.0",
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionUnavailableError);
  });
});

describe("SystemOneDecisionGateway — transport failures", () => {
  it("wraps a generic network error as DecisionTransportError", async () => {
    const client = new FakeSystemOneClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionTransportError);
  });

  it("wraps an AbortError as DecisionTransportError", async () => {
    const client = new FakeSystemOneClient(async (_req, opts) => {
      const e = new Error("aborted");
      e.name = "AbortError";
      // Confirm the gateway forwards the request's signal through to the
      // client — the real SDK honors it the same way.
      expect(opts?.signal?.aborted).toBe(true);
      throw e;
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    const ac = new AbortController();
    ac.abort();
    await expect(gw.decide(choiceRequest({ signal: ac.signal }))).rejects.toBeInstanceOf(DecisionTransportError);
  });

  it("does not fall back to Provider.chat() internally (no chat provider passed)", async () => {
    // The gateway constructor takes only a SystemOneClient + environment —
    // there is no Provider/chat field anywhere, so by construction it cannot
    // silently route a decision to Provider.chat(). This test exists to lock
    // that contract against a future regression that "helpfully" adds a chat
    // fallback.
    const client = new FakeSystemOneClient(async () => {
      throw new Error("systemone unreachable");
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    // Must reject, never silently resolve from a hidden chat fallback.
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionTransportError);
  });
});

describe("SystemOneDecisionGateway — protocol failures", () => {
  it("throws DecisionProtocolError when the response has no `decisions` array", async () => {
    const client = new FakeSystemOneClient(async () => ({ model: "x" }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a returned selected id is not in the question choices", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([{ questionId: "domain", selected: "super_search_repo" }]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    // System One must not be able to invent tool names. The gateway enforces
    // this contract here, BEFORE policy ever sees the result.
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a probability value is not a finite number", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([
        {
          questionId: "domain",
          selected: "filesystem",
          probabilities: { filesystem: "not-a-number" },
        },
      ]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a decision's questionId is not in the request", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse([{ questionId: "unknown-q", selected: "filesystem" }]),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when the response is missing a requested question id", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse([]));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });
});

describe("SystemOneDecisionGateway — request validation", () => {
  it("rejects an oversized request before contacting the client (no SDK call made)", async () => {
    let called = 0;
    const client = new FakeSystemOneClient(async () => {
      called++;
      return wireResponse([]);
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    const req = choiceRequest();
    req.context = "x".repeat(70_000);
    await expect(gw.decide(req)).rejects.toBeInstanceOf(DecisionProtocolError);
    expect(called).toBe(0);
  });
});
