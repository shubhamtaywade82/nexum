import {
  DecisionMode,
  DecisionQuestion,
  DecisionRequest,
  validateDecisionRequest,
  validateDecisionQuestion,
} from "../../../src/models/decision/types.js";
import { DecisionProtocolError } from "../../../src/models/decision/errors.js";

describe("Decision contracts — validateDecisionQuestion", () => {
  it("accepts a valid choice question with bounded choices", () => {
    const q: DecisionQuestion = {
      id: "q1",
      prompt: "Which domain does this request need?",
      choices: [
        { id: "filesystem", description: "read/write files" },
        { id: "shell", description: "run shell commands" },
      ],
    };
    expect(() => validateDecisionQuestion(q)).not.toThrow();
  });

  it("accepts a valid score question without choices", () => {
    const q: DecisionQuestion = {
      id: "q2",
      prompt: "How relevant is shell to this request? (0..1)",
    };
    expect(() => validateDecisionQuestion(q)).not.toThrow();
  });

  it("rejects an empty question id", () => {
    expect(() => validateDecisionQuestion({ id: "", prompt: "x" })).toThrow(DecisionProtocolError);
  });

  it("rejects an empty prompt", () => {
    expect(() => validateDecisionQuestion({ id: "q1", prompt: "   " })).toThrow(DecisionProtocolError);
  });

  it("rejects choices with a duplicate id within the same question", () => {
    const q: DecisionQuestion = {
      id: "q1",
      prompt: "pick one",
      choices: [
        { id: "a", description: "first" },
        { id: "a", description: "second" },
      ],
    };
    expect(() => validateDecisionQuestion(q)).toThrow(/duplicate choice id/i);
  });

  it("rejects choices with an empty id", () => {
    const q: DecisionQuestion = {
      id: "q1",
      prompt: "pick one",
      choices: [{ id: "", description: "first" }],
    };
    expect(() => validateDecisionQuestion(q)).toThrow(DecisionProtocolError);
  });

  it("accepts a bounded set of choices (more than one allowed)", () => {
    const q: DecisionQuestion = {
      id: "q1",
      prompt: "pick",
      choices: [
        { id: "a", description: "A" },
        { id: "b", description: "B" },
        { id: "c", description: "C" },
      ],
    };
    expect(() => validateDecisionQuestion(q)).not.toThrow();
  });
});

describe("Decision contracts — validateDecisionRequest", () => {
  const validChoice = (mode: DecisionMode): DecisionRequest => ({
    id: "d1",
    model: "mpuig/system-one-minicpm5-2b-q8",
    mode,
    context: "User asked: 'read the file config.json and patch a typo'. Tools available include filesystem and shell.",
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
  });

  it("accepts a valid choice decision with one question", () => {
    expect(() => validateDecisionRequest(validChoice("choice"))).not.toThrow();
  });

  it("accepts a valid score decision", () => {
    expect(() => validateDecisionRequest(validChoice("score"))).not.toThrow();
  });

  it("accepts a valid noul (no-overlap-of-universe) decision", () => {
    expect(() => validateDecisionRequest(validChoice("noul"))).not.toThrow();
  });

  it("accepts a request with multiple questions (batch decision)", () => {
    const req = validChoice("choice");
    req.questions = [
      { id: "domain", prompt: "which domain?", choices: [{ id: "fs", description: "filesystem" }] },
      { id: "complexity", prompt: "single-step or multi-step?" },
    ];
    expect(() => validateDecisionRequest(req)).not.toThrow();
  });

  it("rejects an empty questions array", () => {
    const req = validChoice("choice");
    req.questions = [];
    expect(() => validateDecisionRequest(req)).toThrow(/at least one question/i);
  });

  it("rejects an empty model string", () => {
    const req = validChoice("choice");
    req.model = "   ";
    expect(() => validateDecisionRequest(req)).toThrow(/model/i);
  });

  it("rejects an invalid mode", () => {
    const req = validChoice("choice");
    (req as { mode: string }).mode = "frobnicate";
    expect(() => validateDecisionRequest(req)).toThrow(/mode/i);
  });

  it("rejects when the context alone exceeds the 64 KiB System One limit", () => {
    const req = validChoice("choice");
    req.context = "x".repeat(70_000);
    expect(() => validateDecisionRequest(req)).toThrow(/context.*64.*kib/i);
  });

  it("rejects when the total serialized request would exceed 64 KiB", () => {
    const req = validChoice("choice");
    req.context = "x".repeat(40_000);
    req.questions = [
      {
        id: "q1",
        prompt: "y".repeat(40_000),
        choices: [{ id: "filesystem", description: "z".repeat(5_000) }],
      },
    ];
    expect(() => validateDecisionRequest(req)).toThrow(/64.*kib/i);
  });
});
