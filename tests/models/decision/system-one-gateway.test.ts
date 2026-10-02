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
//
// The wire shape the gateway builds and parses is the tev1 /v1/systemone
// format documented at https://ollama.com/library/tev1:
//   Request:  { model, state, questions: { [name]: { type, instructions, criteria? } }, keep_alive? }
//   Response: { answers: { [name]: { choice, probabilities, confidence? } | { noul, confidence? } |
//                            { score, legend?, probabilities?, confidence? } } }

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

const DEFAULT_MODEL = "tev1";

function choiceRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: "d1",
    model: DEFAULT_MODEL,
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

// tev1 wire response shape. The `answers` map is keyed by question name; each
// entry is one of:
//   { choice, probabilities, confidence? }         — choice / noul-with-choices
//   { noul, confidence? }                           — noul without choices
//   { score, legend?, probabilities?, confidence? }  — score
function wireResponse(answers: Record<string, unknown>): unknown {
  return {
    model: DEFAULT_MODEL,
    answers,
    // The server may include metadata that Nexum does not interpret but
    // should preserve verbatim on the raw field for replay/debugging.
    meta: { server_version: "0.35.0", eval_ms: 42 },
  };
}

describe("SystemOneDecisionGateway — wire request shape (tev1)", () => {
  it("builds the tev1 wire request: { model, state, questions: { [name]: { type, instructions, criteria } } }", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = new FakeSystemOneClient(async (req) => {
      seen = req;
      return wireResponse({
        domain: { choice: "filesystem", probabilities: { filesystem: 0.92, shell: 0.05, git: 0.03 }, confidence: 0.85 },
      });
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    await gw.decide(choiceRequest());

    expect(seen).toBeDefined();
    expect(seen!.model).toBe(DEFAULT_MODEL);
    // tev1 uses `state`, not `context`.
    expect(seen!.state).toContain("config.json");
    expect(seen!.context).toBeUndefined();
    // tev1 has NO top-level `mode` — the type is per-question.
    expect(seen!.mode).toBeUndefined();
    // questions is an object map keyed by question id, NOT an array.
    expect(typeof seen!.questions).toBe("object");
    expect(Array.isArray(seen!.questions)).toBe(false);
    const questions = seen!.questions as Record<string, unknown>;
    expect(Object.keys(questions)).toEqual(["domain"]);
    const domainQ = questions.domain as Record<string, unknown>;
    expect(domainQ.type).toBe("choice");
    expect(domainQ.instructions).toContain("Which domain");
    // For choice, criteria is an object map { option_id: description }.
    expect(typeof domainQ.criteria).toBe("object");
    expect(Array.isArray(domainQ.criteria)).toBe(false);
    const criteria = domainQ.criteria as Record<string, unknown>;
    expect(criteria.filesystem).toBe("read/write/patch files");
    expect(criteria.shell).toBe("run shell commands");
    expect(criteria.git).toBe("git operations");
    // No synthetic "none" for choice mode (caller must add it explicitly).
    expect(criteria.none).toBeUndefined();
    // No keep_alive when request.keepAlive is absent.
    expect(seen!.keep_alive).toBeUndefined();
  });

  it("forwards keep_alive when request.keepAlive is set, and omits it when not", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeSystemOneClient(async (req) => {
      seen.push(req);
      return wireResponse({ domain: { choice: "filesystem", probabilities: { filesystem: 0.9 } } });
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    await gw.decide(choiceRequest());
    expect(seen[0].keep_alive).toBeUndefined();

    await gw.decide(choiceRequest({ keepAlive: "5m" }));
    expect(seen[1].keep_alive).toBe("5m");
  });

  it("appends a synthetic 'none' option to criteria for noul mode with choices", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = new FakeSystemOneClient(async (req) => {
      seen = req;
      return wireResponse({
        domain: { choice: "none", probabilities: { filesystem: 0.1, none: 0.8 }, confidence: 0.7 },
      });
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    await gw.decide(choiceRequest({ mode: "noul" }));

    const wireQ = (seen!.questions as Record<string, unknown>).domain as Record<string, unknown>;
    expect(wireQ.type).toBe("noul");
    const criteria = wireQ.criteria as Record<string, unknown>;
    // Synthetic "none" appended alongside the declared choices.
    expect(criteria.none).toBe("None of the listed options fit.");
    expect(criteria.filesystem).toBe("read/write/patch files");
  });

  it("emits no criteria field for noul mode without choices (tev1 true/false gating)", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = new FakeSystemOneClient(async (req) => {
      seen = req;
      return wireResponse({ gate: { noul: 0.85, confidence: 0.6 } });
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    await gw.decide(
      choiceRequest({
        mode: "noul",
        questions: [{ id: "gate", prompt: "Is this draft acceptable?" }],
      }),
    );

    const wireQ = (seen!.questions as Record<string, unknown>).gate as Record<string, unknown>;
    expect(wireQ.type).toBe("noul");
    expect(wireQ.instructions).toBe("Is this draft acceptable?");
    expect(wireQ.criteria).toBeUndefined();
  });

  it("builds criteria as an array of descriptions for score mode (lowest level first)", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = new FakeSystemOneClient(async (req) => {
      seen = req;
      return wireResponse({
        complexity: {
          score: 3,
          legend: ["low", "medium", "high", "very high"],
          probabilities: [0.05, 0.1, 0.7, 0.15],
          confidence: 0.8,
        },
      });
    });
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.36.0"),
    });

    await gw.decide(
      choiceRequest({
        mode: "score",
        questions: [
          {
            id: "complexity",
            prompt: "How complex is this request?",
            choices: [
              { id: "low", description: "low" },
              { id: "medium", description: "medium" },
              { id: "high", description: "high" },
              { id: "very-high", description: "very high" },
            ],
          },
        ],
      }),
    );

    const wireQ = (seen!.questions as Record<string, unknown>).complexity as Record<string, unknown>;
    expect(wireQ.type).toBe("score");
    expect(Array.isArray(wireQ.criteria)).toBe(true);
    expect(wireQ.criteria).toEqual(["low", "medium", "high", "very high"]);
  });
});

describe("SystemOneDecisionGateway — wire response parsing (tev1)", () => {
  it("parses a choice answer with probabilities and confidence into DecisionResult", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse({
        domain: { choice: "filesystem", probabilities: { filesystem: 0.92, shell: 0.05, git: 0.03 }, confidence: 0.85 },
      }),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    const result = await gw.decide(choiceRequest());

    expect(result.model).toBe(DEFAULT_MODEL);
    expect(result.mode).toBe("choice");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].questionId).toBe("domain");
    expect(result.decisions[0].selected).toBe("filesystem");
    expect(result.decisions[0].probabilities?.filesystem).toBe(0.92);
    // Confidence preserved as a top-level field AND in raw.
    expect(result.decisions[0].confidence).toBe(0.85);
    expect((result.decisions[0].raw as { confidence: number }).confidence).toBe(0.85);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("parses a noul answer (with choices) where the model chose the synthetic 'none' → selected is undefined", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse({
        domain: {
          choice: "none",
          probabilities: { filesystem: 0.1, shell: 0.05, git: 0.05, none: 0.8 },
          confidence: 0.7,
        },
      }),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    const result = await gw.decide(choiceRequest({ mode: "noul" }));

    expect(result.decisions[0].selected).toBeUndefined();
    // The synthetic "none" probability key is preserved.
    expect(result.decisions[0].probabilities?.none).toBe(0.8);
  });

  it("parses a noul answer (no choices) — noul value maps to score (probability the answer is true)", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ gate: { noul: 0.85, confidence: 0.6 } }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });

    const result = await gw.decide(
      choiceRequest({
        mode: "noul",
        questions: [{ id: "gate", prompt: "Is this draft acceptable?" }],
      }),
    );

    expect(result.decisions[0].questionId).toBe("gate");
    expect(result.decisions[0].score).toBe(0.85);
    expect(result.decisions[0].confidence).toBe(0.6);
    // The raw entry preserves the original `noul` field for replay.
    expect((result.decisions[0].raw as { noul: number }).noul).toBe(0.85);
  });

  it("parses a score answer — score + raw legend/probabilities/confidence preserved", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse({
        complexity: {
          score: 2,
          legend: ["low", "medium", "high", "very high"],
          probabilities: [0.05, 0.1, 0.7, 0.15],
          confidence: 0.8,
        },
      }),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.36.0"),
    });

    const result = await gw.decide(
      choiceRequest({
        mode: "score",
        questions: [
          {
            id: "complexity",
            prompt: "How complex is this request?",
            choices: [{ id: "low", description: "low" }],
          },
        ],
      }),
    );

    expect(result.decisions[0].questionId).toBe("complexity");
    expect(result.decisions[0].score).toBe(2);
    // Legend and array probabilities preserved verbatim in raw (not coerced
    // to a map — tev1's score `probabilities` is an array indexed by level).
    expect((result.decisions[0].raw as { legend: string[] }).legend).toEqual(["low", "medium", "high", "very high"]);
    expect(Array.isArray((result.decisions[0].raw as { probabilities: unknown }).probabilities)).toBe(true);
    expect((result.decisions[0].raw as { confidence: number }).confidence).toBe(0.8);
  });

  it("echoes the request id when supplied", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ domain: { choice: "filesystem" } }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    const result = await gw.decide(choiceRequest({ id: "rid-123" }));
    expect(result.id).toBe("rid-123");
  });

  it("synthesizes a decision id when none was supplied", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ domain: { choice: "filesystem" } }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    const req = choiceRequest();
    delete req.id;
    const result = await gw.decide(req);
    expect(result.id).toMatch(/^decision-/);
  });
});

describe("SystemOneDecisionGateway — environment rules", () => {
  it("rejects with DecisionUnavailableError when the runtime tier is cloud", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({}));
    const gw = new SystemOneDecisionGateway({
      client,
      // Cloud tier is forbidden by the System One contract.
      environment: new StaticEnvironment("cloud", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionUnavailableError);
  });

  it("rejects with DecisionUnavailableError when the Ollama version is below 0.35.0", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({}));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.34.2"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionUnavailableError);
  });

  it("proceeds when the version is unknown (lets the server speak for itself)", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ domain: { choice: "filesystem" } }));
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
    const client = new FakeSystemOneClient(async () => wireResponse({}));
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

describe("SystemOneDecisionGateway — protocol failures (tev1)", () => {
  it("throws DecisionProtocolError when the response has no `answers` object", async () => {
    const client = new FakeSystemOneClient(async () => ({ model: "x" }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when `answers` is not an object (e.g. an array)", async () => {
    const client = new FakeSystemOneClient(async () => ({ answers: [] }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a returned choice is not in the question's choices (and not the synthetic none)", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ domain: { choice: "super_search_repo" } }));
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
      wireResponse({
        domain: { choice: "filesystem", probabilities: { filesystem: "not-a-number" } },
      }),
    );
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when an answer is keyed by an unknown question name", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ "unknown-q": { choice: "filesystem" } }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when the response is missing a requested question", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({}));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(gw.decide(choiceRequest())).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a noul-without-choices answer is missing the `noul` field", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ gate: { confidence: 0.5 } }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(
      gw.decide(
        choiceRequest({
          mode: "noul",
          questions: [{ id: "gate", prompt: "Is this draft acceptable?" }],
        }),
      ),
    ).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a score answer is missing the `score` field", async () => {
    const client = new FakeSystemOneClient(async () => wireResponse({ complexity: { confidence: 0.5 } }));
    const gw = new SystemOneDecisionGateway({
      client,
      environment: new StaticEnvironment("local", "0.35.0"),
    });
    await expect(
      gw.decide(
        choiceRequest({
          mode: "score",
          questions: [{ id: "complexity", prompt: "How complex?" }],
        }),
      ),
    ).rejects.toBeInstanceOf(DecisionProtocolError);
  });

  it("throws DecisionProtocolError when a choice answer is missing the `choice` field", async () => {
    const client = new FakeSystemOneClient(async () =>
      wireResponse({ domain: { probabilities: { filesystem: 0.9 } } }),
    );
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
      return wireResponse({});
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
