/**
 * Trading Module - Main Entry Point
 *
 * This module provides a unified interface for the automated trading system.
 * It integrates all components: Binance service, risk management, workflows, and scheduling.
 */

import { getTradingConfig, type TradingConfig } from "./config/trading";
import {
  getBinanceService,
  type BinanceService,
} from "./services/binance/client";
import {
  getBinanceWebSocketService,
  type BinanceWebSocketService,
  type AccountUpdateEvent,
  type OrderUpdateEvent,
  type PriceUpdate,
} from "./services/binance/websocket";
import { getRiskManager, type RiskManager } from "./services/risk/risk-manager";
import {
  getTradingScheduler,
  createDefaultTradingScheduler,
  type TradingScheduler,
} from "./services/scheduler/trading-scheduler";
import {
  mastra,
  tradingAgent,
  riskAgent,
  tradeExecutionWorkflow,
  positionManagementWorkflow,
  analysisWorkflow,
} from "./mastra";
import {
  type Position,
  type Order,
  type TradeExecutionResult,
  type AnalysisResponse,
  type MarketStateResponse,
} from "./types/trading";

export interface TradingModuleConfig {
  autoStart?: boolean;
  symbols?: string[];
  onAccountUpdate?: (event: AccountUpdateEvent) => void;
  onOrderUpdate?: (event: OrderUpdateEvent) => void;
  onPriceUpdate?: (event: PriceUpdate) => void;
}

export class TradingModule {
  private config: TradingConfig;
  private binance: BinanceService;
  private webSocket: BinanceWebSocketService;
  private riskManager: RiskManager;
  private scheduler: TradingScheduler;
  private isRunning = false;
  private symbols: string[];

  constructor(moduleConfig?: TradingModuleConfig) {
    this.config = getTradingConfig();
    this.binance = getBinanceService();
    this.webSocket = getBinanceWebSocketService();
    this.riskManager = getRiskManager();
    this.symbols = moduleConfig?.symbols ?? this.config.trading.defaultSymbols;

    // Setup scheduler with default handlers
    this.scheduler = createDefaultTradingScheduler(
      () => this.runAnalysisAndTrade(),
      () => this.runAnalysisAndTrade(),
      () => this.runPositionManagement()
    );

    // Setup WebSocket event handlers
    if (moduleConfig?.onAccountUpdate) {
      this.webSocket.on("accountUpdate", moduleConfig.onAccountUpdate);
    }
    if (moduleConfig?.onOrderUpdate) {
      this.webSocket.on("orderUpdate", moduleConfig.onOrderUpdate);
    }
    if (moduleConfig?.onPriceUpdate) {
      this.webSocket.on("priceUpdate", moduleConfig.onPriceUpdate);
    }

    // Auto-start if configured
    if (moduleConfig?.autoStart) {
      this.start().catch(console.error);
    }
  }

  // ============ Lifecycle Methods ============

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("[TradingModule] Already running");
      return;
    }

    console.log("[TradingModule] Starting...");

    // Start WebSocket connections (graceful - won't throw on failure)
    try {
      await this.webSocket.startUserDataStream();
      this.webSocket.subscribeToPriceUpdates(this.symbols);
    } catch (error) {
      console.error(
        "[TradingModule] WebSocket initialization failed:",
        error instanceof Error ? error.message : error
      );
      console.warn("[TradingModule] Continuing without WebSocket streams");
    }

    // Start scheduler if enabled
    if (this.config.scheduler.enabled) {
      this.scheduler.startAll();
    }

    this.isRunning = true;
    console.log("[TradingModule] Started successfully");
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log("[TradingModule] Not running");
      return;
    }

    console.log("[TradingModule] Stopping...");

    // Stop scheduler
    this.scheduler.stopAll();

    // Close WebSocket connections
    await this.webSocket.close();

    this.isRunning = false;
    console.log("[TradingModule] Stopped");
  }

  // ============ Trading Operations ============

  async executeTrade(
    symbol: string,
    riskAmountUsd: number,
    overrides?: {
      analysis?: AnalysisResponse;
      marketState?: MarketStateResponse | null;
    }
  ): Promise<TradeExecutionResult> {
    console.log(`[TradingModule] Executing trade for ${symbol}`);

    const workflow = mastra.getWorkflow("tradeExecutionWorkflow");
    const run = await workflow.createRun();

    const result = await run.start({
      inputData: {
        symbol,
        riskAmountUsd,
        analysisOverride: overrides?.analysis,
        marketStateOverride: overrides?.marketState ?? undefined,
      },
    });

    if (result.status === "success") {
      return result.result as TradeExecutionResult;
    }

    return {
      success: false,
      reasoning: `Workflow failed: ${result.status}`,
    };
  }

  async runAnalysisAndTrade(): Promise<void> {
    console.log("[TradingModule] Running analysis and trade cycle");

    const workflow = mastra.getWorkflow("analysisWorkflow");
    const run = await workflow.createRun();

    const result = await run.start({
      inputData: { symbols: this.symbols },
    });

    if (result.status !== "success") {
      console.error("[TradingModule] Analysis workflow failed");
      return;
    }

    const analysisResult = result.result as {
      marketState: MarketStateResponse | null;
      decisions: Array<{
        symbol: string;
        action: string;
        confidence: number;
        analysis?: AnalysisResponse | null;
        entryPrice?: number;
        stopLoss?: number;
        takeProfit?: number;
      }>;
      marketSummary: {
        tradingAllowed: boolean;
        riskMultiplier: number;
      };
    };

    // Execute trades based on decisions
    for (const decision of analysisResult.decisions) {
      if (
        (decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT") &&
        decision.entryPrice &&
        decision.stopLoss &&
        decision.takeProfit
      ) {
        const riskAmount =
          this.config.risk.defaultRiskPerTradeUsd *
          analysisResult.marketSummary.riskMultiplier;

        await this.executeTrade(decision.symbol, riskAmount, {
          analysis: decision.analysis ?? undefined,
          marketState: analysisResult.marketState ?? null,
        });
      }
    }
  }

  async runPositionManagement(): Promise<void> {
    console.log("[TradingModule] Running position management");

    const workflow = mastra.getWorkflow("positionManagementWorkflow");
    const run = await workflow.createRun();

    await run.start({
      inputData: { checkMarketState: true },
    });
  }

  // ============ Position Operations ============

  async getPositions(): Promise<Position[]> {
    const positions = await this.binance.getPositions();
    if (positions.length === 0) return positions;

    // SL/TP are represented as open orders (STOP_MARKET / TAKE_PROFIT_MARKET, etc.)
    // Fetch once and enrich locally to avoid N calls per symbol.
    let openOrders: Order[] = [];
    try {
      openOrders = await this.binance.getOpenOrders();
    } catch {
      return positions;
    }

    const ordersBySymbol = new Map<string, Order[]>();
    for (const order of openOrders) {
      const list = ordersBySymbol.get(order.symbol);
      if (list) {
        list.push(order);
      } else {
        ordersBySymbol.set(order.symbol, [order]);
      }
    }

    const takeProfitTypes = new Set<Order["type"]>([
      "TAKE_PROFIT",
      "TAKE_PROFIT_MARKET",
    ]);
    const stopLossTypes = new Set<Order["type"]>([
      "STOP",
      "STOP_MARKET",
      "TRAILING_STOP_MARKET",
    ]);

    const extractOrderPrice = (o: Order): number | undefined => {
      if (typeof o.stopPrice === "number" && Number.isFinite(o.stopPrice)) {
        return o.stopPrice;
      }
      if (Number.isFinite(o.price) && o.price > 0) return o.price;
      return undefined;
    };

    const pickExtreme = (
      values: number[],
      side: "min" | "max"
    ): number | undefined => {
      if (values.length === 0) return undefined;
      return side === "min" ? Math.min(...values) : Math.max(...values);
    };

    return positions.map((p) => {
      const symbolOrders = ordersBySymbol.get(p.symbol) ?? [];
      const closeSide = p.positionAmt > 0 ? "SELL" : "BUY";
      const direction = p.positionAmt > 0 ? "LONG" : "SHORT";

      const tpPrices: number[] = [];
      const slPrices: number[] = [];

      for (const o of symbolOrders) {
        if (o.side !== closeSide) continue;
        const price = extractOrderPrice(o);
        if (price === undefined) continue;
        if (takeProfitTypes.has(o.type)) tpPrices.push(price);
        if (stopLossTypes.has(o.type)) slPrices.push(price);
      }

      const takeProfit =
        direction === "LONG"
          ? pickExtreme(tpPrices, "max")
          : pickExtreme(tpPrices, "min");
      const stopLoss =
        direction === "LONG"
          ? pickExtreme(slPrices, "min")
          : pickExtreme(slPrices, "max");

      return {
        ...p,
        stopLoss,
        takeProfit,
      };
    });
  }

  async closePosition(symbol: string): Promise<boolean> {
    const result = await this.binance.closePosition(symbol);
    return result !== null;
  }

  async closeAllPositions(): Promise<number> {
    const results = await this.binance.closeAllPositions();
    return results.length;
  }

  // ============ Account Operations ============

  async getBalance(): Promise<number> {
    const balance = await this.binance.getUsdtBalance();
    return balance?.availableBalance ?? 0;
  }

  async getAccountSummary(): Promise<{
    balance: number;
    positions: Position[];
    totalUnrealizedPnl: number;
    dailyStats: ReturnType<RiskManager["getDailyStats"]>;
  }> {
    const balance = await this.getBalance();
    const positions = await this.getPositions();
    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedProfit,
      0
    );
    const dailyStats = this.riskManager.getDailyStats();

    return {
      balance,
      positions,
      totalUnrealizedPnl,
      dailyStats,
    };
  }

  // ============ Agent Interactions ============

  async askTradingAgent(message: string): Promise<string> {
    const response = await tradingAgent.generate(message);
    return response.text;
  }

  async askRiskAgent(message: string): Promise<string> {
    const response = await riskAgent.generate(message);
    return response.text;
  }

  // ============ Scheduler Operations ============

  async runTaskNow(taskId: string): Promise<void> {
    // Backwards/compat aliases for admin panel / older API clients
    // Historically some clients used "analysisTask" as a generic analysis trigger.
    if (taskId === "analysisTask") {
      await this.runAnalysisAndTrade();
      return;
    }
    await this.scheduler.runTaskNow(taskId);
  }

  getSchedulerStatus(): ReturnType<TradingScheduler["getTaskStatus"]> {
    return this.scheduler.getTaskStatus();
  }

  // ============ Status ============

  getStatus(): {
    isRunning: boolean;
    webSocketConnected: boolean;
    schedulerRunning: boolean;
    symbols: string[];
  } {
    return {
      isRunning: this.isRunning,
      webSocketConnected: this.webSocket.getStatus().isConnected,
      schedulerRunning: this.scheduler.isRunning(),
      symbols: this.symbols,
    };
  }
}

// Export singleton factory
let tradingModuleInstance: TradingModule | null = null;

export function getTradingModule(config?: TradingModuleConfig): TradingModule {
  if (!tradingModuleInstance) {
    tradingModuleInstance = new TradingModule(config);
  }
  return tradingModuleInstance;
}

// Re-export types and services
export { tradingAgent, riskAgent };
export { tradeExecutionWorkflow, positionManagementWorkflow, analysisWorkflow };
export { getBinanceService } from "./services/binance/client";
export { getRiskManager } from "./services/risk/risk-manager";
export { getTradingScheduler } from "./services/scheduler/trading-scheduler";
export * from "./types/trading";
