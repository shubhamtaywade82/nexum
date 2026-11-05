import { ModelStack } from "../../src/cli/services/model-stack.js";
import { FakeDecisionGateway } from "../../src/models/decision/fake-gateway.js";
import { DecisionError, DecisionTransportError, type DecisionGateway } from "../../src/models/decision/index.js";
import type { DecisionRequest } from "../../src/models/decision/types.js";
import type { CliConfig } from "../../src/cli/config.js";

// Decision Plane integration into the ModelStack: the stack owns a
// `decisionGateway` (or undefined), and the primary generation model is
// independent of the decision model. The fake gateway proves the DI seam.

function baseCfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    model: "qwen3.5:4b",
    workspaceRoot: "/tmp/nexum-decision-stack-test",
    tier: "local",
    enableAvailabilityCheck: false,
    enableDecision: true,
    decisionModel: "tev1",
    workspaceTrust: { status: "trusted", trusted: true, withheldKeys: [], skippedEnvFiles: [] },
    ...overrides,
  } as CliConfig;
}

describe("ModelStack — Decision Plane integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Local Ollama unreachable in tests — the auto-built gateway must not
    // depend on a live Ollama to construct (it does its own health checks
    // lazily, only when `decide()` is called).
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it("exposes a `decisionGateway` field (undefined when disabled, set when enabled)", () => {
    const disabled = new ModelStack(baseCfg({ enableDecision: false }), () => {});
    expect(disabled.decisionGateway).toBeUndefined();

    const enabled = new ModelStack(baseCfg({ enableDecision: true }), () => {});
    expect(enabled.decisionGateway).toBeDefined();
    expect(enabled.decisionGateway!.engine).toBe("system-one");
  });

  it("does NOT build a decisionGateway when tier is cloud (System One is local-only)", () => {
    // System One rejects the cloud tier per its contract. The ModelStack
    // surfaces this as `decisionGateway === undefined`, never as a gateway
    // that silently routes to Provider.chat on the cloud tier.
    const stack = new ModelStack(baseCfg({ tier: "cloud", apiKey: "k", enableDecision: true }), () => {});
    expect(stack.decisionGateway).toBeUndefined();
  });

  it("uses an injected FakeDecisionGateway instead of the auto-built one (DI seam)", () => {
    const fake = new FakeDecisionGateway({ decisions: { domain: { selected: "filesystem" } } });
    const stack = new ModelStack(baseCfg(), () => {}, { decisionGateway: fake });
    expect(stack.decisionGateway).toBe(fake);
  });

  it("keeps the primary generation model independent of the decision model", () => {
    const stack = new ModelStack(baseCfg({ model: "qwen3.5:4b", decisionModel: "tev1" }), () => {});
    expect(stack.currentModel).toBe("qwen3.5:4b");
    expect(stack.decisionModel).toBe("tev1");
  });

  it("surfaces a typed DecisionError (transport failure) when decide() is called against an unreachable local Ollama — never a silent chat fallback", async () => {
    // With the real OllamaSystemOneClient adapter wired (SDK 1.7.0+ exports
    // the System One operation via its public `./generated/api` subpath),
    // the auto-built gateway actually attempts the SDK call. When the local
    // Ollama is unreachable (the test environment mocks fetch to reject),
    // the SDK throws a transport error and the gateway surfaces it as a
    // typed DecisionError — never a silent Provider.chat fallback.
    const stack = new ModelStack(baseCfg(), () => {});
    const req: DecisionRequest = {
      id: "d1",
      model: "tev1",
      mode: "choice",
      context: "User asked to read a file.",
      questions: [
        {
          id: "domain",
          prompt: "which domain?",
          choices: [{ id: "filesystem", description: "read/write files" }],
        },
      ],
    };
    await expect(stack.decisionGateway!.decide(req)).rejects.toBeInstanceOf(DecisionError);
    await expect(stack.decisionGateway!.decide(req)).rejects.toBeInstanceOf(DecisionTransportError);
  });

  it("does not mutate shared model state when an injected decisionGateway runs concurrently with a generation call", async () => {
    // A concurrent decision + generation pair must not leak the decision
    // model onto the Provider's `currentModel`. The decision gateway
    // receives its own model in the DecisionRequest; the Provider is
    // untouched. We verify this by issuing both calls in parallel and
    // asserting that `currentModel` is unchanged throughout and after.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const fake: DecisionGateway = {
      engine: "fake",
      decide: async (req) => {
        // Hold the decision open across an await so it overlaps the
        // provider.chat call below.
        await gate;
        return {
          id: req.id ?? "d",
          model: req.model,
          mode: req.mode,
          decisions: [],
          latencyMs: 1,
        };
      },
    };

    // Mock the local Provider.chat at the instance level — the SDK
    // transport never enters the picture here, so there is no fetch or
    // streaming parsing involved. This test isolates the model-isolation
    // invariant from the transport layer.
    const stack = new ModelStack(baseCfg(), () => {}, { decisionGateway: fake });
    let chatCalledModel: string | undefined;
    jest.spyOn(stack.provider, "chat").mockImplementation(async (_msgs, opts) => {
      chatCalledModel = opts?.model ?? stack.currentModel;
      return {
        message: { role: "assistant", content: "hello" },
        done: true,
      } as any;
    });

    expect(stack.currentModel).toBe("qwen3.5:4b");

    const decisionP = stack.decisionGateway!.decide({
      id: "d",
      model: "tev1",
      mode: "choice",
      context: "x",
      questions: [{ id: "domain", prompt: "x", choices: [{ id: "fs", description: "fs" }] }],
    });
    const chatP = stack.provider.chat([{ role: "user", content: "hello" }]);

    // Let chatP settle first (it has no await) so chatCalledModel is
    // populated before we release the decision gate.
    await chatP;
    // Mid-flight: the decision model is in flight, but the shared Provider
    // has not been mutated to it.
    expect(stack.currentModel).toBe("qwen3.5:4b");

    releaseGate();
    const decisionResult = await decisionP;

    expect(decisionResult.model).toBe("tev1");
    // The chat call saw the primary model (not the decision model).
    expect(chatCalledModel).toBe("qwen3.5:4b");
    // Critical invariant: the decision model never replaced the primary
    // generation model on the shared Provider instance.
    expect(stack.currentModel).toBe("qwen3.5:4b");
  });
});
