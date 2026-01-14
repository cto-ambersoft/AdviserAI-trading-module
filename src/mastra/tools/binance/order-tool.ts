import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { getBinanceService } from "../../../services/binance/client"
import {
  OrderSideSchema,
  OrderTypeSchema,
  PositionSideSchema,
  OrderSchema,
} from "../../../types/trading"

// ============ Submit Order Tool ============

const submitOrderInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
  side: OrderSideSchema.describe("Order side: BUY or SELL"),
  type: OrderTypeSchema.describe("Order type: MARKET, LIMIT, STOP, STOP_MARKET, TAKE_PROFIT, TAKE_PROFIT_MARKET"),
  quantity: z.number().positive().describe("Order quantity in base asset"),
  price: z.number().positive().optional().describe("Limit price (required for LIMIT orders)"),
  stopPrice: z.number().positive().optional().describe("Stop price (required for STOP orders)"),
  positionSide: PositionSideSchema.optional().describe("Position side: BOTH, LONG, or SHORT"),
  reduceOnly: z.boolean().optional().describe("Whether to reduce position only"),
})

const submitOrderOutputSchema = z.object({
  success: z.boolean(),
  orderId: z.number().optional(),
  status: z.string().optional(),
  executedQty: z.number().optional(),
  avgPrice: z.number().optional(),
  message: z.string(),
})

export const binanceSubmitOrderTool = createTool({
  id: "binance-submit-order",
  description:
    "Submit an order to Binance Futures. Supports market, limit, stop-loss, and take-profit orders.",
  inputSchema: submitOrderInputSchema,
  outputSchema: submitOrderOutputSchema,
  execute: async ({ symbol, side, type, quantity, price, stopPrice, positionSide, reduceOnly }) => {
    const binance = getBinanceService()

    try {
      const result = await binance.submitOrder({
        symbol,
        side,
        type,
        quantity,
        price,
        stopPrice,
        positionSide,
        reduceOnly,
        timeInForce: type === "LIMIT" ? "GTC" : undefined,
      })

      return {
        success: true,
        orderId: result.orderId,
        status: result.status,
        executedQty: parseFloat(result.executedQty),
        avgPrice: parseFloat(result.avgPrice),
        message: `Order ${result.orderId} ${result.status}`,
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to submit order: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})

// ============ Submit Bracket Order Tool ============

const submitBracketOrderInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
  side: OrderSideSchema.describe("Entry order side: BUY for long, SELL for short"),
  quantity: z.number().positive().describe("Order quantity in base asset"),
  entryPrice: z.number().positive().optional().describe("Entry price for limit order (omit for market order)"),
  takeProfitPrice: z.number().positive().describe("Take profit price"),
  stopLossPrice: z.number().positive().describe("Stop loss price"),
  positionSide: PositionSideSchema.optional().describe("Position side: BOTH, LONG, or SHORT"),
})

const submitBracketOrderOutputSchema = z.object({
  success: z.boolean(),
  entryOrderId: z.number().optional(),
  takeProfitOrderId: z.number().optional().nullable(),
  stopLossOrderId: z.number().optional().nullable(),
  entryStatus: z.string().optional(),
  message: z.string(),
  // Partial success tracking
  partialSuccess: z.boolean().optional(),
  tpError: z.string().optional(),
  slError: z.string().optional(),
})

export const binanceSubmitBracketOrderTool = createTool({
  id: "binance-submit-bracket-order",
  description:
    "Submit a bracket order (entry + take profit + stop loss) to Binance Futures. This creates three orders: an entry order, a take profit order, and a stop loss order. Returns partial success if entry succeeds but TP/SL fail.",
  inputSchema: submitBracketOrderInputSchema,
  outputSchema: submitBracketOrderOutputSchema,
  execute: async ({
    symbol,
    side,
    quantity,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    positionSide,
  }) => {
    const binance = getBinanceService()

    try {
      const result = await binance.submitBracketOrder({
        symbol,
        side,
        quantity,
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        positionSide,
        entryType: entryPrice ? "LIMIT" : "MARKET",
      })

      // Build message with status of all orders
      const tpStatus = result.tp
        ? `TP ${result.tp.orderId}`
        : `TP FAILED: ${result.tpError}`
      const slStatus = result.sl
        ? `SL ${result.sl.orderId}`
        : `SL FAILED: ${result.slError}`
      const message = `Bracket order created: Entry ${result.entry.orderId}, ${tpStatus}, ${slStatus}`

      return {
        success: true,
        entryOrderId: result.entry.orderId,
        takeProfitOrderId: result.tp?.orderId ?? null,
        stopLossOrderId: result.sl?.orderId ?? null,
        entryStatus: result.entry.status,
        message,
        partialSuccess: result.partialSuccess,
        tpError: result.tpError,
        slError: result.slError,
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to submit bracket order: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})

// ============ Cancel Order Tool ============

const cancelOrderInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
  orderId: z.number().describe("Order ID to cancel"),
})

const cancelOrderOutputSchema = z.object({
  success: z.boolean(),
  orderId: z.number().optional(),
  status: z.string().optional(),
  message: z.string(),
})

export const binanceCancelOrderTool = createTool({
  id: "binance-cancel-order",
  description: "Cancel an open order on Binance Futures.",
  inputSchema: cancelOrderInputSchema,
  outputSchema: cancelOrderOutputSchema,
  execute: async ({ symbol, orderId }) => {
    const binance = getBinanceService()

    try {
      const result = await binance.cancelOrder(symbol, orderId)
      return {
        success: true,
        orderId: result.orderId,
        status: result.status,
        message: `Order ${orderId} cancelled`,
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to cancel order: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})

// ============ Get Open Orders Tool ============

const getOpenOrdersInputSchema = z.object({
  symbol: z.string().optional().describe("Trading symbol (e.g., BTCUSDT). If not provided, returns all open orders."),
})

const getOpenOrdersOutputSchema = z.object({
  orders: z.array(OrderSchema),
  count: z.number(),
})

export const binanceGetOpenOrdersTool = createTool({
  id: "binance-get-open-orders",
  description: "Get all open orders from Binance Futures.",
  inputSchema: getOpenOrdersInputSchema,
  outputSchema: getOpenOrdersOutputSchema,
  execute: async ({ symbol }) => {
    const binance = getBinanceService()

    const orders = await binance.getOpenOrders(symbol)
    return {
      orders,
      count: orders.length,
    }
  },
})

// ============ Get Price Tool ============

const getPriceInputSchema = z.object({
  symbol: z.string().describe("Trading symbol (e.g., BTCUSDT)"),
})

const getPriceOutputSchema = z.object({
  symbol: z.string(),
  price: z.number(),
})

export const binanceGetPriceTool = createTool({
  id: "binance-get-price",
  description: "Get current price for a trading symbol on Binance Futures.",
  inputSchema: getPriceInputSchema,
  outputSchema: getPriceOutputSchema,
  execute: async ({ symbol }) => {
    const binance = getBinanceService()
    const price = await binance.getPrice(symbol)
    return { symbol, price }
  },
})
