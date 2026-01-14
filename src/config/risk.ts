import { RiskConfigSchema, type RiskConfig } from "../types/trading"

// Default risk configuration
export const defaultRiskConfig: RiskConfig = {
  maxPositionSizePercent: 2,
  maxDailyLossPercent: 5,
  maxOpenPositions: 3,
  minRiskReward: 2,
  maxLeveragePerPosition: 10,
  defaultRiskPerTradeUsd: 100,
}

// Conservative risk profile
export const conservativeRiskConfig: RiskConfig = {
  maxPositionSizePercent: 1,
  maxDailyLossPercent: 3,
  maxOpenPositions: 2,
  minRiskReward: 3,
  maxLeveragePerPosition: 5,
  defaultRiskPerTradeUsd: 50,
}

// Aggressive risk profile
export const aggressiveRiskConfig: RiskConfig = {
  maxPositionSizePercent: 5,
  maxDailyLossPercent: 10,
  maxOpenPositions: 5,
  minRiskReward: 1.5,
  maxLeveragePerPosition: 20,
  defaultRiskPerTradeUsd: 200,
}

export function validateRiskConfig(config: unknown): RiskConfig {
  return RiskConfigSchema.parse(config)
}

export function createRiskConfig(overrides: Partial<RiskConfig>): RiskConfig {
  return {
    ...defaultRiskConfig,
    ...overrides,
  }
}
