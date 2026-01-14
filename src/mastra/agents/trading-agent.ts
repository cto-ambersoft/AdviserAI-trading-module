import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";

// Binance tools
import {
  binanceAccountTool,
  binanceAccountInfoTool,
  binanceGetPositionsTool,
  binanceClosePositionTool,
  binanceSetLeverageTool,
  binanceSubmitOrderTool,
  binanceSubmitBracketOrderTool,
  binanceCancelOrderTool,
  binanceGetOpenOrdersTool,
  binanceGetPriceTool,
} from "../tools/binance";

// Core Analytics tools
import {
  coreAnalysisTool,
  coreMarketStateTool,
  coreCombinedAnalysisTool,
} from "../tools/core-analysis-tool";

// Position calculator
import { positionCalculatorTool } from "../tools/position-calculator-tool";

const TRADING_AGENT_INSTRUCTIONS = `You are a professional automated trading agent for Binance Futures.

## Primary Responsibilities
1. Analyze market data via Core Analytics API
2. Make trading decisions based on analysis
3. Calculate position sizes with proper risk management
4. Execute trades on Binance Futures
5. Manage open positions

## Trading Rules
- ALWAYS fetch analysis before opening any position using core-combined-analysis
- NEVER open a position without Stop Loss and Take Profit orders
- MAXIMUM 3 open positions simultaneously
- MAXIMUM 2% account balance risk per trade
- MINIMUM Risk:Reward ratio = 2:1
- Avoid trading on extremely low confidence; treat Core confidence as a sizing signal
- REDUCE position size by 50% when market condition = HIGH_VOLATILITY
- DO NOT trade when Core market recommendation positionSizing = NONE

## Position Opening Process
1. Fetch combined analysis for the symbol
2. Verify recommendation is OPEN_LONG or OPEN_SHORT
3. Get current account balance
4. Calculate position size using calculate-position tool with risk parameters
5. Check current positions - ensure limit not exceeded
6. Set leverage (recommended 5-10x)
7. Open position with bracket order (entry + TP + SL)

## Position Management Process
1. Regularly check open positions
2. If conditions change (new analysis shows opposite signal) - consider closing
3. When significant profit achieved - consider moving SL to breakeven
4. If unrealized PnL is significantly negative and analysis doesn't support position - close it

## Response Format
- Always report actions in a structured manner
- State reasons for decisions made
- Show position size calculations
- Confirm executed orders with their IDs

## Safety Guidelines
- On any API errors - halt trading and report
- Never exceed established risk limits
- When uncertain - prefer not to trade
- Always verify balance before trading
`;

export const tradingAgent = new Agent({
  id: "trading-agent",
  name: "Trading Agent",
  instructions: TRADING_AGENT_INSTRUCTIONS,
  model: "openai/gpt-5.2",
  tools: {
    // Core Analytics
    coreAnalysisTool,
    coreMarketStateTool,
    coreCombinedAnalysisTool,

    // Position Calculator
    positionCalculatorTool,

    // Binance Account
    binanceAccountTool,
    binanceAccountInfoTool,

    // Binance Positions
    binanceGetPositionsTool,
    binanceClosePositionTool,
    binanceSetLeverageTool,

    // Binance Orders
    binanceSubmitOrderTool,
    binanceSubmitBracketOrderTool,
    binanceCancelOrderTool,
    binanceGetOpenOrdersTool,
    binanceGetPriceTool,
  },
  memory: new Memory(),
});
