import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveKitCliPath,
  SdlcDoctorTool,
  SdlcInspectTool,
  SdlcValidateSpecTool,
  SdlcValidatePlanTool,
  SdlcVerifyTool,
} from "../../src/tools/sdlc-tools.js";
import { sdlcPack } from "../../src/tools/packs/sdlc-pack.js";

describe("Agentic SDLC Kit Tools", () => {
  let fixtureDir: string | null = null;
  const originalEnv = process.env.NEXUM_SDLC_KIT_PATH;

  beforeAll(() => {
    // Provide a deterministic mock CLI fixture for unit tests
    fixtureDir = mkdtempSync(join(tmpdir(), "nexum-kit-fixture-"));
    const fixtureScript = join(fixtureDir, "mock-kit.js");
    writeFileSync(
      fixtureScript,
      `#!/usr/bin/env node
const cmd = process.argv[2];
if (process.argv.some((a) => a.includes("fail"))) {
  console.error("command failure mock");
  process.exit(1);
}
if (process.argv.some((a) => a.includes("non-json"))) {
  console.log("plain text fallback output");
  process.exit(0);
}
if (cmd === "doctor") {
  console.log("kit 0.7.1\\n  node 24.19.0 [ok]\\n  git found [ok]\\n  profile .ai-kit/project.yml present [ok]\\nStatus: healthy");
  process.exit(0);
}
if (cmd === "inspect") {
  console.log(
    JSON.stringify({
      root: "/workspace",
      detectedStacks: ["node-typescript"],
      packageManagers: ["npm"],
      testTooling: ["jest"],
      entryPoints: ["src/index.ts"],
      hasMigrations: false,
      hasCiPipeline: true,
      instructionFiles: ["AGENTS.md"],
      gitStatus: "clean",
    }),
  );
  process.exit(0);
}
if (cmd === "validate-spec") {
  console.log(JSON.stringify({ valid: true, spec: "feature" }));
  process.exit(0);
}
if (cmd === "validate-plan") {
  console.log(JSON.stringify({ valid: true, plan: "dag" }));
  process.exit(0);
}
if (cmd === "verify") {
  console.log(JSON.stringify({ status: "verified", passed: 4 }));
  process.exit(0);
}
process.exit(0);
`,
    );
    process.env.NEXUM_SDLC_KIT_PATH = fixtureScript;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.NEXUM_SDLC_KIT_PATH = originalEnv;
    } else {
      delete process.env.NEXUM_SDLC_KIT_PATH;
    }
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("resolves the kit CLI path", () => {
    const cliPath = resolveKitCliPath();
    expect(cliPath).not.toBeNull();
    expect(typeof cliPath).toBe("string");
  });

  it("sdlc_doctor checks kit health", async () => {
    const doctor = new SdlcDoctorTool();
    expect(doctor.name).toBe("sdlc_doctor");
    const res = await doctor.call({});
    expect(res.status).toBe("healthy");
    expect(String(res.output)).toContain("kit");
  });

  it("sdlc_inspect inspects the current repository", async () => {
    const inspect = new SdlcInspectTool(process.cwd());
    expect(inspect.name).toBe("sdlc_inspect");
    expect(inspect.parameters.type).toBe("object");

    const res = (await inspect.call({ path: "." })) as Record<string, unknown>;
    expect(res.root).toBeDefined();
    expect(Array.isArray(res.detectedStacks)).toBe(true);
    expect(res.detectedStacks).toContain("node-typescript");
    expect(res.packageManagers).toContain("npm");

    const defaultRes = (await inspect.call({})) as Record<string, unknown>;
    expect(defaultRes.root).toBeDefined();
  });

  it("sdlc_validate_spec validates specification with defaults and non-json output", async () => {
    const specTool = new SdlcValidateSpecTool(process.cwd());
    const res = (await specTool.call({ path: "docs/spec.md" })) as Record<string, unknown>;
    expect(res.valid).toBe(true);
    expect(res.spec).toBe("feature");

    const defaultRes = (await specTool.call({})) as Record<string, unknown>;
    expect(defaultRes.valid).toBe(true);

    const nonJsonRes = (await specTool.call({ path: "--non-json" })) as Record<string, unknown>;
    expect(nonJsonRes.output).toBe("plain text fallback output");
  });

  it("sdlc_validate_plan validates implementation plan with defaults", async () => {
    const planTool = new SdlcValidatePlanTool(process.cwd());
    const res = (await planTool.call({ path: "docs/plan.md" })) as Record<string, unknown>;
    expect(res.valid).toBe(true);
    expect(res.plan).toBe("dag");

    const defaultRes = (await planTool.call({})) as Record<string, unknown>;
    expect(defaultRes.valid).toBe(true);
  });

  it("sdlc_verify executes verification commands with defaults", async () => {
    const verifyTool = new SdlcVerifyTool(process.cwd());
    const res = (await verifyTool.call({ dryRun: true })) as Record<string, unknown>;
    expect(res.status).toBe("verified");
    expect(res.passed).toBe(4);

    const defaultRes = (await verifyTool.call({})) as Record<string, unknown>;
    expect(defaultRes.status).toBe("verified");
  });

  it("handles missing kit CLI gracefully", async () => {
    process.env.NEXUM_SDLC_KIT_DISABLED = "true";
    try {
      expect(resolveKitCliPath()).toBeNull();
      const doctor = new SdlcDoctorTool();
      await expect(doctor.call({})).rejects.toThrow("Agentic SDLC Kit CLI not found");
    } finally {
      delete process.env.NEXUM_SDLC_KIT_DISABLED;
    }
  });

  it("handles tool execution failures cleanly", async () => {
    const inspect = new SdlcInspectTool(process.cwd());
    await expect(inspect.call({ path: "--fail" })).rejects.toThrow("kit inspect failed");

    const specTool = new SdlcValidateSpecTool(process.cwd());
    await expect(specTool.call({ path: "--fail" })).rejects.toThrow("kit validate-spec failed");

    const planTool = new SdlcValidatePlanTool(process.cwd());
    await expect(planTool.call({ path: "--fail" })).rejects.toThrow("kit validate-plan failed");

    const verifyTool = new SdlcVerifyTool(process.cwd());
    await expect(verifyTool.call({ path: "--fail" })).rejects.toThrow("kit verify failed");
  });

  it("tools expose valid schema descriptors and descriptions", () => {
    const root = process.cwd();
    const inspect = new SdlcInspectTool(root);
    expect(inspect.description).toContain("Inspect a repository");

    const specTool = new SdlcValidateSpecTool(root);
    expect(specTool.name).toBe("sdlc_validate_spec");
    expect(specTool.description).toContain("Validate a feature specification");
    expect(specTool.parameters.type).toBe("object");

    const planTool = new SdlcValidatePlanTool(root);
    expect(planTool.name).toBe("sdlc_validate_plan");
    expect(planTool.description).toContain("Validate an implementation plan");
    expect(planTool.parameters.type).toBe("object");

    const verifyTool = new SdlcVerifyTool(root);
    expect(verifyTool.name).toBe("sdlc_verify");
    expect(verifyTool.description).toContain("Execute deterministic verification");
    expect(verifyTool.parameters.type).toBe("object");

    const doctor = new SdlcDoctorTool();
    expect(doctor.description).toContain("Check Agentic SDLC Kit toolchain");
    expect(doctor.parameters.type).toBe("object");
  });

  it("sdlcPack builds a complete 5-tool pack", () => {
    const pack = sdlcPack(process.cwd());
    expect(pack.id).toBe("sdlc");
    expect(pack.capability).toBe("sdlc");
    expect(pack.entries).toHaveLength(5);
    const names = pack.entries.map((e) => e.tool.name);
    expect(names).toContain("sdlc_inspect");
    expect(names).toContain("sdlc_validate_spec");
    expect(names).toContain("sdlc_validate_plan");
    expect(names).toContain("sdlc_verify");
    expect(names).toContain("sdlc_doctor");
  });
});
