import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"
import { getTradingConfig } from "../../config/trading"
import { getBinanceService } from "../../services/binance/client"
import { getAiDecisionLogStore } from "../../services/ai-decision-log-store"
import {
  AnalysisResponseSchema,
  MarketStateResponseSchema,
  PositionSchema,
  type AnalysisResponse,
  type MarketStateResponse,
} from "../../types/trading"

// ============ Step 1: Fetch All Data ============

const fetchAllDataStep = createStep({
  id: "fetch-all-data",
  description: "Fetches market state, symbol analysis, and current positions",
  inputSchema: z.object({
    symbols: z.array(z.string()).describe("Symbols to analyze"),
  }),
  outputSchema: z.object({
    marketState: MarketStateResponseSchema.nullable(),
    analyses: z.array(
      z.object({
        symbol: z.string(),
        analysis: AnalysisResponseSchema.nullable(),
        error: z.string().optional(),
      })
    ),
    positions: z.array(PositionSchema),
    accountBalance: z.number(),
  }),
  execute: async ({ inputData }) => {
    const config = getTradingConfig()
    const binance = getBinanceService()
    const logStore = getAiDecisionLogStore()

    // Fetch market state
    let marketState: MarketStateResponse | null = null
    try {
      const response = await fetch(
        `${config.core.apiUrl}/api/analysis/market-state`,
        { headers: { "X-API-Key": config.core.apiKey } }
      )
      if (response.ok) {
        const data = await response.json()
        marketState = MarketStateResponseSchema.parse(data)
      }
    } catch {
      // Market state fetch failed
    }

    // Fetch analyses for all symbols
    const analyses = await Promise.all(
      inputData.symbols.map(async (symbol) => {
        try {
          const response = await fetch(
            `${config.core.apiUrl}/api/analysis/${symbol}`,
            { headers: { "X-API-Key": config.core.apiKey } }
          )
          if (response.ok) {
            const data = await response.json()
            const analysis = AnalysisResponseSchema.parse(data)

            await logStore
              .append({
                symbol,
                source: "analysisWorkflow",
                eventType: "ANALYSIS_SUMMARY",
                action: analysis.recommendations.action,
                confidence: analysis.confidence,
                summary: analysis.summary,
                reasoning: analysis.recommendations.reasoning,
                meta: {
                  timestamp: analysis.timestamp,
                  currentPrice: analysis.currentPrice,
                  bias: analysis.bias,
                  keyLevels: analysis.keyLevels,
                  dataQuality: analysis.dataQuality,
                },
              })
              .catch(() => {})

            return {
              symbol,
              analysis,
            }
          }
          return { symbol, analysis: null, error: "Analysis not available" }
        } catch (error) {
          return {
            symbol,
            analysis: null,
            error: error instanceof Error ? error.message : "Fetch failed",
          }
        }
      })
    )

    // Fetch positions and balance (Binance errors must not kill the whole workflow)
    let positions: Array<(typeof PositionSchema)["_output"]> = []
    try {
      positions = await binance.getPositions()
    } catch {
      positions = []
    }

    let balance: Awaited<ReturnType<typeof binance.getUsdtBalance>> = null
    try {
      balance = await binance.getUsdtBalance()
    } catch {
      balance = null
    }

    return {
      marketState,
      analyses,
      positions,
      accountBalance: balance?.availableBalance ?? 0,
    }
  },
})

// ============ Step 2: Generate Trading Decisions ============

const generateTradingDecisionsStep = createStep({
  id: "generate-trading-decisions",
  description: "Generates trading decisions based on analysis",
  inputSchema: z.object({
    marketState: MarketStateResponseSchema.nullable(),
    analyses: z.array(
      z.object({
        symbol: z.string(),
        analysis: AnalysisResponseSchema.nullable(),
        error: z.string().optional(),
      })
    ),
    positions: z.array(PositionSchema),
    accountBalance: z.number(),
  }),
  outputSchema: z.object({
    marketState: MarketStateResponseSchema.nullable(),
    decisions: z.array(
      z.object({
        symbol: z.string(),
        analysis: AnalysisResponseSchema.nullable(),
        action: z.enum([
          "OPEN_LONG",
          "OPEN_SHORT",
          "CLOSE_LONG",
          "CLOSE_SHORT",
          "HOLD",
          "SKIP",
        ]),
        reasoning: z.string(),
        confidence: z.number(),
        entryPrice: z.number().optional(),
        stopLoss: z.number().optional(),
        takeProfit: z.number().optional(),
        riskReward: z.number().optional(),
      })
    ),
    marketSummary: z.object({
      condition: z.string(),
      sentiment: z.string(),
      tradingAllowed: z.boolean(),
      riskMultiplier: z.number(),
    }),
  }),
  execute: async ({ inputData }) => {
    const { marketState, analyses, positions, accountBalance } = inputData
    const config = getTradingConfig()
    const logStore = getAiDecisionLogStore()

    // Determine market trading conditions
    let tradingAllowed = true
    let riskMultiplier = 1.0

    if (marketState) {
      if (marketState.recommendation.positionSizing === "NONE") {
        tradingAllowed = false
      } else {
        switch (marketState.recommendation.positionSizing) {
          case "REDUCED":
            riskMultiplier = 0.5
            break
          case "MINIMAL":
            riskMultiplier = 0.25
            break
        }
      }

      if (marketState.marketCondition === "HIGH_VOLATILITY") {
        riskMultiplier *= 0.5
      }
    }

    const decisions: Array<{
      symbol: string
      analysis: AnalysisResponse | null
      action:
        | "OPEN_LONG"
        | "OPEN_SHORT"
        | "CLOSE_LONG"
        | "CLOSE_SHORT"
        | "HOLD"
        | "SKIP"
      reasoning: string
      confidence: number
      entryPrice?: number
      stopLoss?: number
      takeProfit?: number
      riskReward?: number
    }> = []

    // Check positions against max limit
    const openPositionsCount = positions.length
    const canOpenNew = openPositionsCount < config.risk.maxOpenPositions

    for (const { symbol, analysis, error } of analyses) {
      // Check if we have an existing position
      const existingPosition = positions.find((p) => p.symbol === symbol)
      const existingDirection = existingPosition
        ? existingPosition.positionAmt > 0
          ? "LONG"
          : "SHORT"
        : null

      // Handle errors
      if (error || !analysis) {
        decisions.push({
          symbol,
          analysis: null,
          action: existingPosition ? "HOLD" : "SKIP",
          reasoning: error ?? "No analysis available",
          confidence: 0,
        })
        continue
      }

      // Hard reject on extremely low confidence, but do NOT discard moderate signals
      if (analysis.confidence < config.trading.hardRejectConfidence) {
        decisions.push({
          symbol,
          analysis,
          action: existingPosition ? "HOLD" : "SKIP",
          reasoning: `Confidence ${(analysis.confidence * 100).toFixed(0)}% below hard floor ${(config.trading.hardRejectConfidence * 100).toFixed(0)}%`,
          confidence: analysis.confidence,
        })
        continue
      }

      // Skip if trading not allowed
      if (!tradingAllowed) {
        decisions.push({
          symbol,
          analysis,
          action: existingPosition ? "HOLD" : "SKIP",
          reasoning: "Market conditions do not favor trading",
          confidence: 0,
        })
        continue
      }

      const { recommendations, bias } = analysis

      // Determine action
      if (existingPosition) {
        // Check if we should close existing position
        const shouldClose =
          (existingDirection === "LONG" &&
            (recommendations.action === "CLOSE_LONG" ||
              recommendations.action === "OPEN_SHORT")) ||
          (existingDirection === "SHORT" &&
            (recommendations.action === "CLOSE_SHORT" ||
              recommendations.action === "OPEN_LONG"))

        if (shouldClose) {
          decisions.push({
            symbol,
            analysis,
            action:
              existingDirection === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT",
            reasoning: `Signal changed: ${recommendations.reasoning}`,
            confidence: analysis.confidence,
          })
        } else {
          decisions.push({
            symbol,
            analysis,
            action: "HOLD",
            reasoning: `Maintaining ${existingDirection} position. ${recommendations.reasoning}`,
            confidence: analysis.confidence,
          })
        }
      } else {
        // No existing position - check if we should open
        if (!canOpenNew) {
          decisions.push({
            symbol,
            analysis,
            action: "SKIP",
            reasoning: `Max positions (${config.risk.maxOpenPositions}) reached`,
            confidence: analysis.confidence,
          })
          continue
        }

        const confidenceNote =
          analysis.confidence < config.trading.minConfidenceToTrade
            ? ` (confidence ${(analysis.confidence * 100).toFixed(0)}% below target ${(config.trading.minConfidenceToTrade * 100).toFixed(0)}% - execution will scale risk down)`
            : ""

        if (
          recommendations.action === "OPEN_LONG" &&
          recommendations.longEntry
        ) {
          if (recommendations.longEntry.riskReward < config.risk.minRiskReward) {
            decisions.push({
              symbol,
              analysis,
              action: "SKIP",
              reasoning: `R:R ${recommendations.longEntry.riskReward.toFixed(2)} below minimum ${config.risk.minRiskReward}`,
              confidence: analysis.confidence,
            })
          } else {
            decisions.push({
              symbol,
              analysis,
              action: "OPEN_LONG",
              reasoning: `${recommendations.reasoning}${confidenceNote}`,
              confidence: analysis.confidence,
              entryPrice: recommendations.longEntry.price,
              stopLoss: recommendations.longEntry.stopLoss,
              takeProfit: recommendations.longEntry.takeProfit,
              riskReward: recommendations.longEntry.riskReward,
            })
          }
        } else if (
          recommendations.action === "OPEN_SHORT" &&
          recommendations.shortEntry
        ) {
          if (recommendations.shortEntry.riskReward < config.risk.minRiskReward) {
            decisions.push({
              symbol,
              analysis,
              action: "SKIP",
              reasoning: `R:R ${recommendations.shortEntry.riskReward.toFixed(2)} below minimum ${config.risk.minRiskReward}`,
              confidence: analysis.confidence,
            })
          } else {
            decisions.push({
              symbol,
              analysis,
              action: "OPEN_SHORT",
              reasoning: `${recommendations.reasoning}${confidenceNote}`,
              confidence: analysis.confidence,
              entryPrice: recommendations.shortEntry.price,
              stopLoss: recommendations.shortEntry.stopLoss,
              takeProfit: recommendations.shortEntry.takeProfit,
              riskReward: recommendations.shortEntry.riskReward,
            })
          }
        } else {
          decisions.push({
            symbol,
            analysis,
            action: "SKIP",
            reasoning: `No actionable signal: ${recommendations.action}`,
            confidence: analysis.confidence,
          })
        }
      }
    }

    const logPromises = decisions
      .filter((d) => d.action !== "HOLD")
      .map((d) =>
        logStore.append({
          symbol: d.symbol,
          source: "analysisWorkflow",
          eventType: "DECISION",
          action: d.action,
          confidence: d.confidence,
          entryPrice: d.entryPrice ?? null,
          stopLoss: d.stopLoss ?? null,
          takeProfit: d.takeProfit ?? null,
          riskReward: d.riskReward ?? null,
          reasoning: d.reasoning,
          meta: {
            marketCondition: marketState?.marketCondition ?? "UNKNOWN",
            marketSentiment: marketState?.overallSentiment.label ?? "UNKNOWN",
            tradingAllowed,
            riskMultiplier,
            accountBalance,
            openPositionsCount,
            maxOpenPositions: config.risk.maxOpenPositions,
          },
        })
      )

    await Promise.all(logPromises.map((p) => p.catch(() => {})))

    return {
      marketState,
      decisions,
      marketSummary: {
        condition: marketState?.marketCondition ?? "UNKNOWN",
        sentiment: marketState?.overallSentiment.label ?? "UNKNOWN",
        tradingAllowed,
        riskMultiplier,
      },
    }
  },
})

// ============ Create Workflow ============

export const analysisWorkflow = createWorkflow({
  id: "analysis-workflow",
  inputSchema: z.object({
    symbols: z.array(z.string()).describe("Symbols to analyze"),
  }),
  outputSchema: z.object({
    marketState: MarketStateResponseSchema.nullable(),
    decisions: z.array(
      z.object({
        symbol: z.string(),
        analysis: AnalysisResponseSchema.nullable(),
        action: z.enum([
          "OPEN_LONG",
          "OPEN_SHORT",
          "CLOSE_LONG",
          "CLOSE_SHORT",
          "HOLD",
          "SKIP",
        ]),
        reasoning: z.string(),
        confidence: z.number(),
        entryPrice: z.number().optional(),
        stopLoss: z.number().optional(),
        takeProfit: z.number().optional(),
        riskReward: z.number().optional(),
      })
    ),
    marketSummary: z.object({
      condition: z.string(),
      sentiment: z.string(),
      tradingAllowed: z.boolean(),
      riskMultiplier: z.number(),
    }),
  }),
})
  .then(fetchAllDataStep)
  .then(generateTradingDecisionsStep)

analysisWorkflow.commit()
