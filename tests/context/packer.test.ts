import { ContextPacker } from "../../src/context/packer.js";

const packTaskContext = (...args: Parameters<ContextPacker["pack"]>) => new ContextPacker().pack(...args);

describe("Context - Packer", () => {
  it("packs task goal and relevant code within character budget", () => {
    const res = packTaskContext({
      goal: "fix authentication bug",
      code: [
        { path: "src/auth.ts", symbol: "login", text: "export function login() { return true; }", score: 1 },
        { path: "src/unrelated.ts", text: "export const pi = 3.14;" },
      ],
    });

    expect(res.promptBlock).toContain("<task_goal>");
    expect(res.promptBlock).toContain("fix authentication bug");
    expect(res.promptBlock).toContain("src/auth.ts");
    expect(res.includedIds).toContain("goal");
  });

  it("prioritizes diagnostics over code", () => {
    const res = packTaskContext({
      goal: "fix build error",
      diagnostics: [{ path: "src/main.ts", message: "SyntaxError: Unexpected token", severity: "error" }],
      code: [{ path: "src/main.ts", text: "const x = ;", score: 1 }],
    });

    expect(res.promptBlock).toContain("<diagnostics>");
    expect(res.promptBlock).toContain("SyntaxError");
  });

  it("truncates or excludes items that exceed maxChars budget", () => {
    const res = packTaskContext(
      {
        goal: "test budget",
        code: [{ path: "huge.ts", text: "x".repeat(1000), score: 1 }],
      },
      { maxChars: 100 },
    );

    expect(res.truncated).toBe(true);
  });
});
