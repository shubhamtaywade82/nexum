/**
 * SdlcPack — Agentic Software Development Lifecycle (SDLC) tools.
 *
 * Exposes repository stack discovery, specification validation, plan DAG
 * verification, and deterministic verification from the Agentic SDLC Kit.
 */

import {
  SdlcInspectTool,
  SdlcValidateSpecTool,
  SdlcValidatePlanTool,
  SdlcVerifyTool,
  SdlcDoctorTool,
} from "../sdlc-tools.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";

export function sdlcPack(workspaceRoot: string): ToolPack {
  return packOf(
    "sdlc",
    "Agentic Software Development Lifecycle (SDLC) inspection, validation, and verification tools.",
    "sdlc",
    [
      new SdlcInspectTool(workspaceRoot),
      new SdlcValidateSpecTool(workspaceRoot),
      new SdlcValidatePlanTool(workspaceRoot),
      new SdlcVerifyTool(workspaceRoot),
      new SdlcDoctorTool(),
    ],
    "SDLC",
  );
}
