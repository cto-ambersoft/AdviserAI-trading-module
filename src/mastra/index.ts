import { Mastra } from "@mastra/core/mastra"
import { PinoLogger } from "@mastra/loggers"
import { LibSQLStore } from "@mastra/libsql"
import { Observability } from "@mastra/observability"

// Agents
import { tradingAgent } from "./agents/trading-agent"
import { riskAgent } from "./agents/risk-agent"

// Workflows
import { tradeExecutionWorkflow } from "./workflows/trade-execution-workflow"
import { positionManagementWorkflow } from "./workflows/position-management-workflow"
import { analysisWorkflow } from "./workflows/analysis-workflow"

export const mastra = new Mastra({
  workflows: {
    tradeExecutionWorkflow,
    positionManagementWorkflow,
    analysisWorkflow,
  },
  agents: {
    tradingAgent,
    riskAgent,
  },
  storage: new LibSQLStore({
    id: "mastra-trading-storage",
    url: process.env.LIBSQL_URL ?? "file:./trading.db",
  }),
  logger: new PinoLogger({
    name: "MastraTrading",
    level: "info",
  }),
  observability: new Observability({
    default: { enabled: true },
  }),
})

// Export agents and workflows for direct use
export { tradingAgent, riskAgent }
export { tradeExecutionWorkflow, positionManagementWorkflow, analysisWorkflow }
