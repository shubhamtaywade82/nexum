/**
 * CryptoAgent — the trading PRODUCT agent (review items 40 + 30 + 31).
 *
 * Composes Nexum Core (never the other way around) with:
 *   - the TradingPack (market data, backtesting, paper trading)
 *   - a TRADING-MODE policy posture (review item 31): research/backtest/
 *     paper/shadow/live with progressively stricter permissions
 *   - the TradingExecutionPipeline (review item 30): LLM proposals are
 *     advisory; deterministic validation + risk + policy execute.
 *
 * The LLM never routes an order directly: the binance_paper_trade tool and the
 * pipeline both pass through the deterministic gate chain.
 */

import { DefaultAgentRuntime, AgentRegistry, type AgentDescriptor } from "../../runtime/agent/agent-runtime.js";
import { createManagedExecutionContext } from "../../runtime/context/execution-context.js";
import { profilePosture } from "../../core/policy/postures.js";
import { tradingProfile, TradingExecutionMode } from "../../core/policy/execution-profiles.js";
import { IdempotencyManager } from "../../tools/idempotency.js";
import { DefaultToolGateway, ToolGateway } from "../../tools/gateway/tool-gateway.js";
import { ToolCatalog } from "../../tools/gateway/tool-catalog.js";
import { mountToolPack, type ToolPack } from "../../tools/gateway/tool-pack.js";
import type { ModelGateway } from "../../models/gateway/model-gateway.js";
import type { ExecutionRequest, ExecutionResult, ExecutionContext } from "../../core/types.js";
import {
  TradingExecutionPipeline,
  type TradingExecutionPipelineOptions,
} from "../../domains/trading/execution/pipeline.js";
import type { BinanceStreamManager } from "../../domains/trading/binance-stream.js";

export interface CryptoAgentOptions {
  modelGateway: ModelGateway;
  stream: BinanceStreamManager;
  packs?: ToolPack[];
  /**
   * Trading execution mode (review item 31): research → backtest → paper →
   * shadow → live, progressively stricter. Default "paper".
   */
  tradingMode?: TradingExecutionMode;
  /** Risk limits for the execution pipeline (operator-configured). */
  riskLimits?: TradingExecutionPipelineOptions["limits"];
  runtime?: DefaultAgentRuntime;
}

export function cryptoAgentDescriptor(mode: TradingExecutionMode = "paper"): AgentDescriptor {
  return {
    id: "crypto-agent",
    displayName: "Nexum CryptoAgent",
    description:
      "Trading agent: market analysis, backtesting, paper/shadow/live execution via the deterministic pipeline.",
    defaultCapability: "tools",
    defaultStrategy: "react",
    capabilities: ["market", "trading", "analysis"],
    requiredTools: ["binance_paper_trade"],
    allowedPolicies: [`trading:${mode}`],
    supportedStrategies: ["react", "plan_execute", "graph"],
    allowedPackIds: ["trading"],
    supportedModels: undefined,
  };
}

export class CryptoAgent {
  readonly runtime: DefaultAgentRuntime;
  readonly toolGateway: ToolGateway;
  readonly pipeline: TradingExecutionPipeline;
  readonly descriptor: AgentDescriptor;
  readonly tradingMode: TradingExecutionMode;

  private readonly modelGateway: ModelGateway;
  private readonly catalog: ToolCatalog;

  constructor(opts: CryptoAgentOptions) {
    this.modelGateway = opts.modelGateway;
    this.catalog = new ToolCatalog();
    this.tradingMode = opts.tradingMode ?? "paper";
    this.descriptor = cryptoAgentDescriptor(this.tradingMode);

    // trading-mode posture (review items 8 + 31): the profile's permissions
    // replace command blacklists — paper forbids live routing by construction
    const posture = profilePosture(tradingProfile(this.tradingMode));
    this.toolGateway = new DefaultToolGateway({
      catalog: this.catalog,
      policyEngine: posture,
      validation: "strict",
      label: `crypto-agent:${this.tradingMode}`,
      idempotency: new IdempotencyManager(),
    });

    this.runtime = opts.runtime ?? new DefaultAgentRuntime();
    if (!(this.runtime.agents as AgentRegistry).get(this.descriptor.id)) {
      this.runtime.agents.register(this.descriptor);
    }

    for (const pack of opts.packs ?? []) {
      mountToolPack(pack, this.catalog);
    }

    // deterministic execution pipeline (review item 30): paper mode wires the
    // paper ledger; live mode REQUIRES a product-supplied venue adapter
    this.pipeline = new TradingExecutionPipeline({
      mode: this.tradingMode,
      limits: opts.riskLimits,
      paper: undefined,
      priceOf: (symbol) => opts.stream.getLatest(symbol, "spot")?.price,
    });
  }

  /** Execute one analysis/research task through the kernel. */
  async execute(
    request: ExecutionRequest,
    context?: Partial<Parameters<typeof createManagedExecutionContext>[1]>,
  ): Promise<ExecutionResult> {
    const ctx: ExecutionContext = createManagedExecutionContext(
      { ...request, agentId: this.descriptor.id },
      {
        modelGateway: this.modelGateway,
        toolGateway: this.toolGateway,
        ...context,
      },
    );
    return this.runtime.execute({ ...request, agentId: this.descriptor.id }, ctx);
  }

  cancel(runId: string): boolean {
    return this.runtime.cancel(runId);
  }
}
