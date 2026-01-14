import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const tradeParamsSchema = z.object({
  riskUsd: z.number().positive().describe("Risk amount in USD"),
  entryPrice: z.number().positive().describe("Entry price"),
  stopLoss: z.number().positive().describe("Stop-loss price"),
  feePercent: z.number().min(0).describe("Fee percent (e.g. 0.04 for 0.04%)"),
  rrRatio: z
    .number()
    .positive()
    .optional()
    .describe("Risk:Reward ratio (default 3.0)"),
});

const tradeResultSchema = z.object({
  meta: z.object({
    direction: z.enum(["LONG", "SHORT"]),
    inputRR: z.number(),
  }),
  position: z.object({
    sizeCoins: z.number().describe("Position size in coins"),
    sizeUsdt: z.number().describe("Nominal position size in USDT"),
  }),
  scenarios: z.object({
    stopLoss: z.object({
      price: z.number(),
      entryFee: z.number(),
      exitFee: z.number(),
      totalFees: z.number(),
      priceLoss: z.number().describe("Loss from price move only"),
      totalLoss: z.number().describe("Loss from price move + fees"),
    }),
    takeProfit: z.object({
      price: z.number(),
      entryFee: z.number().describe("Entry fee"),
      exitFee: z.number().describe("Exit fee at take-profit"),
      grossProfit: z.number().describe("Profit from price move only"),
      netProfit: z.number().describe("Profit after fees"),
      realRR: z.number().describe("Net R:R after fees"),
    }),
  }),
});

export type TradeParams = z.infer<typeof tradeParamsSchema>;
export type TradeResult = z.infer<typeof tradeResultSchema>;

export const positionCalculatorTool = createTool({
  id: "calculate-position",
  description:
    "Calculate position size and PnL scenarios (stop-loss & take-profit) based on risk, entry, stop, fees, and RR",
  inputSchema: tradeParamsSchema,
  outputSchema: tradeResultSchema,
  execute: async (inputData) => {
    return calculatePosition(inputData);
  },
});

export const calculatePosition = (params: TradeParams): TradeResult => {
  const { riskUsd, entryPrice, stopLoss, feePercent } = params;
  const rrRatio = params.rrRatio ?? 3.0;

  if (entryPrice === stopLoss) {
    throw new Error("Entry price cannot be equal to stop-loss price.");
  }

  const feeRate = feePercent / 100;
  const priceDelta = Math.abs(entryPrice - stopLoss);

  // Risk = (Delta * Size) + (EntryPrice * Size * Fee) + (StopPrice * Size * Fee)
  const denominator = priceDelta + feeRate * (entryPrice + stopLoss);
  if (denominator <= 0) {
    throw new Error("Invalid parameters: denominator must be > 0.");
  }

  const positionSizeCoins = riskUsd / denominator;
  const positionSizeUsdt = positionSizeCoins * entryPrice;

  const direction = entryPrice < stopLoss ? "SHORT" : "LONG";

  const entryFee = positionSizeCoins * entryPrice * feeRate;
  const stopFee = positionSizeCoins * stopLoss * feeRate;

  const profitDistance = priceDelta * rrRatio;
  const tpPrice =
    direction === "LONG"
      ? entryPrice + profitDistance
      : entryPrice - profitDistance;

  const tpFee = positionSizeCoins * tpPrice * feeRate;
  const grossProfit = profitDistance * positionSizeCoins;
  const totalFeeInProfit = entryFee + tpFee;
  const netProfit = grossProfit - totalFeeInProfit;
  const realRR = netProfit / riskUsd;

  return {
    meta: { direction, inputRR: rrRatio },
    position: { sizeCoins: positionSizeCoins, sizeUsdt: positionSizeUsdt },
    scenarios: {
      stopLoss: {
        price: stopLoss,
        entryFee,
        exitFee: stopFee,
        totalFees: entryFee + stopFee,
        priceLoss: priceDelta * positionSizeCoins,
        totalLoss: priceDelta * positionSizeCoins + (entryFee + stopFee),
      },
      takeProfit: {
        price: tpPrice,
        entryFee,
        exitFee: tpFee,
        grossProfit,
        netProfit,
        realRR,
      },
    },
  };
};
