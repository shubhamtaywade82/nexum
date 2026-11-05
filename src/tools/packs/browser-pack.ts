/**
 * BrowserPack (review item 21) — browser automation surface.
 */

import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserFillTool,
  BrowserGetTextTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
  BrowserCloseTool,
  type ScreenshotSink,
} from "../browser-tools.js";
import { BrowserManager } from "../../browser/manager.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";
import type { ToolRisk } from "../../core/tools/tool-contract.js";

export function browserPack(browser: BrowserManager, screenshots?: () => ScreenshotSink | undefined): ToolPack {
  return packOf(
    "browser",
    "Browser automation: navigate, click, fill, extract, screenshot, evaluate.",
    "browser",
    [
      new BrowserNavigateTool(browser),
      new BrowserClickTool(browser),
      new BrowserFillTool(browser),
      new BrowserGetTextTool(browser),
      new BrowserScreenshotTool(browser, screenshots),
      new BrowserEvaluateTool(browser),
      new BrowserCloseTool(browser),
    ].map((tool) => ({ tool, category: "Browser", metadata: { risk: "medium" as ToolRisk } })),
    "Browser",
  );
}
