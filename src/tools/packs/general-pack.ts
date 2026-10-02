/**
 * GeneralPack — everyday read-only utilities: arithmetic, weather and
 * Wikipedia lookup. All are read-risk, so rendered UIs may call them too.
 */

import { CalculatorTool, WeatherTool, WebSearchTool } from "../general-tools.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";

export function generalPack(): ToolPack {
  return packOf("general", "Arithmetic, weather and Wikipedia lookup.", "general", [
    [new CalculatorTool(), { risk: "read" }],
    [new WeatherTool(), { risk: "read", sideEffects: { network: true } }],
    [new WebSearchTool(), { risk: "read", sideEffects: { network: true } }],
  ]);
}
