import { describe, it, expect } from "@jest/globals";
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
    const res = (await inspect.call({ path: "." })) as Record<string, unknown>;
    expect(res.root).toBeDefined();
    expect(Array.isArray(res.detectedStacks)).toBe(true);
    expect(res.detectedStacks).toContain("node-typescript");
    expect(res.packageManagers).toContain("npm");
  });

  it("tools expose valid schema descriptors", () => {
    const root = process.cwd();
    const specTool = new SdlcValidateSpecTool(root);
    expect(specTool.name).toBe("sdlc_validate_spec");
    expect(specTool.parameters.type).toBe("object");

    const planTool = new SdlcValidatePlanTool(root);
    expect(planTool.name).toBe("sdlc_validate_plan");
    expect(planTool.parameters.type).toBe("object");

    const verifyTool = new SdlcVerifyTool(root);
    expect(verifyTool.name).toBe("sdlc_verify");
    expect(verifyTool.parameters.type).toBe("object");
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
