import { z } from "zod"

// ============ Core Analysis Types ============

export const BiasSchema = z.enum(["BULLISH", "BEARISH", "NEUTRAL"])
export type Bias = z.infer<typeof BiasSchema>

export const ActionSchema = z.enum([
  "OPEN_LONG",
  "OPEN_SHORT",
  "CLOSE_LONG",
  "CLOSE_SHORT",
  "HOLD",
  "WAIT",
])
export type Action = z.infer<typeof ActionSchema>

export const KeyLevelsSchema = z.object({
  strongSupport: z.number(),
  support: z.number(),
  resistance: z.number(),
  strongResistance: z.number(),
  pivotPoint: z.number().optional(),
})
export type KeyLevels = z.infer<typeof KeyLevelsSchema>

export const ScenarioSchema = z.object({
  case: z.enum(["Bullish", "Bearish"]),
  conditions: z.string(),
  targetPrice: z.number(),
  stopPrice: z.number(),
  move: z.string(),
  probability: z.number(),
  timeframe: z.string().optional(),
})
export type Scenario = z.infer<typeof ScenarioSchema>

export const EntryDetailsSchema = z.object({
  price: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number(),
  riskReward: z.number(),
})
export type EntryDetails = z.infer<typeof EntryDetailsSchema>

export const RecommendationSchema = z.object({
  action: ActionSchema,
  reasoning: z.string(),
  longEntry: EntryDetailsSchema.optional(),
  shortEntry: EntryDetailsSchema.optional(),
})
export type Recommendation = z.infer<typeof RecommendationSchema>

export const TechSignalSchema = z.object({
  signal: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number(),
})
export type TechSignal = z.infer<typeof TechSignalSchema>

export const DataQualitySchema = z.object({
  score: z.number(),
  sources: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
})
export type DataQuality = z.infer<typeof DataQualitySchema>

export const AnalysisResponseSchema = z.object({
  symbol: z.string(),
  timestamp: z.string(),
  currentPrice: z.number(),
  bias: BiasSchema,
  confidence: z.number(),
  summary: z.string(),
  keyLevels: KeyLevelsSchema,
  scenarios: z.array(ScenarioSchema),
  recommendations: RecommendationSchema,
  techSignal: TechSignalSchema.optional(),
  dataQuality: DataQualitySchema,
})
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>

// Market State Types
export const MarketConditionSchema = z.enum([
  "RISK_ON",
  "RISK_OFF",
  "NEUTRAL",
  "HIGH_VOLATILITY",
])
export type MarketCondition = z.infer<typeof MarketConditionSchema>

export const PositionSizingSchema = z.enum(["FULL", "REDUCED", "MINIMAL", "NONE"])
export type PositionSizing = z.infer<typeof PositionSizingSchema>

export const MarketStateResponseSchema = z.object({
  timestamp: z.string(),
  marketCondition: MarketConditionSchema,
  btcDominance: z.object({
    trend: z.enum(["INCREASING", "DECREASING", "STABLE"]),
    implication: z.string(),
  }),
  overallSentiment: z.object({
    score: z.number(),
    label: z.enum([
      "EXTREME_FEAR",
      "FEAR",
      "NEUTRAL",
      "GREED",
      "EXTREME_GREED",
    ]),
  }),
  metrics: z.object({
    btcPrice: z.number(),
    ethPrice: z.number(),
    fearGreedIndex: z.number().optional(),
  }),
  recommendation: z.object({
    positionSizing: PositionSizingSchema,
    reasoning: z.string(),
  }),
  alerts: z
    .array(
      z.object({
        level: z.enum(["INFO", "WARNING", "CRITICAL"]),
        message: z.string(),
      })
    )
    .optional(),
})
export type MarketStateResponse = z.infer<typeof MarketStateResponseSchema>

// ============ Trading Types ============

export const DirectionSchema = z.enum(["LONG", "SHORT"])
export type Direction = z.infer<typeof DirectionSchema>

export const OrderSideSchema = z.enum(["BUY", "SELL"])
export type OrderSide = z.infer<typeof OrderSideSchema>

export const OrderTypeSchema = z.enum([
  "LIMIT",
  "MARKET",
  "STOP",
  "STOP_MARKET",
  "TAKE_PROFIT",
  "TAKE_PROFIT_MARKET",
  "TRAILING_STOP_MARKET",
])
export type OrderType = z.infer<typeof OrderTypeSchema>

export const PositionSideSchema = z.enum(["BOTH", "LONG", "SHORT"])
export type PositionSide = z.infer<typeof PositionSideSchema>

export const TimeInForceSchema = z.enum(["GTC", "IOC", "FOK", "GTX", "GTD"])
export type TimeInForce = z.infer<typeof TimeInForceSchema>

export const TradeSignalSchema = z.object({
  symbol: z.string(),
  direction: DirectionSchema,
  entryPrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number(),
  riskReward: z.number(),
  confidence: z.number(),
  reasoning: z.string(),
})
export type TradeSignal = z.infer<typeof TradeSignalSchema>

export const PositionSchema = z.object({
  symbol: z.string(),
  positionSide: PositionSideSchema,
  positionAmt: z.number(),
  entryPrice: z.number(),
  markPrice: z.number(),
  unrealizedProfit: z.number(),
  liquidationPrice: z.number(),
  leverage: z.number(),
  marginType: z.enum(["isolated", "cross"]),
  notional: z.number(),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
})
export type Position = z.infer<typeof PositionSchema>

export const OrderSchema = z.object({
  orderId: z.number(),
  symbol: z.string(),
  status: z.string(),
  clientOrderId: z.string(),
  price: z.number(),
  avgPrice: z.number(),
  origQty: z.number(),
  executedQty: z.number(),
  type: OrderTypeSchema,
  side: OrderSideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().optional(),
  time: z.number(),
  updateTime: z.number(),
})
export type Order = z.infer<typeof OrderSchema>

export const AccountBalanceSchema = z.object({
  asset: z.string(),
  balance: z.number(),
  availableBalance: z.number(),
  crossWalletBalance: z.number(),
  crossUnPnl: z.number(),
})
export type AccountBalance = z.infer<typeof AccountBalanceSchema>

export const NewOrderParamsSchema = z.object({
  symbol: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  positionSide: PositionSideSchema.optional(),
  quantity: z.number().optional(),
  price: z.number().optional(),
  stopPrice: z.number().optional(),
  timeInForce: TimeInForceSchema.optional(),
  reduceOnly: z.boolean().optional(),
  closePosition: z.boolean().optional(),
})
export type NewOrderParams = z.infer<typeof NewOrderParamsSchema>

export const BracketOrderParamsSchema = z.object({
  symbol: z.string(),
  side: OrderSideSchema,
  positionSide: PositionSideSchema.optional(),
  quantity: z.number(),
  entryPrice: z.number().optional(),
  takeProfitPrice: z.number(),
  stopLossPrice: z.number(),
  entryType: z.enum(["LIMIT", "MARKET"]).default("MARKET"),
})
export type BracketOrderParams = z.infer<typeof BracketOrderParamsSchema>

// Result type for bracket orders with partial success handling
export interface BracketOrderResult {
  entry: {
    orderId: number
    status: string
    executedQty: number
    avgPrice: number
  }
  tp: {
    orderId: number
    status: string
  } | null
  sl: {
    orderId: number
    status: string
  } | null
  tpError?: string
  slError?: string
  /** True if entry succeeded but one or both of TP/SL failed */
  partialSuccess: boolean
}

// ============ Risk Management Types ============

export const RiskConfigSchema = z.object({
  maxPositionSizePercent: z.number().min(0).max(100).default(2),
  maxDailyLossPercent: z.number().min(0).max(100).default(5),
  maxOpenPositions: z.number().min(1).default(3),
  minRiskReward: z.number().min(1).default(2),
  maxLeveragePerPosition: z.number().min(1).max(125).default(10),
  defaultRiskPerTradeUsd: z.number().positive().default(100),
})
export type RiskConfig = z.infer<typeof RiskConfigSchema>

export const RiskValidationResultSchema = z.object({
  isValid: z.boolean(),
  reasons: z.array(z.string()),
  adjustedParams: z
    .object({
      quantity: z.number().optional(),
      leverage: z.number().optional(),
    })
    .optional(),
})
export type RiskValidationResult = z.infer<typeof RiskValidationResultSchema>

// ============ Strategy Types ============

export interface TradingStrategy {
  id: string
  name: string
  description: string

  analyze(analysis: AnalysisResponse): Promise<TradeSignal | null>
  getEntryParams(signal: TradeSignal): NewOrderParams
  getExitConditions(position: Position): {
    takeProfit: number
    stopLoss: number
  }
}

// ============ Workflow Types ============

export const TradeExecutionInputSchema = z.object({
  symbol: z.string(),
  riskAmountUsd: z.number().positive(),
  strategyId: z.string().optional(),
  // Optional overrides to avoid race conditions between analysis and execution
  analysisOverride: AnalysisResponseSchema.optional(),
  marketStateOverride: MarketStateResponseSchema.optional(),
})
export type TradeExecutionInput = z.infer<typeof TradeExecutionInputSchema>

export const TradeExecutionResultSchema = z.object({
  success: z.boolean(),
  orderId: z.number().optional(),
  position: PositionSchema.optional(),
  error: z.string().optional(),
  reasoning: z.string(),
})
export type TradeExecutionResult = z.infer<typeof TradeExecutionResultSchema>
