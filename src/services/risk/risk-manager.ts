import { getTradingConfig } from "../../config/trading"
import { getBinanceService } from "../binance/client"
import {
  type RiskConfig,
  type RiskValidationResult,
  type TradeSignal,
  type Position,
} from "../../types/trading"
import { calculatePosition, type TradeResult } from "../../mastra/tools/position-calculator-tool"

export interface TradeValidationParams {
  symbol: string
  direction: "LONG" | "SHORT"
  entryPrice: number
  stopLoss: number
  takeProfit: number
  riskAmountUsd?: number
}

export interface DailyStats {
  realizedPnl: number
  tradesCount: number
  winCount: number
  lossCount: number
  largestWin: number
  largestLoss: number
}

export class RiskManager {
  private config: RiskConfig
  private dailyStats: DailyStats = {
    realizedPnl: 0,
    tradesCount: 0,
    winCount: 0,
    lossCount: 0,
    largestWin: 0,
    largestLoss: 0,
  }

  constructor(config?: Partial<RiskConfig>) {
    const tradingConfig = getTradingConfig()
    this.config = {
      ...tradingConfig.risk,
      ...config,
    }
  }

  // ============ Trade Validation ============

  async validateTrade(params: TradeValidationParams): Promise<RiskValidationResult> {
    const reasons: string[] = []
    const binance = getBinanceService()

    // 1. Check daily loss limit
    if (this.isDailyLossLimitReached()) {
      return {
        isValid: false,
        reasons: ["Daily loss limit reached"],
      }
    }

    // 2. Check max open positions
    const positions = await binance.getPositions()
    if (positions.length >= this.config.maxOpenPositions) {
      // Check if we already have a position in this symbol
      const existingPosition = positions.find((p) => p.symbol === params.symbol)
      if (!existingPosition) {
        return {
          isValid: false,
          reasons: [
            `Maximum open positions (${this.config.maxOpenPositions}) reached`,
          ],
        }
      }
    }

    // 3. Check if we already have a position in opposite direction
    const existingPosition = positions.find((p) => p.symbol === params.symbol)
    if (existingPosition) {
      const existingDirection = existingPosition.positionAmt > 0 ? "LONG" : "SHORT"
      if (existingDirection !== params.direction) {
        reasons.push(
          `Existing ${existingDirection} position found - consider closing first`
        )
      }
    }

    // 4. Validate Risk:Reward ratio
    const riskReward = this.calculateRiskReward(params)
    if (riskReward < this.config.minRiskReward) {
      return {
        isValid: false,
        reasons: [
          `Risk:Reward ratio (${riskReward.toFixed(2)}) is below minimum (${this.config.minRiskReward})`,
        ],
      }
    }

    // 5. Check position size against max allowed
    const balance = await binance.getUsdtBalance()
    if (!balance) {
      return {
        isValid: false,
        reasons: ["Unable to fetch account balance"],
      }
    }

    const riskAmount =
      params.riskAmountUsd ?? this.config.defaultRiskPerTradeUsd
    const maxRiskAmount =
      (balance.availableBalance * this.config.maxPositionSizePercent) / 100

    if (riskAmount > maxRiskAmount) {
      reasons.push(
        `Risk amount adjusted from $${riskAmount} to max $${maxRiskAmount.toFixed(2)}`
      )
    }

    return {
      isValid: true,
      reasons,
      adjustedParams:
        riskAmount > maxRiskAmount
          ? { quantity: undefined } // Will be recalculated with adjusted risk
          : undefined,
    }
  }

  // ============ Position Sizing ============

  async calculatePositionSize(params: TradeValidationParams): Promise<TradeResult> {
    const config = getTradingConfig()
    const riskAmount = params.riskAmountUsd ?? this.config.defaultRiskPerTradeUsd

    // Validate and adjust risk amount if needed
    const binance = getBinanceService()
    const balance = await binance.getUsdtBalance()

    let adjustedRisk = riskAmount
    if (balance) {
      const maxRisk =
        (balance.availableBalance * this.config.maxPositionSizePercent) / 100
      adjustedRisk = Math.min(riskAmount, maxRisk)
    }

    return calculatePosition({
      riskUsd: adjustedRisk,
      entryPrice: params.entryPrice,
      stopLoss: params.stopLoss,
      feePercent: config.trading.defaultFeePercent,
      rrRatio: this.calculateRiskReward(params),
    })
  }

  // ============ Risk Calculations ============

  calculateRiskReward(params: TradeValidationParams): number {
    const { entryPrice, stopLoss, takeProfit, direction } = params

    let riskDistance: number
    let rewardDistance: number

    if (direction === "LONG") {
      riskDistance = entryPrice - stopLoss
      rewardDistance = takeProfit - entryPrice
    } else {
      riskDistance = stopLoss - entryPrice
      rewardDistance = entryPrice - takeProfit
    }

    if (riskDistance <= 0) {
      throw new Error("Invalid stop loss position")
    }

    return rewardDistance / riskDistance
  }

  calculatePositionRisk(position: Position): number {
    const { entryPrice, markPrice, notional, leverage } = position
    const pnlPercent = ((markPrice - entryPrice) / entryPrice) * 100

    // Account for leverage
    return Math.abs(pnlPercent * leverage)
  }

  // ============ Daily Stats Management ============

  isDailyLossLimitReached(): boolean {
    if (this.dailyStats.realizedPnl >= 0) return false

    const binance = getBinanceService()
    // This is a simplified check - in production you'd want to track this more accurately
    const lossPercent = Math.abs(this.dailyStats.realizedPnl)
    // Assuming we track against a base balance
    return lossPercent >= this.config.maxDailyLossPercent
  }

  updateDailyStats(pnl: number): void {
    this.dailyStats.realizedPnl += pnl
    this.dailyStats.tradesCount++

    if (pnl > 0) {
      this.dailyStats.winCount++
      this.dailyStats.largestWin = Math.max(this.dailyStats.largestWin, pnl)
    } else {
      this.dailyStats.lossCount++
      this.dailyStats.largestLoss = Math.min(this.dailyStats.largestLoss, pnl)
    }
  }

  getDailyStats(): DailyStats {
    return { ...this.dailyStats }
  }

  resetDailyStats(): void {
    this.dailyStats = {
      realizedPnl: 0,
      tradesCount: 0,
      winCount: 0,
      lossCount: 0,
      largestWin: 0,
      largestLoss: 0,
    }
  }

  // ============ Risk Assessment ============

  async assessPortfolioRisk(): Promise<{
    totalExposure: number
    totalUnrealizedPnl: number
    positionsAtRisk: Position[]
    recommendation: string
  }> {
    const binance = getBinanceService()
    const positions = await binance.getPositions()
    const balance = await binance.getUsdtBalance()

    const totalExposure = positions.reduce(
      (sum, p) => sum + Math.abs(p.notional),
      0
    )
    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedProfit,
      0
    )

    // Find positions that are significantly negative
    const positionsAtRisk = positions.filter(
      (p) => p.unrealizedProfit < -this.config.defaultRiskPerTradeUsd * 0.5
    )

    let recommendation = "Portfolio within acceptable risk parameters"

    if (balance) {
      const exposurePercent = (totalExposure / balance.balance) * 100
      if (exposurePercent > 50) {
        recommendation = "High exposure - consider reducing positions"
      }
    }

    if (totalUnrealizedPnl < -this.config.defaultRiskPerTradeUsd * 2) {
      recommendation = "Significant unrealized losses - review positions"
    }

    if (positionsAtRisk.length > 0) {
      recommendation = `${positionsAtRisk.length} position(s) at elevated risk`
    }

    return {
      totalExposure,
      totalUnrealizedPnl,
      positionsAtRisk,
      recommendation,
    }
  }

  // ============ Configuration ============

  getConfig(): RiskConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...updates }
  }
}

// Singleton instance
let riskManagerInstance: RiskManager | null = null

export function getRiskManager(): RiskManager {
  if (!riskManagerInstance) {
    riskManagerInstance = new RiskManager()
  }
  return riskManagerInstance
}
