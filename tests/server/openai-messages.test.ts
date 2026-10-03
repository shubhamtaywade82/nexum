import { composeGoal, parseConversation } from "../../src/host/openai/messages.js";

type Messages = Parameters<typeof parseConversation>[0];

describe("parseConversation", () => {
  it("should take the last user message as the goal and the earlier turns as history", () => {
    const result = parseConversation([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);

    expect(result).toEqual({
      ok: true,
      conversation: {
        goal: "second",
        context: "",
        history: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
        ],
      },
    });
  });

  it("should gather system and developer messages as context, wherever they appear", () => {
    const result = parseConversation([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "developer", content: "Use metric units." },
      { role: "user", content: "weather?" },
    ]);

    expect(result.ok && result.conversation.context).toBe("Be brief.\n\nUse metric units.");
    expect(result.ok && result.conversation.goal).toBe("weather?");
  });

  it("should join text content parts", () => {
    const result = parseConversation([
      {
        role: "user",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ]);

    expect(result.ok && result.conversation.goal).toBe("line one\nline two");
  });

  it("should refuse content Nexum cannot read, naming the part type", () => {
    const result = parseConversation([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] },
    ] as Messages);

    expect(result).toEqual({ ok: false, message: 'only text content is supported, got a "image_url" part' });
  });

  it.each([
    [
      "the last message is from the assistant",
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    ],
    ["the last user message is empty", [{ role: "user", content: "" }]],
    ["there is only a system message", [{ role: "system", content: "x" }]],
  ])("should refuse a request where %s", (_name, messages) => {
    expect(parseConversation(messages as Messages).ok).toBe(false);
  });

  it("should ignore the client's own tool results and empty assistant turns", () => {
    const result = parseConversation([
      { role: "user", content: "a" },
      { role: "assistant", content: null },
      { role: "tool", content: "tool output" },
      { role: "user", content: "b" },
    ]);

    expect(result.ok && result.conversation.history).toEqual([{ role: "user", content: "a" }]);
  });
});

describe("composeGoal", () => {
  it("should lead with the client's context only when there is some", () => {
    expect(composeGoal({ goal: "do it", context: "", history: [] })).toBe("do it");
    expect(composeGoal({ goal: "do it", context: "ctx", history: [] })).toBe(
      "Context from the client:\nctx\n\nUser request:\ndo it",
    );
  });
});
