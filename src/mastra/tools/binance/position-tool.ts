import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { getBinanceService } from "../../../services/binance/client"
import { PositionSchema } from "../../../types/trading"

const getPositionsInputSchema = z.object({
  symbol: z.string().optional().describe("Trading symbol (e.g., BTCUSDT). If not provided, returns all positions."),
})

const getPositionsOutputSchema = z.object({
  positions: z.array(PositionSchema),
  totalUnrealizedPnl: z.number(),
  positionsCount: z.number(),
})

export const binanceGetPositionsTool = createTool({
  id: "binance-get-positions",
  description:
    "Get all open positions from Binance Futures. Returns position details including entry price, PnL, leverage, and liquidation price.",
  inputSchema: getPositionsInputSchema,
  outputSchema: getPositionsOutputSchema,
  execute: async ({ symbol }) => {
    const binance = getBinanceService()

    const positions = await binance.getPositions(symbol)
    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedProfit,
      0
    )

    return {
      positions,
      totalUnrealizedPnl,
      positionsCount: positions.length,
    }
  },
})

const closePositionInputSchema = z.object({
  symbol: z.string().describe("Trading symbol to close position for (e.g., BTCUSDT)"),
})

const closePositionOutputSchema = z.object({
  success: z.boolean(),
  orderId: z.number().optional(),
  closedPosition: PositionSchema.optional(),
  message: z.string(),
})

export const binanceClosePositionTool = createTool({
  id: "binance-close-position",
  description:
    "Close an open position on Binance Futures by placing a market order in the opposite direction.",
  inputSchema: closePositionInputSchema,
  outputSchema: closePositionOutputSchema,
  execute: async ({ symbol }) => {
    const binance = getBinanceService()

    // Get current position
    const position = await binance.getPosition(symbol)
    if (!position || position.positionAmt === 0) {
      return {
        success: false,
        message: `No open position found for ${symbol}`,
      }
    }

    // Close the position
    const result = await binance.closePosition(symbol)
    if (!result) {
      return {
        success: false,
        message: `Failed to close position for ${symbol}`,
      }
    }

    return {
      success: true,
      orderId: result.orderId,
      closedPosition: position,
      message: `Successfully closed ${position.positionAmt > 0 ? "LONG" : "SHORT"} position for ${symbol}`,
    }
  },
})

const setLeverageInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
  leverage: z.number().min(1).max(125).describe("Leverage to set (1-125)"),
})

const setLeverageOutputSchema = z.object({
  success: z.boolean(),
  symbol: z.string(),
  leverage: z.number(),
  message: z.string(),
})

export const binanceSetLeverageTool = createTool({
  id: "binance-set-leverage",
  description: "Set leverage for a trading symbol on Binance Futures.",
  inputSchema: setLeverageInputSchema,
  outputSchema: setLeverageOutputSchema,
  execute: async ({ symbol, leverage }) => {
    const binance = getBinanceService()

    try {
      await binance.setLeverage(symbol, leverage)
      return {
        success: true,
        symbol,
        leverage,
        message: `Successfully set leverage to ${leverage}x for ${symbol}`,
      }
    } catch (error) {
      return {
        success: false,
        symbol,
        leverage,
        message: `Failed to set leverage: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})
