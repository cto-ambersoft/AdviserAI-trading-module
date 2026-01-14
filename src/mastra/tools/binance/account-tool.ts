import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { getBinanceService } from "../../../services/binance/client"

const accountBalanceOutputSchema = z.object({
  balances: z.array(
    z.object({
      asset: z.string(),
      balance: z.number(),
      availableBalance: z.number(),
      crossWalletBalance: z.number(),
      crossUnPnl: z.number(),
    })
  ),
  usdtBalance: z
    .object({
      balance: z.number(),
      availableBalance: z.number(),
    })
    .nullable(),
})

export const binanceAccountTool = createTool({
  id: "binance-account",
  description:
    "Get Binance Futures account information including balances. Returns USDT balance and all non-zero asset balances.",
  inputSchema: z.object({}),
  outputSchema: accountBalanceOutputSchema,
  execute: async () => {
    const binance = getBinanceService()

    const balances = await binance.getAccountBalance()
    const usdtBalance = await binance.getUsdtBalance()

    return {
      balances,
      usdtBalance: usdtBalance
        ? {
            balance: usdtBalance.balance,
            availableBalance: usdtBalance.availableBalance,
          }
        : null,
    }
  },
})

const accountInfoOutputSchema = z.object({
  canTrade: z.boolean(),
  totalWalletBalance: z.number(),
  totalUnrealizedProfit: z.number(),
  totalMarginBalance: z.number(),
  availableBalance: z.number(),
  openPositionsCount: z.number(),
})

export const binanceAccountInfoTool = createTool({
  id: "binance-account-info",
  description:
    "Get detailed Binance Futures account information including margin, PnL, and trading status.",
  inputSchema: z.object({}),
  outputSchema: accountInfoOutputSchema,
  execute: async () => {
    const binance = getBinanceService()

    const accountInfo = await binance.getAccountInfo()
    const positions = await binance.getPositions()

    return {
      canTrade: accountInfo.canTrade,
      totalWalletBalance: parseFloat(accountInfo.totalWalletBalance),
      totalUnrealizedProfit: parseFloat(accountInfo.totalUnrealizedProfit),
      totalMarginBalance: parseFloat(accountInfo.totalMarginBalance),
      availableBalance: parseFloat(accountInfo.availableBalance),
      openPositionsCount: positions.length,
    }
  },
})
