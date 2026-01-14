import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"
import { getTradingConfig } from "../../config/trading"
import { getBinanceService } from "../../services/binance/client"
import { getRiskManager } from "../../services/risk/risk-manager"
import { getAiDecisionLogStore } from "../../services/ai-decision-log-store"
import {
  PositionSchema,
  MarketStateResponseSchema,
  type Position,
  type MarketStateResponse,
} from "../../types/trading"

// ============ Step 1: Fetch Positions ============

const fetchPositionsStep = createStep({
  id: "fetch-positions",
  description: "Fetches all open positions from Binance",
  inputSchema: z.object({
    checkMarketState: z.boolean().default(true),
  }),
  outputSchema: z.object({
    positions: z.array(PositionSchema),
    totalUnrealizedPnl: z.number(),
    marketState: MarketStateResponseSchema.nullable(),
    accountBalance: z.number(),
  }),
  execute: async ({ inputData }) => {
    const binance = getBinanceService()
    const config = getTradingConfig()

    const positions = await binance.getPositions()
    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedProfit,
      0
    )

    const balance = await binance.getUsdtBalance()
    const accountBalance = balance?.balance ?? 0

    let marketState: MarketStateResponse | null = null
    if (inputData.checkMarketState) {
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
        // Market state is optional
      }
    }

    return {
      positions,
      totalUnrealizedPnl,
      marketState,
      accountBalance,
    }
  },
})

// ============ Step 2: Analyze Position Risk ============

const analyzePositionRiskStep = createStep({
  id: "analyze-position-risk",
  description: "Analyzes risk level of each position",
  inputSchema: z.object({
    positions: z.array(PositionSchema),
    totalUnrealizedPnl: z.number(),
    marketState: MarketStateResponseSchema.nullable(),
    accountBalance: z.number(),
  }),
  outputSchema: z.object({
    positions: z.array(PositionSchema),
    positionsAtRisk: z.array(
      z.object({
        position: PositionSchema,
        riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        reason: z.string(),
        recommendation: z.enum(["HOLD", "REDUCE", "CLOSE"]),
      })
    ),
    portfolioRisk: z.object({
      totalExposure: z.number(),
      exposurePercent: z.number(),
      unrealizedPnlPercent: z.number(),
      overallRisk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    }),
    marketState: MarketStateResponseSchema.nullable(),
  }),
  execute: async ({ inputData }) => {
    const { positions, totalUnrealizedPnl, marketState, accountBalance } =
      inputData
    const config = getTradingConfig()

    // Analyze each position
    const positionsAtRisk: Array<{
      position: Position
      riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
      reason: string
      recommendation: "HOLD" | "REDUCE" | "CLOSE"
    }> = []

    for (const position of positions) {
      const pnlPercent = (position.unrealizedProfit / accountBalance) * 100
      const exposurePercent = (Math.abs(position.notional) / accountBalance) * 100

      let riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW"
      let reason = ""
      let recommendation: "HOLD" | "REDUCE" | "CLOSE" = "HOLD"

      // Check unrealized loss
      if (pnlPercent < -2) {
        riskLevel = "CRITICAL"
        reason = `Unrealized loss ${pnlPercent.toFixed(2)}% exceeds 2% threshold`
        recommendation = "CLOSE"
      } else if (pnlPercent < -1) {
        riskLevel = "HIGH"
        reason = `Unrealized loss ${pnlPercent.toFixed(2)}% approaching threshold`
        recommendation = "REDUCE"
      } else if (pnlPercent < -0.5) {
        riskLevel = "MEDIUM"
        reason = `Unrealized loss ${pnlPercent.toFixed(2)}%`
        recommendation = "HOLD"
      }

      // Check exposure
      if (exposurePercent > 30) {
        riskLevel = Math.max(riskLevel === "CRITICAL" ? 3 : riskLevel === "HIGH" ? 2 : riskLevel === "MEDIUM" ? 1 : 0, 2) === 3 ? "CRITICAL" : "HIGH"
        reason += (reason ? ". " : "") + `High exposure: ${exposurePercent.toFixed(1)}%`
        recommendation = recommendation === "CLOSE" ? "CLOSE" : "REDUCE"
      }

      // Check market state alignment
      if (marketState) {
        const positionDir = position.positionAmt > 0 ? "BULLISH" : "BEARISH"
        const marketDir =
          marketState.overallSentiment.score > 0 ? "BULLISH" : "BEARISH"

        if (
          positionDir !== marketDir &&
          Math.abs(marketState.overallSentiment.score) > 5
        ) {
          riskLevel = riskLevel === "CRITICAL" ? "CRITICAL" : "HIGH"
          reason +=
            (reason ? ". " : "") +
            `Position direction (${positionDir}) conflicts with market sentiment`
          recommendation = recommendation === "HOLD" ? "REDUCE" : recommendation
        }

        if (marketState.marketCondition === "HIGH_VOLATILITY") {
          riskLevel = riskLevel === "LOW" ? "MEDIUM" : riskLevel
          reason += (reason ? ". " : "") + "High volatility market"
        }
      }

      if (riskLevel !== "LOW" || reason) {
        positionsAtRisk.push({
          position,
          riskLevel,
          reason: reason || "Position within acceptable parameters",
          recommendation,
        })
      }
    }

    // Calculate portfolio risk
    const totalExposure = positions.reduce(
      (sum, p) => sum + Math.abs(p.notional),
      0
    )
    const exposurePercent =
      accountBalance > 0 ? (totalExposure / accountBalance) * 100 : 0
    const unrealizedPnlPercent =
      accountBalance > 0 ? (totalUnrealizedPnl / accountBalance) * 100 : 0

    let overallRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW"
    if (
      unrealizedPnlPercent < -config.risk.maxDailyLossPercent ||
      exposurePercent > 60
    ) {
      overallRisk = "CRITICAL"
    } else if (unrealizedPnlPercent < -2 || exposurePercent > 50) {
      overallRisk = "HIGH"
    } else if (unrealizedPnlPercent < -1 || exposurePercent > 30) {
      overallRisk = "MEDIUM"
    }

    return {
      positions,
      positionsAtRisk,
      portfolioRisk: {
        totalExposure,
        exposurePercent,
        unrealizedPnlPercent,
        overallRisk,
      },
      marketState,
    }
  },
})

// ============ Step 3: Execute Risk Actions ============

const executeRiskActionsStep = createStep({
  id: "execute-risk-actions",
  description: "Executes risk management actions (close/reduce positions)",
  inputSchema: z.object({
    positions: z.array(PositionSchema),
    positionsAtRisk: z.array(
      z.object({
        position: PositionSchema,
        riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        reason: z.string(),
        recommendation: z.enum(["HOLD", "REDUCE", "CLOSE"]),
      })
    ),
    portfolioRisk: z.object({
      totalExposure: z.number(),
      exposurePercent: z.number(),
      unrealizedPnlPercent: z.number(),
      overallRisk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    }),
    marketState: MarketStateResponseSchema.nullable(),
  }),
  outputSchema: z.object({
    actionsExecuted: z.array(
      z.object({
        symbol: z.string(),
        action: z.enum(["CLOSED", "REDUCED", "HELD"]),
        reason: z.string(),
        orderId: z.number().nullable(),
      })
    ),
    summary: z.object({
      totalPositions: z.number(),
      positionsClosed: z.number(),
      positionsReduced: z.number(),
      positionsHeld: z.number(),
      portfolioRiskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    }),
  }),
  execute: async ({ inputData }) => {
    const { positions, positionsAtRisk, portfolioRisk } = inputData
    const binance = getBinanceService()
    const riskManager = getRiskManager()
    const logStore = getAiDecisionLogStore()
    const logPromises: Array<Promise<unknown>> = []

    const actionsExecuted: Array<{
      symbol: string
      action: "CLOSED" | "REDUCED" | "HELD"
      reason: string
      orderId: number | null
    }> = []

    let positionsClosed = 0
    let positionsReduced = 0
    let positionsHeld = 0

    // Execute actions for at-risk positions
    for (const riskPosition of positionsAtRisk) {
      const { position, recommendation, reason, riskLevel } = riskPosition

      // Only act on CRITICAL risk or HIGH risk with CLOSE recommendation
      if (riskLevel === "CRITICAL" || recommendation === "CLOSE") {
        try {
          const result = await binance.closePosition(position.symbol)
          if (result) {
            actionsExecuted.push({
              symbol: position.symbol,
              action: "CLOSED",
              reason,
              orderId: result.orderId,
            })
            logPromises.push(
              logStore
                .append({
                  symbol: position.symbol,
                  source: "positionManagementWorkflow",
                  eventType: "RISK_ACTION",
                  action: "CLOSE_POSITION",
                  reasoning: reason,
                  meta: {
                    riskLevel,
                    recommendation,
                    orderId: result.orderId,
                    portfolioRisk: portfolioRisk.overallRisk,
                  },
                })
                .catch(() => null)
            )
            positionsClosed++

            // Update daily stats with realized PnL
            riskManager.updateDailyStats(position.unrealizedProfit)
          }
        } catch (error) {
          const errReason = `Failed to close: ${error instanceof Error ? error.message : "Unknown error"}`
          actionsExecuted.push({
            symbol: position.symbol,
            action: "HELD",
            reason: errReason,
            orderId: null,
          })
          logPromises.push(
            logStore
              .append({
                symbol: position.symbol,
                source: "positionManagementWorkflow",
                eventType: "RISK_ACTION",
                action: "HOLD",
                reasoning: errReason,
                meta: {
                  riskLevel,
                  recommendation,
                  portfolioRisk: portfolioRisk.overallRisk,
                },
              })
              .catch(() => null)
          )
          positionsHeld++
        }
      } else if (recommendation === "REDUCE") {
        // For now, we just log the reduction recommendation
        // In a more sophisticated system, we'd reduce position size
        const reduceReason = `Reduction recommended: ${reason}`
        actionsExecuted.push({
          symbol: position.symbol,
          action: "HELD",
          reason: reduceReason,
          orderId: null,
        })
        logPromises.push(
          logStore
            .append({
              symbol: position.symbol,
              source: "positionManagementWorkflow",
              eventType: "RISK_ACTION",
              action: "REDUCE_RECOMMENDED",
              reasoning: reduceReason,
              meta: {
                riskLevel,
                recommendation,
                portfolioRisk: portfolioRisk.overallRisk,
              },
            })
            .catch(() => null)
        )
        positionsHeld++
        positionsReduced++ // Count as "would be reduced"
      } else {
        actionsExecuted.push({
          symbol: position.symbol,
          action: "HELD",
          reason,
          orderId: null,
        })
        logPromises.push(
          logStore
            .append({
              symbol: position.symbol,
              source: "positionManagementWorkflow",
              eventType: "RISK_ACTION",
              action: "HOLD",
              reasoning: reason,
              meta: {
                riskLevel,
                recommendation,
                portfolioRisk: portfolioRisk.overallRisk,
              },
            })
            .catch(() => null)
        )
        positionsHeld++
      }
    }

    // Handle positions not in risk list (they're safe)
    const riskSymbols = new Set(positionsAtRisk.map((r) => r.position.symbol))
    const safePositions = positions.filter((p) => !riskSymbols.has(p.symbol))
    positionsHeld += safePositions.length

    await Promise.all(logPromises)

    return {
      actionsExecuted,
      summary: {
        totalPositions: positions.length,
        positionsClosed,
        positionsReduced,
        positionsHeld,
        portfolioRiskLevel: portfolioRisk.overallRisk,
      },
    }
  },
})

// ============ Create Workflow ============

export const positionManagementWorkflow = createWorkflow({
  id: "position-management-workflow",
  inputSchema: z.object({
    checkMarketState: z.boolean().default(true),
  }),
  outputSchema: z.object({
    actionsExecuted: z.array(
      z.object({
        symbol: z.string(),
        action: z.enum(["CLOSED", "REDUCED", "HELD"]),
        reason: z.string(),
        orderId: z.number().nullable(),
      })
    ),
    summary: z.object({
      totalPositions: z.number(),
      positionsClosed: z.number(),
      positionsReduced: z.number(),
      positionsHeld: z.number(),
      portfolioRiskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    }),
  }),
})
  .then(fetchPositionsStep)
  .then(analyzePositionRiskStep)
  .then(executeRiskActionsStep)

positionManagementWorkflow.commit()
