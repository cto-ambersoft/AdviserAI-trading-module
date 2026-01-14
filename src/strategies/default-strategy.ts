import {
  type AnalysisResponse,
  type TradeSignal,
  type Position,
} from "../types/trading"
import { BaseStrategy, registerStrategy } from "./base-strategy"

/**
 * Default Trading Strategy
 *
 * This strategy follows the Core Analytics recommendations directly:
 * - Opens positions when analysis recommends OPEN_LONG or OPEN_SHORT
 * - Uses the entry, stop loss, and take profit from analysis
 * - Requires minimum 2:1 R:R and respects configured confidence floors
 */
export class DefaultStrategy extends BaseStrategy {
  id = "default"
  name = "Default Strategy"
  description =
    "Follows Core Analytics recommendations with standard risk management"

  async analyze(analysis: AnalysisResponse): Promise<TradeSignal | null> {
    // Validate analysis
    if (!this.validateAnalysis(analysis)) {
      return null
    }

    const direction = this.getRecommendedDirection(analysis)
    if (!direction) {
      return null
    }

    const { recommendations, currentPrice, confidence, symbol } = analysis
    const entryDetails =
      direction === "LONG"
        ? recommendations.longEntry
        : recommendations.shortEntry

    if (!entryDetails) {
      return null
    }

    // Validate R:R
    if (entryDetails.riskReward < 2) {
      return null
    }

    return {
      symbol,
      direction,
      entryPrice: entryDetails.price,
      stopLoss: entryDetails.stopLoss,
      takeProfit: entryDetails.takeProfit,
      riskReward: entryDetails.riskReward,
      confidence,
      reasoning: recommendations.reasoning,
    }
  }

  override getExitConditions(position: Position): {
    takeProfit: number
    stopLoss: number
  } {
    // Use analysis-provided levels if available
    // Otherwise fall back to default calculation
    return super.getExitConditions(position)
  }
}

/**
 * Conservative Strategy
 *
 * More conservative approach:
 * - Higher confidence threshold (65%)
 * - Higher R:R requirement (3:1)
 * - Only trades when bias is strong
 */
export class ConservativeStrategy extends BaseStrategy {
  id = "conservative"
  name = "Conservative Strategy"
  description = "Higher thresholds for more selective trading"

  async analyze(analysis: AnalysisResponse): Promise<TradeSignal | null> {
    // Higher confidence threshold
    if (analysis.confidence < 0.65) {
      return null
    }

    // Only trade with strong bias
    if (analysis.bias === "NEUTRAL") {
      return null
    }

    const direction = this.getRecommendedDirection(analysis)
    if (!direction) {
      return null
    }

    // Verify bias alignment
    if (direction === "LONG" && analysis.bias !== "BULLISH") {
      return null
    }
    if (direction === "SHORT" && analysis.bias !== "BEARISH") {
      return null
    }

    const { recommendations, confidence, symbol } = analysis
    const entryDetails =
      direction === "LONG"
        ? recommendations.longEntry
        : recommendations.shortEntry

    if (!entryDetails) {
      return null
    }

    // Higher R:R requirement
    if (entryDetails.riskReward < 3) {
      return null
    }

    return {
      symbol,
      direction,
      entryPrice: entryDetails.price,
      stopLoss: entryDetails.stopLoss,
      takeProfit: entryDetails.takeProfit,
      riskReward: entryDetails.riskReward,
      confidence,
      reasoning: `[Conservative] ${recommendations.reasoning}`,
    }
  }
}

/**
 * Aggressive Strategy
 *
 * More aggressive approach:
 * - Lower confidence threshold (40%)
 * - Lower R:R requirement (1.5:1)
 * - Trades on neutral bias too
 */
export class AggressiveStrategy extends BaseStrategy {
  id = "aggressive"
  name = "Aggressive Strategy"
  description = "Lower thresholds for more frequent trading"

  async analyze(analysis: AnalysisResponse): Promise<TradeSignal | null> {
    // Lower confidence threshold
    if (analysis.confidence < 0.4) {
      return null
    }

    const direction = this.getRecommendedDirection(analysis)
    if (!direction) {
      return null
    }

    const { recommendations, confidence, symbol } = analysis
    const entryDetails =
      direction === "LONG"
        ? recommendations.longEntry
        : recommendations.shortEntry

    if (!entryDetails) {
      return null
    }

    // Lower R:R requirement
    if (entryDetails.riskReward < 1.5) {
      return null
    }

    return {
      symbol,
      direction,
      entryPrice: entryDetails.price,
      stopLoss: entryDetails.stopLoss,
      takeProfit: entryDetails.takeProfit,
      riskReward: entryDetails.riskReward,
      confidence,
      reasoning: `[Aggressive] ${recommendations.reasoning}`,
    }
  }
}

// Register default strategies
const defaultStrategy = new DefaultStrategy()
const conservativeStrategy = new ConservativeStrategy()
const aggressiveStrategy = new AggressiveStrategy()

registerStrategy(defaultStrategy)
registerStrategy(conservativeStrategy)
registerStrategy(aggressiveStrategy)

export { defaultStrategy, conservativeStrategy, aggressiveStrategy }
