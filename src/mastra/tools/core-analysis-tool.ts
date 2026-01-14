import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getTradingConfig } from "../../config/trading";
import {
  AnalysisResponseSchema,
  MarketStateResponseSchema,
  type AnalysisResponse,
  type MarketStateResponse,
} from "../../types/trading";

async function fetchFromCore<T>(
  endpoint: string,
  schema: z.ZodType<T>
): Promise<T> {
  const config = getTradingConfig();

  const response = await fetch(`${config.core.apiUrl}${endpoint}`, {
    headers: {
      "X-API-Key": config.core.apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Core API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  return schema.parse(data);
}

// ============ Symbol Analysis Tool ============

const getAnalysisInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTC, BTCUSDT, ETH)"),
});

const getAnalysisOutputSchema = z.object({
  symbol: z.string(),
  analysis: AnalysisResponseSchema.nullable(),
  errorMessage: z.string().nullable(),
});

export const coreAnalysisTool = createTool({
  id: "core-analysis",
  description:
    "Get structured trading analysis for a symbol from Core Analytics. Returns bias, key levels, scenarios, and trading recommendations.",
  inputSchema: getAnalysisInputSchema,
  outputSchema: getAnalysisOutputSchema,
  execute: async (inputData) => {
    const { symbol } = inputData;
    try {
      const analysis = await fetchFromCore<AnalysisResponse>(
        `/api/analysis/${symbol}`,
        AnalysisResponseSchema
      );

      return { symbol, analysis, errorMessage: null };
    } catch (err) {
      return {
        symbol,
        analysis: null,
        errorMessage:
          err instanceof Error ? err.message : "Failed to fetch analysis",
      };
    }
  },
});

// ============ Market State Tool ============

const getMarketStateOutputSchema = z.object({
  marketState: MarketStateResponseSchema.nullable(),
  errorMessage: z.string().nullable(),
});

export const coreMarketStateTool = createTool({
  id: "core-market-state",
  description:
    "Get overall market condition assessment from Core Analytics. Returns market condition, sentiment, and position sizing recommendation.",
  inputSchema: z.object({}),
  outputSchema: getMarketStateOutputSchema,
  execute: async () => {
    try {
      const marketState = await fetchFromCore<MarketStateResponse>(
        "/api/analysis/market-state",
        MarketStateResponseSchema
      );

      return { marketState, errorMessage: null };
    } catch (err) {
      return {
        marketState: null,
        errorMessage:
          err instanceof Error ? err.message : "Failed to fetch market state",
      };
    }
  },
});

// ============ Combined Analysis Tool ============

const getCombinedAnalysisInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTC, BTCUSDT, ETH)"),
});

const tradingRecommendationSchema = z.object({
  shouldTrade: z.boolean(),
  direction: z.enum(["LONG", "SHORT", "NONE"]),
  reasoning: z.string(),
  riskAdjustment: z.number().describe("Multiplier for position size (0-1)"),
});

const getCombinedAnalysisOutputSchema = z.object({
  symbol: z.string(),
  analysis: AnalysisResponseSchema.nullable(),
  marketState: MarketStateResponseSchema.nullable(),
  tradingRecommendation: tradingRecommendationSchema.nullable(),
  errorMessage: z.string().nullable(),
});

export const coreCombinedAnalysisTool = createTool({
  id: "core-combined-analysis",
  description:
    "Get both symbol analysis and market state from Core Analytics, with a combined trading recommendation that factors in market conditions.",
  inputSchema: getCombinedAnalysisInputSchema,
  outputSchema: getCombinedAnalysisOutputSchema,
  execute: async (inputData) => {
    const { symbol } = inputData;
    try {
      // Fetch both in parallel
      const [analysisResult, marketStateResult] = await Promise.allSettled([
        fetchFromCore<AnalysisResponse>(
          `/api/analysis/${symbol}`,
          AnalysisResponseSchema
        ),
        fetchFromCore<MarketStateResponse>(
          "/api/analysis/market-state",
          MarketStateResponseSchema
        ),
      ]);

      const analysis =
        analysisResult.status === "fulfilled" ? analysisResult.value : null;
      const marketState =
        marketStateResult.status === "fulfilled"
          ? marketStateResult.value
          : null;

      if (!analysis) {
        return {
          symbol,
          analysis: null,
          marketState: null,
          tradingRecommendation: null,
          errorMessage: "Failed to fetch symbol analysis",
        };
      }

      // Generate trading recommendation
      const tradingRecommendation = generateTradingRecommendation(
        analysis,
        marketState
      );

      return {
        symbol,
        analysis,
        marketState,
        tradingRecommendation,
        errorMessage: null,
      };
    } catch (err) {
      return {
        symbol,
        analysis: null,
        marketState: null,
        tradingRecommendation: null,
        errorMessage:
          err instanceof Error
            ? err.message
            : "Failed to fetch combined analysis",
      };
    }
  },
});

function generateTradingRecommendation(
  analysis: AnalysisResponse,
  marketState: MarketStateResponse | null
): {
  shouldTrade: boolean;
  direction: "LONG" | "SHORT" | "NONE";
  reasoning: string;
  riskAdjustment: number;
} {
  const { recommendations, bias, confidence } = analysis;

  // Determine base direction from analysis
  let direction: "LONG" | "SHORT" | "NONE" = "NONE";
  if (
    recommendations.action === "OPEN_LONG" &&
    (bias === "BULLISH" || bias === "NEUTRAL")
  ) {
    direction = "LONG";
  } else if (
    recommendations.action === "OPEN_SHORT" &&
    (bias === "BEARISH" || bias === "NEUTRAL")
  ) {
    direction = "SHORT";
  }

  // Calculate risk adjustment based on market state
  let riskAdjustment = 1.0;
  const reasons: string[] = [];

  if (marketState) {
    switch (marketState.recommendation.positionSizing) {
      case "FULL":
        riskAdjustment = 1.0;
        break;
      case "REDUCED":
        riskAdjustment = 0.5;
        reasons.push("Market conditions suggest reduced position size");
        break;
      case "MINIMAL":
        riskAdjustment = 0.25;
        reasons.push("Market conditions suggest minimal position size");
        break;
      case "NONE":
        riskAdjustment = 0;
        direction = "NONE";
        reasons.push("Market conditions do not favor trading");
        break;
    }

    if (marketState.marketCondition === "HIGH_VOLATILITY") {
      riskAdjustment *= 0.5;
      reasons.push("High volatility detected");
    }

    if (marketState.alerts?.some((a) => a.level === "CRITICAL")) {
      riskAdjustment *= 0.5;
      reasons.push("Critical alerts present");
    }
  }

  // Adjust based on confidence
  if (confidence < 0.45) {
    direction = "NONE";
    reasons.push("Analysis confidence too low");
  } else if (confidence < 0.5) {
    riskAdjustment *= 0.5;
    reasons.push("Low analysis confidence");
  }

  const shouldTrade = direction !== "NONE" && riskAdjustment > 0;

  return {
    shouldTrade,
    direction,
    reasoning:
      reasons.length > 0
        ? reasons.join(". ")
        : `${direction} signal with ${(confidence * 100).toFixed(0)}% confidence`,
    riskAdjustment,
  };
}
