import {
  type TradingStrategy,
  type AnalysisResponse,
  type TradeSignal,
  type Position,
  type NewOrderParams,
} from "../types/trading"
import { getTradingConfig } from "../config/trading"

export abstract class BaseStrategy implements TradingStrategy {
  abstract id: string
  abstract name: string
  abstract description: string

  abstract analyze(analysis: AnalysisResponse): Promise<TradeSignal | null>

  getEntryParams(signal: TradeSignal): NewOrderParams {
    return {
      symbol: signal.symbol,
      side: signal.direction === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      positionSide: "BOTH",
    }
  }

  getExitConditions(position: Position): {
    takeProfit: number
    stopLoss: number
  } {
    // Default: 3:1 R:R based on entry
    const direction = position.positionAmt > 0 ? "LONG" : "SHORT"
    const riskDistance = Math.abs(position.entryPrice * 0.02) // 2% risk

    if (direction === "LONG") {
      return {
        stopLoss: position.entryPrice - riskDistance,
        takeProfit: position.entryPrice + riskDistance * 3,
      }
    } else {
      return {
        stopLoss: position.entryPrice + riskDistance,
        takeProfit: position.entryPrice - riskDistance * 3,
      }
    }
  }

  protected validateAnalysis(analysis: AnalysisResponse): boolean {
    const config = getTradingConfig()
    // Basic validation
    if (analysis.confidence < config.trading.hardRejectConfidence) return false
    if (analysis.dataQuality.score < 5) return false
    return true
  }

  protected getRecommendedDirection(
    analysis: AnalysisResponse
  ): "LONG" | "SHORT" | null {
    const { recommendations, bias } = analysis

    if (recommendations.action === "OPEN_LONG" && bias !== "BEARISH") {
      return "LONG"
    }
    if (recommendations.action === "OPEN_SHORT" && bias !== "BULLISH") {
      return "SHORT"
    }
    return null
  }
}

// Strategy Registry
export const strategyRegistry = new Map<string, TradingStrategy>()

export function registerStrategy(strategy: TradingStrategy): void {
  strategyRegistry.set(strategy.id, strategy)
}

export function getStrategy(id: string): TradingStrategy | undefined {
  return strategyRegistry.get(id)
}

export function listStrategies(): TradingStrategy[] {
  return Array.from(strategyRegistry.values())
}
