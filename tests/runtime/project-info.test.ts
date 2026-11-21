import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProjectInfo } from "../../src/runtime/project-info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("detectProjectInfo", () => {
  it("detects TypeScript + React + Jest from package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-project-info-"));
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { react: "^19.0.0" }, devDependencies: { jest: "^30.0.0" } }),
      );
      expect(detectProjectInfo(dir)).toEqual({ language: "TypeScript", framework: "React", testFramework: "Jest" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Ruby + Rails + RSpec from an existing Rails fixture", () => {
    const info = detectProjectInfo(join(__dirname, "..", "fixtures", "rails-app"));
    expect(info).toEqual({ language: "Ruby", framework: "Rails", testFramework: "RSpec" });
  });

  it("returns an empty object when neither package.json nor Gemfile exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-project-info-empty-"));
    try {
      expect(detectProjectInfo(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
