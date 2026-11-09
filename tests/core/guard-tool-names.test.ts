/**
 * Name-keyed guards (execution-profile denylists, the crypto agent's required
 * tools, the legacy risk table) must name the tool the code actually registers.
 * A phantom name makes the guard silently inert: the paper-trade tool was once
 * registered as binance_paper_trade while every guard said paper_trade.
 */
import { BinancePaperTradeTool } from "../../src/tools/paper-trading-tools.js";
import { EXECUTION_PROFILES } from "../../src/core/policy/execution-profiles.js";
import { cryptoAgentDescriptor } from "../../src/agents/cryptoagent/crypto-agent.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { Tool } from "../../src/tools/tool.js";
import type { PaperTradingManager } from "../../src/domains/trading/paper-trading.js";

const PAPER_TOOL = new BinancePaperTradeTool({} as PaperTradingManager).name;

describe("name-keyed guards refer to the registered paper-trade tool", () => {
  it("the registered name is binance_paper_trade", () => {
    expect(PAPER_TOOL).toBe("binance_paper_trade");
  });

  it("read-only and testing profiles deny it by name", () => {
    expect(EXECUTION_PROFILES.readonly.deniedTools).toContain(PAPER_TOOL);
    expect(EXECUTION_PROFILES.testing.deniedTools).toContain(PAPER_TOOL);
  });

  it("the crypto agent requires a tool that is actually registered", () => {
    expect(cryptoAgentDescriptor("paper").requiredTools).toContain(PAPER_TOOL);
  });

  it("every profile denylist names only tools that exist somewhere in the built-in tool set", () => {
    const known = new Set([PAPER_TOOL, "run_shell", "docker", "git", "github"]);
    for (const profile of Object.values(EXECUTION_PROFILES)) {
      for (const name of profile.deniedTools) {
        expect({ profile: profile.name, name, known: known.has(name) }).toEqual({
          profile: profile.name,
          name,
          known: true,
        });
      }
    }
  });

  it("a legacy registration under the real name is classified critical", () => {
    class Paper extends Tool {
      get name(): string {
        return PAPER_TOOL;
      }
      get description(): string {
        return "paper";
      }
      get parameters(): Record<string, unknown> {
        return { type: "object", properties: {} };
      }
      async call(): Promise<Record<string, unknown>> {
        return {};
      }
    }
    const catalog = new ToolCatalog();
    catalog.registerLegacy(new Paper(), "Market");
    expect(catalog.definition(PAPER_TOOL)?.risk).toBe("critical");
  });
});
