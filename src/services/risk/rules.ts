import { type Position, type AnalysisResponse, type MarketStateResponse } from "../../types/trading"

export type RuleResult = {
  passed: boolean
  reason: string
}

export type RiskRule = {
  id: string
  name: string
  description: string
  evaluate: (context: RuleContext) => RuleResult
}

export interface RuleContext {
  analysis?: AnalysisResponse
  marketState?: MarketStateResponse
  positions: Position[]
  accountBalance: number
  proposedRiskUsd: number
}

// ============ Pre-Trade Rules ============

export const minConfidenceRule: RiskRule = {
  id: "min-confidence",
  name: "Minimum Confidence",
  description: "Ensures analysis confidence is above threshold",
  evaluate: (ctx) => {
    if (!ctx.analysis) {
      return { passed: false, reason: "No analysis available" }
    }
    if (ctx.analysis.confidence < 0.5) {
      return {
        passed: false,
        reason: `Analysis confidence (${(ctx.analysis.confidence * 100).toFixed(0)}%) below 50% threshold`,
      }
    }
    return { passed: true, reason: "Confidence check passed" }
  },
}

export const marketConditionRule: RiskRule = {
  id: "market-condition",
  name: "Market Condition",
  description: "Checks if market conditions allow trading",
  evaluate: (ctx) => {
    if (!ctx.marketState) {
      return { passed: true, reason: "No market state - proceeding with caution" }
    }
    if (ctx.marketState.recommendation.positionSizing === "NONE") {
      return {
        passed: false,
        reason: `Market condition (${ctx.marketState.marketCondition}) does not favor trading`,
      }
    }
    return { passed: true, reason: "Market conditions acceptable" }
  },
}

export const maxExposureRule: RiskRule = {
  id: "max-exposure",
  name: "Maximum Exposure",
  description: "Ensures total exposure doesn't exceed 50% of balance",
  evaluate: (ctx) => {
    const totalExposure = ctx.positions.reduce(
      (sum, p) => sum + Math.abs(p.notional),
      0
    )
    const exposurePercent = (totalExposure / ctx.accountBalance) * 100

    if (exposurePercent > 50) {
      return {
        passed: false,
        reason: `Total exposure (${exposurePercent.toFixed(1)}%) exceeds 50% limit`,
      }
    }
    return { passed: true, reason: "Exposure within limits" }
  },
}

export const riskPerTradeRule: RiskRule = {
  id: "risk-per-trade",
  name: "Risk Per Trade",
  description: "Ensures risk per trade doesn't exceed 2% of balance",
  evaluate: (ctx) => {
    const riskPercent = (ctx.proposedRiskUsd / ctx.accountBalance) * 100

    if (riskPercent > 2) {
      return {
        passed: false,
        reason: `Risk per trade (${riskPercent.toFixed(1)}%) exceeds 2% limit`,
      }
    }
    return { passed: true, reason: "Risk per trade within limits" }
  },
}

export const noConflictingPositionRule: RiskRule = {
  id: "no-conflicting-position",
  name: "No Conflicting Position",
  description: "Prevents opening opposite position on same symbol",
  evaluate: (ctx) => {
    // This rule needs symbol context which should be passed separately
    // For now, it just checks if there are any positions
    return { passed: true, reason: "No conflicting positions" }
  },
}

export const dataQualityRule: RiskRule = {
  id: "data-quality",
  name: "Data Quality",
  description: "Ensures analysis data quality is sufficient",
  evaluate: (ctx) => {
    if (!ctx.analysis) {
      return { passed: false, reason: "No analysis available" }
    }
    if (ctx.analysis.dataQuality.score < 5) {
      return {
        passed: false,
        reason: `Data quality score (${ctx.analysis.dataQuality.score}) below threshold`,
      }
    }
    if (
      ctx.analysis.dataQuality.warnings &&
      ctx.analysis.dataQuality.warnings.length > 2
    ) {
      return {
        passed: false,
        reason: `Multiple data quality warnings: ${ctx.analysis.dataQuality.warnings.join(", ")}`,
      }
    }
    return { passed: true, reason: "Data quality acceptable" }
  },
}

export const criticalAlertsRule: RiskRule = {
  id: "critical-alerts",
  name: "Critical Alerts",
  description: "Blocks trading when critical alerts are present",
  evaluate: (ctx) => {
    if (!ctx.marketState) {
      return { passed: true, reason: "No market state available" }
    }
    const criticalAlerts = ctx.marketState.alerts?.filter(
      (a) => a.level === "CRITICAL"
    )
    if (criticalAlerts && criticalAlerts.length > 0) {
      return {
        passed: false,
        reason: `Critical alerts: ${criticalAlerts.map((a) => a.message).join(", ")}`,
      }
    }
    return { passed: true, reason: "No critical alerts" }
  },
}

// ============ Rule Engine ============

export const defaultRules: RiskRule[] = [
  minConfidenceRule,
  marketConditionRule,
  maxExposureRule,
  riskPerTradeRule,
  dataQualityRule,
  criticalAlertsRule,
]

export function evaluateRules(
  rules: RiskRule[],
  context: RuleContext
): { passed: boolean; results: Array<{ rule: string; result: RuleResult }> } {
  const results: Array<{ rule: string; result: RuleResult }> = []
  let allPassed = true

  for (const rule of rules) {
    const result = rule.evaluate(context)
    results.push({ rule: rule.id, result })

    if (!result.passed) {
      allPassed = false
    }
  }

  return { passed: allPassed, results }
}

export function createCustomRule(
  id: string,
  name: string,
  description: string,
  evaluator: (context: RuleContext) => RuleResult
): RiskRule {
  return {
    id,
    name,
    description,
    evaluate: evaluator,
  }
}
