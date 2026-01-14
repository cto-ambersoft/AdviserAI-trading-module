import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { getTradingConfig } from "../../config/trading";
import { getBinanceService } from "../../services/binance/client";
import { getRiskManager } from "../../services/risk/risk-manager";
import { getAiDecisionLogStore } from "../../services/ai-decision-log-store";
import { calculatePosition } from "../tools/position-calculator-tool";
import {
  AnalysisResponseSchema,
  MarketStateResponseSchema,
  type AnalysisResponse,
  type MarketStateResponse,
} from "../../types/trading";

// ============ Step 1: Fetch Analysis ============

const fetchAnalysisStep = createStep({
  id: "fetch-analysis",
  description: "Fetches trading analysis from Core Analytics API",
  inputSchema: z.object({
    symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
    riskAmountUsd: z.number().positive().describe("Risk amount in USD"),
    analysisOverride: AnalysisResponseSchema.optional(),
    marketStateOverride: MarketStateResponseSchema.optional(),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    riskAmountUsd: z.number(),
    analysis: AnalysisResponseSchema.nullable(),
    marketState: MarketStateResponseSchema.nullable(),
    error: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const config = getTradingConfig();

    try {
      // If caller provided a decision-time snapshot, use it to avoid race conditions
      if (inputData.analysisOverride) {
        return {
          symbol: inputData.symbol,
          riskAmountUsd: inputData.riskAmountUsd,
          analysis: inputData.analysisOverride,
          marketState: inputData.marketStateOverride ?? null,
        };
      }

      // Fetch analysis
      const analysisResponse = await fetch(
        `${config.core.apiUrl}/api/analysis/${inputData.symbol}`,
        {
          headers: { "X-API-Key": config.core.apiKey },
        }
      );

      // Fetch market state
      const marketStateResponse = await fetch(
        `${config.core.apiUrl}/api/analysis/market-state`,
        {
          headers: { "X-API-Key": config.core.apiKey },
        }
      );

      let analysis: AnalysisResponse | null = null;
      let marketState: MarketStateResponse | null = null;

      if (analysisResponse.ok) {
        const data = await analysisResponse.json();
        analysis = AnalysisResponseSchema.parse(data);
      }

      if (marketStateResponse.ok) {
        const data = await marketStateResponse.json();
        marketState = MarketStateResponseSchema.parse(data);
      }

      return {
        symbol: inputData.symbol,
        riskAmountUsd: inputData.riskAmountUsd,
        analysis,
        marketState,
      };
    } catch (error) {
      return {
        symbol: inputData.symbol,
        riskAmountUsd: inputData.riskAmountUsd,
        analysis: null,
        marketState: null,
        error:
          error instanceof Error ? error.message : "Failed to fetch analysis",
      };
    }
  },
});

// ============ Step 2: Validate Conditions ============

const validateConditionsStep = createStep({
  id: "validate-conditions",
  description: "Validates trading conditions based on analysis and risk rules",
  inputSchema: z.object({
    symbol: z.string(),
    riskAmountUsd: z.number(),
    analysis: AnalysisResponseSchema.nullable(),
    marketState: MarketStateResponseSchema.nullable(),
    error: z.string().optional(),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    riskAmountUsd: z.number(),
    shouldTrade: z.boolean(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryPrice: z.number().nullable(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    riskReward: z.number().nullable(),
    adjustedRiskAmount: z.number(),
    reasoning: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { symbol, riskAmountUsd, analysis, marketState, error } = inputData;
    const config = getTradingConfig();
    const logStore = getAiDecisionLogStore();

    // Check for errors
    if (error || !analysis) {
      const reasoning = error ?? "No analysis available";
      await logStore
        .append({
          symbol,
          source: "tradeExecutionWorkflow",
          eventType: "TRADE_REJECTED",
          action: "SKIP",
          confidence: 0,
          reasoning,
          meta: { stage: "validateConditions", reason: "missing_analysis" },
        })
        .catch(() => {});
      return {
        symbol,
        riskAmountUsd,
        shouldTrade: false,
        direction: null,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        riskReward: null,
        adjustedRiskAmount: riskAmountUsd,
        reasoning: error ?? "No analysis available",
      };
    }

    // Hard-reject on extremely low confidence, but don't discard moderate Core signals
    if (analysis.confidence < config.trading.hardRejectConfidence) {
      const reasoning = `Analysis confidence (${(analysis.confidence * 100).toFixed(0)}%) below hard floor ${(config.trading.hardRejectConfidence * 100).toFixed(0)}%`;
      await logStore
        .append({
          symbol,
          source: "tradeExecutionWorkflow",
          eventType: "TRADE_REJECTED",
          action: "SKIP",
          confidence: analysis.confidence,
          summary: analysis.summary,
          reasoning,
          meta: {
            stage: "validateConditions",
            reason: "confidence_below_hard_floor",
            recommendations: analysis.recommendations,
            hardRejectConfidence: config.trading.hardRejectConfidence,
          },
        })
        .catch(() => {});
      return {
        symbol,
        riskAmountUsd,
        shouldTrade: false,
        direction: null,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        riskReward: null,
        adjustedRiskAmount: riskAmountUsd,
        reasoning,
      };
    }

    // Check market state
    let riskMultiplier = 1.0;
    if (marketState) {
      if (marketState.recommendation.positionSizing === "NONE") {
        const reasoning = `Market conditions do not favor trading: ${marketState.recommendation.reasoning}`;
        await logStore
          .append({
            symbol,
            source: "tradeExecutionWorkflow",
            eventType: "TRADE_REJECTED",
            action: "SKIP",
            confidence: analysis.confidence,
            summary: analysis.summary,
            reasoning,
            meta: {
              stage: "validateConditions",
              reason: "market_position_sizing_none",
              marketCondition: marketState.marketCondition,
              marketRecommendation: marketState.recommendation,
            },
          })
          .catch(() => {});
        return {
          symbol,
          riskAmountUsd,
          shouldTrade: false,
          direction: null,
          entryPrice: null,
          stopLoss: null,
          takeProfit: null,
          riskReward: null,
          adjustedRiskAmount: riskAmountUsd,
          reasoning: `Market conditions do not favor trading: ${marketState.recommendation.reasoning}`,
        };
      }

      switch (marketState.recommendation.positionSizing) {
        case "REDUCED":
          riskMultiplier = 0.5;
          break;
        case "MINIMAL":
          riskMultiplier = 0.25;
          break;
      }

      if (marketState.marketCondition === "HIGH_VOLATILITY") {
        riskMultiplier *= 0.5;
      }
    }

    // Determine direction and entry params
    const { recommendations } = analysis;
    let direction: "LONG" | "SHORT" | null = null;
    let entryDetails = null;

    if (recommendations.action === "OPEN_LONG" && recommendations.longEntry) {
      direction = "LONG";
      entryDetails = recommendations.longEntry;
    } else if (
      recommendations.action === "OPEN_SHORT" &&
      recommendations.shortEntry
    ) {
      direction = "SHORT";
      entryDetails = recommendations.shortEntry;
    }

    if (!direction || !entryDetails) {
      const reasoning = `No actionable trade signal: ${recommendations.action}`;
      await logStore
        .append({
          symbol,
          source: "tradeExecutionWorkflow",
          eventType: "TRADE_REJECTED",
          action: recommendations.action,
          confidence: analysis.confidence,
          summary: analysis.summary,
          reasoning,
          meta: {
            stage: "validateConditions",
            reason: "no_actionable_signal",
            recommendations,
          },
        })
        .catch(() => {});
      return {
        symbol,
        riskAmountUsd,
        shouldTrade: false,
        direction: null,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        riskReward: null,
        adjustedRiskAmount: riskAmountUsd,
        reasoning: `No actionable trade signal: ${recommendations.action}`,
      };
    }

    // Validate Risk:Reward
    if (entryDetails.riskReward < config.risk.minRiskReward) {
      const reasoning = `Risk:Reward (${entryDetails.riskReward.toFixed(2)}) below minimum ${config.risk.minRiskReward}:1`;
      await logStore
        .append({
          symbol,
          source: "tradeExecutionWorkflow",
          eventType: "TRADE_REJECTED",
          action: recommendations.action,
          confidence: analysis.confidence,
          entryPrice: entryDetails.price,
          stopLoss: entryDetails.stopLoss,
          takeProfit: entryDetails.takeProfit,
          riskReward: entryDetails.riskReward,
          summary: analysis.summary,
          reasoning,
          meta: {
            stage: "validateConditions",
            reason: "risk_reward_too_low",
            recommendations,
            minRiskReward: config.risk.minRiskReward,
          },
        })
        .catch(() => {});
      return {
        symbol,
        riskAmountUsd,
        shouldTrade: false,
        direction: null,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        riskReward: null,
        adjustedRiskAmount: riskAmountUsd,
        reasoning,
      };
    }

    // Soft confidence scaling: if confidence is below target, reduce risk amount proportionally
    const confidenceTarget = config.trading.minConfidenceToTrade;
    const confidenceFloor = config.trading.hardRejectConfidence;
    let confidenceMultiplier = 1.0;

    if (analysis.confidence < confidenceTarget) {
      const denom = confidenceTarget - confidenceFloor;
      const numer = analysis.confidence - confidenceFloor;
      confidenceMultiplier =
        denom > 0 ? Math.max(0.0, Math.min(1.0, numer / denom)) : 0.0;
    }

    const adjustedRiskAmount =
      riskAmountUsd * riskMultiplier * confidenceMultiplier;

    return {
      symbol,
      riskAmountUsd,
      shouldTrade: true,
      direction,
      entryPrice: entryDetails.price,
      stopLoss: entryDetails.stopLoss,
      takeProfit: entryDetails.takeProfit,
      riskReward: entryDetails.riskReward,
      adjustedRiskAmount,
      reasoning: `${direction} signal with ${(analysis.confidence * 100).toFixed(0)}% confidence, R:R ${entryDetails.riskReward.toFixed(2)} (risk x${riskMultiplier.toFixed(2)} from market, x${confidenceMultiplier.toFixed(2)} from confidence)`,
    };
  },
});

// ============ Step 3: Calculate Position Size ============

const calculatePositionStep = createStep({
  id: "calculate-position",
  description: "Calculates position size based on risk parameters",
  inputSchema: z.object({
    symbol: z.string(),
    riskAmountUsd: z.number(),
    shouldTrade: z.boolean(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryPrice: z.number().nullable(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    riskReward: z.number().nullable(),
    adjustedRiskAmount: z.number(),
    reasoning: z.string(),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    shouldTrade: z.boolean(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryPrice: z.number().nullable(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    quantity: z.number().nullable(),
    notionalValue: z.number().nullable(),
    reasoning: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (
      !inputData.shouldTrade ||
      !inputData.direction ||
      !inputData.entryPrice ||
      !inputData.stopLoss ||
      !inputData.takeProfit ||
      !inputData.riskReward
    ) {
      return {
        symbol: inputData.symbol,
        shouldTrade: false,
        direction: null,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        quantity: null,
        notionalValue: null,
        reasoning: inputData.reasoning,
      };
    }

    const config = getTradingConfig();

    try {
      const positionCalc = calculatePosition({
        riskUsd: inputData.adjustedRiskAmount,
        entryPrice: inputData.entryPrice,
        stopLoss: inputData.stopLoss,
        feePercent: config.trading.defaultFeePercent,
        rrRatio: inputData.riskReward,
      });

      return {
        symbol: inputData.symbol,
        shouldTrade: true,
        direction: inputData.direction,
        entryPrice: inputData.entryPrice,
        stopLoss: inputData.stopLoss,
        takeProfit: inputData.takeProfit,
        quantity: positionCalc.position.sizeCoins,
        notionalValue: positionCalc.position.sizeUsdt,
        reasoning: `${inputData.reasoning}. Position size: ${positionCalc.position.sizeCoins.toFixed(6)} (${positionCalc.position.sizeUsdt.toFixed(2)} USDT)`,
      };
    } catch (error) {
      return {
        symbol: inputData.symbol,
        shouldTrade: false,
        direction: null,
        entryPrice: null,
        stopLoss: null,
        takeProfit: null,
        quantity: null,
        notionalValue: null,
        reasoning: `Position calculation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// ============ Step 4: Check Risk Rules ============

const checkRiskRulesStep = createStep({
  id: "check-risk-rules",
  description: "Validates trade against risk management rules",
  inputSchema: z.object({
    symbol: z.string(),
    shouldTrade: z.boolean(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryPrice: z.number().nullable(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    quantity: z.number().nullable(),
    notionalValue: z.number().nullable(),
    reasoning: z.string(),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    shouldTrade: z.boolean(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryPrice: z.number().nullable(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    quantity: z.number().nullable(),
    reasoning: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.shouldTrade || !inputData.direction) {
      return {
        ...inputData,
        quantity: null,
      };
    }

    const binance = getBinanceService();
    const riskManager = getRiskManager();

    try {
      // Check max positions
      const positions = await binance.getPositions();
      const config = getTradingConfig();

      if (positions.length >= config.risk.maxOpenPositions) {
        const existingSymbolPosition = positions.find(
          (p) => p.symbol === inputData.symbol
        );
        if (!existingSymbolPosition) {
          return {
            ...inputData,
            shouldTrade: false,
            quantity: null,
            reasoning: `Max positions (${config.risk.maxOpenPositions}) reached`,
          };
        }
      }

      // Check for conflicting position
      const existingPosition = positions.find(
        (p) => p.symbol === inputData.symbol
      );
      if (existingPosition) {
        const existingDir = existingPosition.positionAmt > 0 ? "LONG" : "SHORT";
        if (existingDir !== inputData.direction) {
          return {
            ...inputData,
            shouldTrade: false,
            quantity: null,
            reasoning: `Conflicting ${existingDir} position exists for ${inputData.symbol}`,
          };
        }
      }

      // Check daily loss limit
      if (riskManager.isDailyLossLimitReached()) {
        return {
          ...inputData,
          shouldTrade: false,
          quantity: null,
          reasoning: "Daily loss limit reached",
        };
      }

      return inputData;
    } catch (error) {
      return {
        ...inputData,
        shouldTrade: false,
        quantity: null,
        reasoning: `Risk check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// ============ Step 5: Execute Trade ============

const executeTradeStep = createStep({
  id: "execute-trade",
  description: "Executes the trade on Binance Futures",
  inputSchema: z.object({
    symbol: z.string(),
    shouldTrade: z.boolean(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryPrice: z.number().nullable(),
    stopLoss: z.number().nullable(),
    takeProfit: z.number().nullable(),
    quantity: z.number().nullable(),
    reasoning: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    symbol: z.string(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryOrderId: z.number().nullable(),
    takeProfitOrderId: z.number().nullable(),
    stopLossOrderId: z.number().nullable(),
    executedQuantity: z.number().nullable(),
    executedPrice: z.number().nullable(),
    reasoning: z.string(),
    // New fields for partial success tracking
    tpError: z.string().optional(),
    slError: z.string().optional(),
    partialSuccess: z.boolean().optional(),
  }),
  execute: async ({ inputData }) => {
    if (
      !inputData.shouldTrade ||
      !inputData.direction ||
      !inputData.quantity ||
      !inputData.stopLoss ||
      !inputData.takeProfit
    ) {
      await getAiDecisionLogStore()
        .append({
          symbol: inputData.symbol,
          source: "tradeExecutionWorkflow",
          eventType: "TRADE_REJECTED",
          action: inputData.direction
            ? inputData.direction === "LONG"
              ? "OPEN_LONG"
              : "OPEN_SHORT"
            : "SKIP",
          entryPrice: inputData.entryPrice,
          stopLoss: inputData.stopLoss,
          takeProfit: inputData.takeProfit,
          reasoning: inputData.reasoning,
          meta: { stage: "executeTrade", reason: "missing_trade_params" },
        })
        .catch(() => {});
      return {
        success: false,
        symbol: inputData.symbol,
        direction: null,
        entryOrderId: null,
        takeProfitOrderId: null,
        stopLossOrderId: null,
        executedQuantity: null,
        executedPrice: null,
        reasoning: inputData.reasoning,
      };
    }

    const binance = getBinanceService();
    const config = getTradingConfig();

    try {
      // Set leverage
      await binance.setLeverage(
        inputData.symbol,
        config.risk.maxLeveragePerPosition
      );

      // Submit bracket order - now handles partial failures
      const side = inputData.direction === "LONG" ? "BUY" : "SELL";
      const result = await binance.submitBracketOrder({
        symbol: inputData.symbol,
        side,
        quantity: inputData.quantity,
        takeProfitPrice: inputData.takeProfit,
        stopLossPrice: inputData.stopLoss,
        entryType: "MARKET",
      });

      // Build reasoning message with details about all orders
      const tpStatus = result.tp
        ? `TP: ${result.tp.orderId}`
        : `TP FAILED: ${result.tpError}`;
      const slStatus = result.sl
        ? `SL: ${result.sl.orderId}`
        : `SL FAILED: ${result.slError}`;
      const reasoning = `${inputData.direction} order executed. Entry: ${result.entry.orderId}, ${tpStatus}, ${slStatus}`;

      // Determine event type based on partial success
      const eventType = result.partialSuccess
        ? "TRADE_PARTIAL_SUCCESS"
        : "TRADE_EXECUTED";

      // Log warnings for failed TP/SL orders
      if (result.tpError) {
        console.warn(
          `[TradeExecution] Take Profit order failed for ${inputData.symbol}:`,
          result.tpError
        );
      }
      if (result.slError) {
        console.warn(
          `[TradeExecution] Stop Loss order failed for ${inputData.symbol}:`,
          result.slError
        );
      }

      await getAiDecisionLogStore()
        .append({
          symbol: inputData.symbol,
          source: "tradeExecutionWorkflow",
          eventType,
          action: inputData.direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          entryPrice: inputData.entryPrice,
          stopLoss: inputData.stopLoss,
          takeProfit: inputData.takeProfit,
          reasoning,
          meta: {
            entryOrderId: result.entry.orderId,
            takeProfitOrderId: result.tp?.orderId ?? null,
            stopLossOrderId: result.sl?.orderId ?? null,
            executedQuantity: result.entry.executedQty,
            executedPrice: result.entry.avgPrice,
            partialSuccess: result.partialSuccess,
            tpError: result.tpError,
            slError: result.slError,
          },
        })
        .catch(() => {});

      // Return success even on partial success - position was opened
      // The caller should check partialSuccess and tpError/slError for details
      return {
        success: true,
        symbol: inputData.symbol,
        direction: inputData.direction,
        entryOrderId: result.entry.orderId,
        takeProfitOrderId: result.tp?.orderId ?? null,
        stopLossOrderId: result.sl?.orderId ?? null,
        executedQuantity: result.entry.executedQty,
        executedPrice: result.entry.avgPrice,
        reasoning,
        tpError: result.tpError,
        slError: result.slError,
        partialSuccess: result.partialSuccess,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[TradeExecution] Trade execution failed for ${inputData.symbol}:`,
        errorMessage
      );

      await getAiDecisionLogStore()
        .append({
          symbol: inputData.symbol,
          source: "tradeExecutionWorkflow",
          eventType: "TRADE_REJECTED",
          action: inputData.direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
          entryPrice: inputData.entryPrice,
          stopLoss: inputData.stopLoss,
          takeProfit: inputData.takeProfit,
          reasoning: `Trade execution failed: ${errorMessage}`,
          meta: {
            stage: "executeTrade",
            reason: "execution_error",
            errorDetails: errorMessage,
          },
        })
        .catch(() => {});

      return {
        success: false,
        symbol: inputData.symbol,
        direction: inputData.direction,
        entryOrderId: null,
        takeProfitOrderId: null,
        stopLossOrderId: null,
        executedQuantity: null,
        executedPrice: null,
        reasoning: `Trade execution failed: ${errorMessage}`,
      };
    }
  },
});

// ============ Create Workflow ============

export const tradeExecutionWorkflow = createWorkflow({
  id: "trade-execution-workflow",
  inputSchema: z.object({
    symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
    riskAmountUsd: z.number().positive().describe("Risk amount in USD"),
    analysisOverride: AnalysisResponseSchema.optional(),
    marketStateOverride: MarketStateResponseSchema.optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    symbol: z.string(),
    direction: z.enum(["LONG", "SHORT"]).nullable(),
    entryOrderId: z.number().nullable(),
    takeProfitOrderId: z.number().nullable(),
    stopLossOrderId: z.number().nullable(),
    executedQuantity: z.number().nullable(),
    executedPrice: z.number().nullable(),
    reasoning: z.string(),
    // Partial success tracking - entry succeeded but TP/SL may have failed
    tpError: z.string().optional(),
    slError: z.string().optional(),
    partialSuccess: z.boolean().optional(),
  }),
})
  .then(fetchAnalysisStep)
  .then(validateConditionsStep)
  .then(calculatePositionStep)
  .then(checkRiskRulesStep)
  .then(executeTradeStep);

tradeExecutionWorkflow.commit();
