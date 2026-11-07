import { formatDiagnosesText } from "../../src/evolution/cli.js";

describe("formatDiagnosesText empty-state wording", () => {
  it("does not claim the harness is healthy when no episodes were recorded", () => {
    const text = formatDiagnosesText([], null, 0);

    expect(text).toMatch(/no episodes/i);
    expect(text).toMatch(/not evidence/i);
    expect(text).not.toMatch(/No harness weaknesses detected/);
  });

  it("states how many episodes were evaluated when none show a weakness", () => {
    expect(formatDiagnosesText([], null, 7)).toBe("No harness weaknesses detected across 7 evaluated episode(s).");
  });

  it("keeps the legacy wording when the episode count is not supplied", () => {
    expect(formatDiagnosesText([], null)).toBe("No harness weaknesses detected across evaluated episodes.");
  });
});
