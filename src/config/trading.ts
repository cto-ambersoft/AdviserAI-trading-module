import { type RiskConfig } from "../types/trading";

export interface TradingConfig {
  // Binance API
  binance: {
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
    /**
     * Binance signed endpoints require timestamp within recvWindow.
     * Max allowed by Binance is 60000.
     */
    recvWindowMs: number;
    /**
     * If enabled, the service periodically syncs local time with Binance server time
     * and sends corrected timestamps in signed requests.
     */
    timeSyncEnabled: boolean;
  };

  // Core Analytics API
  core: {
    apiUrl: string;
    apiKey: string;
  };

  // Risk Management
  risk: RiskConfig;

  // Scheduler
  scheduler: {
    preUsMarketCron: string;
    preAsiaMarketCron: string;
    enabled: boolean;
  };

  // Trading
  trading: {
    defaultSymbols: string[];
    defaultFeePercent: number;
    /**
     * Soft confidence threshold.
     * Below this we still may trade, but the execution workflow will scale down risk.
     */
    minConfidenceToTrade: number;
    /**
     * Hard confidence floor.
     * Below this we will reject the trade regardless of other signals.
     */
    hardRejectConfidence: number;
  };
}

function getEnvString(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value ?? defaultValue ?? "";
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable: ${key}`);
  }
  return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

export function loadTradingConfig(): TradingConfig {
  return {
    binance: {
      apiKey: getEnvString("BINANCE_API_KEY", ""),
      apiSecret: getEnvString("BINANCE_API_SECRET", ""),
      testnet: getEnvBoolean("BINANCE_TESTNET", true),
      recvWindowMs: getEnvNumber("BINANCE_RECV_WINDOW_MS", 60000),
      timeSyncEnabled: getEnvBoolean("BINANCE_TIME_SYNC_ENABLED", true),
    },
    core: {
      apiUrl: getEnvString("CORE_API_URL", "http://localhost:3000"),
      apiKey: getEnvString("CORE_API_KEY", ""),
    },
    risk: {
      maxPositionSizePercent: getEnvNumber("MAX_POSITION_SIZE_PERCENT", 2),
      maxDailyLossPercent: getEnvNumber("MAX_DAILY_LOSS_PERCENT", 5),
      maxOpenPositions: getEnvNumber("MAX_OPEN_POSITIONS", 3),
      minRiskReward: getEnvNumber("MIN_RISK_REWARD", 2),
      maxLeveragePerPosition: getEnvNumber("MAX_LEVERAGE_PER_POSITION", 10),
      defaultRiskPerTradeUsd: getEnvNumber("DEFAULT_RISK_PER_TRADE_USD", 100),
    },
    scheduler: {
      // 13:30 UTC - 30 min before US market open
      preUsMarketCron: getEnvString("PRE_US_MARKET_CRON", "30 13 * * 1-5"),
      // 00:00 UTC - Asia market open
      preAsiaMarketCron: getEnvString("PRE_ASIA_MARKET_CRON", "0 0 * * *"),
      enabled: getEnvBoolean("SCHEDULER_ENABLED", false),
    },
    trading: {
      defaultSymbols: getEnvString("DEFAULT_SYMBOLS", "BTCUSDT,ETHUSDT").split(
        ","
      ),
      defaultFeePercent: getEnvNumber("DEFAULT_FEE_PERCENT", 0.07),
      minConfidenceToTrade: getEnvNumber("MIN_CONFIDENCE_TO_TRADE", 0.45),
      hardRejectConfidence: getEnvNumber("HARD_REJECT_CONFIDENCE", 0.4),
    },
  };
}

// Singleton config instance
let configInstance: TradingConfig | null = null;

export function getTradingConfig(): TradingConfig {
  if (!configInstance) {
    configInstance = loadTradingConfig();
  }
  return configInstance;
}
