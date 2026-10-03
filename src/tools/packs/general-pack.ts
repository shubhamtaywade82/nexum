/**
 * GeneralPack — everyday read-only utilities: arithmetic, weather and
 * Wikipedia lookup. All are read-risk and opt in to direct calls from rendered UIs.
 */

import { CalculatorTool, WeatherTool, WebSearchTool } from "../general-tools.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";

export function generalPack(): ToolPack {
  return packOf("general", "Arithmetic, weather and Wikipedia lookup.", "general", [
    [new CalculatorTool(), { risk: "read", policy: { uiInvocable: true } }],
    [new WeatherTool(), { risk: "read", sideEffects: { network: true }, policy: { uiInvocable: true } }],
    [new WebSearchTool(), { risk: "read", sideEffects: { network: true }, policy: { uiInvocable: true } }],
  ]);
}
