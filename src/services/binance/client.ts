import {
  DerivativesTradingUsdsFutures,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
} from "@binance/derivatives-trading-usds-futures";
import { createHmac } from "crypto";
import { getTradingConfig } from "../../config/trading";
import {
  type Position,
  type AccountBalance,
  type Order,
  type NewOrderParams,
  type BracketOrderParams,
  type BracketOrderResult,
} from "../../types/trading";
import {
  type BinancePosition,
  type BinanceBalance,
  type BinanceOrder,
  type BinanceOrderResponse,
  type BinanceAccountInfo,
  type BinanceTickerPrice,
  type BinanceExchangeInfo,
} from "./types";

export class BinanceService {
  private client: DerivativesTradingUsdsFutures;
  private config = getTradingConfig();
  private exchangeInfoCache: {
    fetchedAt: number;
    info: BinanceExchangeInfo;
  } | null = null;
  private exchangeInfoTtlMs = 5 * 60 * 1000;
  private timeOffsetMs = 0;
  private lastTimeSyncAt = 0;
  private timeSyncTtlMs = 60 * 1000;

  constructor() {
    const baseUrl = this.config.binance.testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
      : undefined;

    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        apiKey: this.config.binance.apiKey,
        apiSecret: this.config.binance.apiSecret,
        basePath: baseUrl,
      },
    });
  }

  private getFuturesBaseUrl(): string {
    return this.config.binance.testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
      : "https://fapi.binance.com";
  }

  private async ensureTimeSync(force?: boolean): Promise<void> {
    if (!this.config.binance.timeSyncEnabled) return;
    const now = Date.now();
    if (!force && now - this.lastTimeSyncAt < this.timeSyncTtlMs) return;

    try {
      const baseUrl = this.getFuturesBaseUrl();
      const res = await fetch(`${baseUrl}/fapi/v1/time`);
      if (!res.ok) return;
      const data = (await res.json()) as { serverTime?: number };
      if (typeof data.serverTime !== "number") return;
      this.timeOffsetMs = data.serverTime - now;
      this.lastTimeSyncAt = now;
    } catch {
      // Keep existing offset on failures
    }
  }

  private async signedParams<T extends Record<string, unknown>>(
    params: T
  ): Promise<T & { recvWindow: number; timestamp: number }> {
    await this.ensureTimeSync();
    const now = Date.now();
    const recvWindow = Math.min(
      Math.max(this.config.binance.recvWindowMs, 0),
      60000
    );
    return {
      ...params,
      recvWindow,
      timestamp: now + this.timeOffsetMs,
    };
  }

  /**
   * Create HMAC SHA256 signature for Binance API
   */
  private signQuery(queryString: string): string {
    return createHmac("sha256", this.config.binance.apiSecret)
      .update(queryString)
      .digest("hex");
  }

  /**
   * Direct HTTP POST to Binance API for orders.
   * Workaround for SDK bug where stopPrice is not passed in newOrder.
   */
  private async submitOrderDirect(
    params: Record<string, string | number | undefined>
  ): Promise<BinanceOrderResponse> {
    const baseUrl = this.getFuturesBaseUrl();
    await this.ensureTimeSync();

    const now = Date.now();
    const recvWindow = Math.min(
      Math.max(this.config.binance.recvWindowMs, 0),
      60000
    );

    // Build query params, filtering out undefined values
    const queryParams: Record<string, string> = {
      timestamp: String(now + this.timeOffsetMs),
      recvWindow: String(recvWindow),
    };

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        queryParams[key] = String(value);
      }
    }

    // Create query string and sign it
    const queryString = new URLSearchParams(queryParams).toString();
    const signature = this.signQuery(queryString);
    const signedQueryString = `${queryString}&signature=${signature}`;

    const response = await fetch(
      `${baseUrl}/fapi/v1/order?${signedQueryString}`,
      {
        method: "POST",
        headers: {
          "X-MBX-APIKEY": this.config.binance.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        msg?: string;
        code?: number;
      };
      throw new Error(errorData.msg || `HTTP ${response.status}`);
    }

    return (await response.json()) as BinanceOrderResponse;
  }

  private isTimestampError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    return (
      message.includes("outside of the recvWindow") ||
      message.includes("Timestamp for this request")
    );
  }

  private async withTimeSyncRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!this.isTimestampError(err)) throw err;
      await this.ensureTimeSync(true);
      return await fn();
    }
  }

  /**
   * Submit order with retry logic and exponential backoff.
   * Retries on timestamp errors with forced time sync.
   */
  private async submitOrderWithRetry(
    params: NewOrderParams,
    maxRetries = 3
  ): Promise<{ response: BinanceOrderResponse | null; error: string | null }> {
    let lastError: string | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Force time sync before retry attempts
        if (attempt > 0) {
          await this.ensureTimeSync(true);
          // Exponential backoff: 100ms, 200ms, 400ms
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(2, attempt))
          );
        }

        const response = await this.submitOrder(params);
        return { response, error: null };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(
          `[BinanceService] Order attempt ${attempt + 1}/${maxRetries} failed for ${params.type}:`,
          lastError
        );

        // Only retry on timestamp-related errors
        if (!this.isTimestampError(err) && attempt === 0) {
          // For non-timestamp errors, don't retry
          return { response: null, error: lastError };
        }
      }
    }

    return { response: null, error: lastError };
  }

  // ============ Credentials Check ============

  hasValidCredentials(): boolean {
    return !!(this.config.binance.apiKey && this.config.binance.apiSecret);
  }

  // ============ Account Methods ============

  async getAccountInfo(): Promise<BinanceAccountInfo> {
    return this.withTimeSyncRetry(async () => {
      const response = await this.client.restAPI.accountInformationV3(
        (await this.signedParams({})) as Parameters<
          typeof this.client.restAPI.accountInformationV3
        >[0]
      );
      return (await response.data()) as BinanceAccountInfo;
    });
  }

  async getAccountBalance(): Promise<AccountBalance[]> {
    const balances = await this.withTimeSyncRetry(async () => {
      const response = await this.client.restAPI.futuresAccountBalanceV3(
        (await this.signedParams({})) as Parameters<
          typeof this.client.restAPI.futuresAccountBalanceV3
        >[0]
      );
      return (await response.data()) as BinanceBalance[];
    });

    return balances
      .filter((b) => parseFloat(b.balance) > 0)
      .map((b) => ({
        asset: b.asset,
        balance: parseFloat(b.balance),
        availableBalance: parseFloat(b.availableBalance),
        crossWalletBalance: parseFloat(b.crossWalletBalance),
        crossUnPnl: parseFloat(b.crossUnPnl),
      }));
  }

  async getUsdtBalance(): Promise<AccountBalance | null> {
    const balances = await this.getAccountBalance();
    return balances.find((b) => b.asset === "USDT") ?? null;
  }

  // ============ Position Methods ============

  async getPositions(symbol?: string): Promise<Position[]> {
    const positions = await this.withTimeSyncRetry(async () => {
      const response = await this.client.restAPI.positionInformationV3(
        (await this.signedParams({ symbol })) as Parameters<
          typeof this.client.restAPI.positionInformationV3
        >[0]
      );
      return (await response.data()) as BinancePosition[];
    });

    return positions
      .filter((p) => parseFloat(p.positionAmt) !== 0)
      .map((p) => this.mapPosition(p));
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const positions = await this.getPositions(symbol);
    return positions[0] ?? null;
  }

  async hasOpenPosition(symbol: string): Promise<boolean> {
    const position = await this.getPosition(symbol);
    return position !== null && position.positionAmt !== 0;
  }

  // ============ Order Methods ============

  async submitOrder(params: NewOrderParams): Promise<BinanceOrderResponse> {
    const normalizedParams = await this.normalizeOrderParams(params);
    const reduceOnly =
      normalizedParams.reduceOnly === undefined
        ? undefined
        : normalizedParams.reduceOnly
          ? "true"
          : "false";
    const closePosition =
      normalizedParams.closePosition === undefined
        ? undefined
        : normalizedParams.closePosition
          ? "true"
          : "false";

    // Use direct HTTP call when stopPrice is present (SDK bug workaround)
    // The Binance SDK's newOrder method doesn't pass stopPrice parameter
    if (normalizedParams.stopPrice !== undefined) {
      return this.withTimeSyncRetry(async () => {
        return this.submitOrderDirect({
          symbol: normalizedParams.symbol,
          side: normalizedParams.side,
          type: normalizedParams.type,
          positionSide: normalizedParams.positionSide,
          quantity: normalizedParams.quantity,
          price: normalizedParams.price,
          stopPrice: normalizedParams.stopPrice,
          timeInForce: normalizedParams.timeInForce,
          reduceOnly,
          closePosition,
        });
      });
    }

    // Use SDK for orders without stopPrice
    const signed = await this.signedParams({});
    const orderParams = {
      symbol: normalizedParams.symbol,
      side: normalizedParams.side as "BUY" | "SELL",
      type: normalizedParams.type as string,
      positionSide: normalizedParams.positionSide as
        | "BOTH"
        | "LONG"
        | "SHORT"
        | undefined,
      quantity: normalizedParams.quantity,
      price: normalizedParams.price,
      timeInForce: normalizedParams.timeInForce as
        | "GTC"
        | "IOC"
        | "FOK"
        | "GTX"
        | "GTD"
        | undefined,
      reduceOnly,
      closePosition,
      recvWindow: signed.recvWindow,
      timestamp: signed.timestamp,
    };

    return this.withTimeSyncRetry(async () => {
      const response = await this.client.restAPI.newOrder(
        orderParams as Parameters<typeof this.client.restAPI.newOrder>[0]
      );
      return (await response.data()) as BinanceOrderResponse;
    });
  }

  async submitMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    positionSide?: "BOTH" | "LONG" | "SHORT"
  ): Promise<BinanceOrderResponse> {
    return this.submitOrder({
      symbol,
      side,
      type: "MARKET",
      quantity,
      positionSide: positionSide ?? "BOTH",
    });
  }

  async submitLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    price: number,
    positionSide?: "BOTH" | "LONG" | "SHORT"
  ): Promise<BinanceOrderResponse> {
    return this.submitOrder({
      symbol,
      side,
      type: "LIMIT",
      quantity,
      price,
      timeInForce: "GTC",
      positionSide: positionSide ?? "BOTH",
    });
  }

  /**
   * Submit a bracket order (entry + take profit + stop loss).
   * Handles partial failures - if entry succeeds but TP/SL fail,
   * returns partial success with error details instead of throwing.
   */
  async submitBracketOrder(
    params: BracketOrderParams
  ): Promise<BracketOrderResult> {
    const positionSide = params.positionSide ?? "BOTH";
    const closeSide = params.side === "BUY" ? "SELL" : "BUY";

    // Entry order - this must succeed, throw if it fails
    let entryOrder: BinanceOrderResponse;
    try {
      if (params.entryType === "LIMIT" && params.entryPrice) {
        entryOrder = await this.submitLimitOrder(
          params.symbol,
          params.side,
          params.quantity,
          params.entryPrice,
          positionSide
        );
      } else {
        entryOrder = await this.submitMarketOrder(
          params.symbol,
          params.side,
          params.quantity,
          positionSide
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[BinanceService] Entry order failed for ${params.symbol}:`,
        errorMsg
      );
      throw new Error(`Entry order failed: ${errorMsg}`);
    }

    console.log(
      `[BinanceService] Entry order placed: ${entryOrder.orderId}, status: ${entryOrder.status}, qty: ${entryOrder.executedQty}`
    );

    // Use executed quantity from entry order for TP/SL to avoid quantity mismatch
    const executedQty = parseFloat(entryOrder.executedQty);
    const orderQuantity = executedQty > 0 ? executedQty : params.quantity;

    // Take Profit order - use retry logic
    const tpResult = await this.submitOrderWithRetry({
      symbol: params.symbol,
      side: closeSide,
      type: "TAKE_PROFIT_MARKET",
      quantity: orderQuantity,
      reduceOnly: true,
      stopPrice: params.takeProfitPrice,
      positionSide,
    });

    if (tpResult.error) {
      console.error(
        `[BinanceService] Take Profit order failed for ${params.symbol}:`,
        tpResult.error,
        `(stopPrice: ${params.takeProfitPrice})`
      );
    } else {
      console.log(
        `[BinanceService] Take Profit order placed: ${tpResult.response?.orderId}, status: ${tpResult.response?.status}`
      );
    }

    // Stop Loss order - use retry logic, always attempt even if TP failed
    const slResult = await this.submitOrderWithRetry({
      symbol: params.symbol,
      side: closeSide,
      type: "STOP_MARKET",
      quantity: orderQuantity,
      reduceOnly: true,
      stopPrice: params.stopLossPrice,
      positionSide,
    });

    if (slResult.error) {
      console.error(
        `[BinanceService] Stop Loss order failed for ${params.symbol}:`,
        slResult.error,
        `(stopPrice: ${params.stopLossPrice})`
      );
    } else {
      console.log(
        `[BinanceService] Stop Loss order placed: ${slResult.response?.orderId}, status: ${slResult.response?.status}`
      );
    }

    const hasPartialFailure = !!(tpResult.error || slResult.error);

    return {
      entry: {
        orderId: entryOrder.orderId,
        status: entryOrder.status,
        executedQty: parseFloat(entryOrder.executedQty),
        avgPrice: parseFloat(entryOrder.avgPrice),
      },
      tp: tpResult.response
        ? {
            orderId: tpResult.response.orderId,
            status: tpResult.response.status,
          }
        : null,
      sl: slResult.response
        ? {
            orderId: slResult.response.orderId,
            status: slResult.response.status,
          }
        : null,
      tpError: tpResult.error ?? undefined,
      slError: slResult.error ?? undefined,
      partialSuccess: hasPartialFailure,
    };
  }

  async cancelOrder(
    symbol: string,
    orderId: number
  ): Promise<BinanceOrderResponse> {
    return this.withTimeSyncRetry(async () => {
      const response = await this.client.restAPI.cancelOrder(
        (await this.signedParams({ symbol, orderId })) as Parameters<
          typeof this.client.restAPI.cancelOrder
        >[0]
      );
      return (await response.data()) as BinanceOrderResponse;
    });
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    await this.withTimeSyncRetry(async () => {
      await this.client.restAPI.cancelAllOpenOrders(
        (await this.signedParams({ symbol })) as Parameters<
          typeof this.client.restAPI.cancelAllOpenOrders
        >[0]
      );
    });
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const orders = await this.withTimeSyncRetry(async () => {
      const response = await this.client.restAPI.currentAllOpenOrders(
        (await this.signedParams({ symbol })) as Parameters<
          typeof this.client.restAPI.currentAllOpenOrders
        >[0]
      );
      return (await response.data()) as BinanceOrder[];
    });
    return orders.map((o) => this.mapOrder(o));
  }

  async getOrder(symbol: string, orderId: number): Promise<Order | null> {
    try {
      const order = await this.withTimeSyncRetry(async () => {
        const response = await this.client.restAPI.queryOrder(
          (await this.signedParams({ symbol, orderId })) as Parameters<
            typeof this.client.restAPI.queryOrder
          >[0]
        );
        return (await response.data()) as BinanceOrder;
      });
      return this.mapOrder(order);
    } catch {
      return null;
    }
  }

  // ============ Market Data Methods ============

  async getPrice(symbol: string): Promise<number> {
    const response = await this.client.restAPI.symbolPriceTicker({ symbol });
    const ticker = (await response.data()) as BinanceTickerPrice;
    return parseFloat(ticker.price);
  }

  async getPrices(symbols?: string[]): Promise<Map<string, number>> {
    const response = await this.client.restAPI.symbolPriceTicker({});
    const tickers = (await response.data()) as BinanceTickerPrice[];
    const priceMap = new Map<string, number>();

    for (const ticker of tickers) {
      if (!symbols || symbols.includes(ticker.symbol)) {
        priceMap.set(ticker.symbol, parseFloat(ticker.price));
      }
    }

    return priceMap;
  }

  async getExchangeInfo(): Promise<BinanceExchangeInfo> {
    const now = Date.now();
    const cached = this.exchangeInfoCache;
    if (cached && now - cached.fetchedAt < this.exchangeInfoTtlMs) {
      return cached.info;
    }

    const response = await this.client.restAPI.exchangeInformation();
    const info = (await response.data()) as BinanceExchangeInfo;
    this.exchangeInfoCache = { fetchedAt: now, info };
    return info;
  }

  async getSymbolInfo(
    symbol: string
  ): Promise<BinanceExchangeInfo["symbols"][0] | null> {
    const info = await this.getExchangeInfo();
    return info.symbols.find((s) => s.symbol === symbol) ?? null;
  }

  // ============ Leverage & Margin Methods ============

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.withTimeSyncRetry(async () => {
      await this.client.restAPI.changeInitialLeverage(
        (await this.signedParams({ symbol, leverage })) as Parameters<
          typeof this.client.restAPI.changeInitialLeverage
        >[0]
      );
    });
  }

  async setMarginType(
    symbol: string,
    marginType: "ISOLATED" | "CROSSED"
  ): Promise<void> {
    try {
      await this.withTimeSyncRetry(async () => {
        await this.client.restAPI.changeMarginType(
          (await this.signedParams({
            symbol,
            marginType,
          })) as Parameters<typeof this.client.restAPI.changeMarginType>[0]
        );
      });
    } catch (error) {
      // Margin type might already be set, ignore error
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("No need to change margin type")) {
        throw error;
      }
    }
  }

  // ============ Close Position Methods ============

  async closePosition(symbol: string): Promise<BinanceOrderResponse | null> {
    const position = await this.getPosition(symbol);
    if (!position || position.positionAmt === 0) {
      return null;
    }

    const side = position.positionAmt > 0 ? "SELL" : "BUY";
    const quantity = Math.abs(position.positionAmt);

    return this.submitMarketOrder(
      symbol,
      side,
      quantity,
      position.positionSide
    );
  }

  async closeAllPositions(): Promise<BinanceOrderResponse[]> {
    const positions = await this.getPositions();
    const results: BinanceOrderResponse[] = [];

    for (const position of positions) {
      const result = await this.closePosition(position.symbol);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  // ============ Helper Methods ============

  private parseFilterNumber(
    filter: BinanceExchangeInfo["symbols"][0]["filters"][0] | undefined,
    key: string
  ): number | null {
    if (!filter) return null;
    const value = filter[key];
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  private floorToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
      return value;
    const scaled = Math.floor(value / step) * step;
    return Object.is(scaled, -0) ? 0 : scaled;
  }

  private roundToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
      return value;
    const scaled = Math.round(value / step) * step;
    return Object.is(scaled, -0) ? 0 : scaled;
  }

  private floorToPrecision(value: number, precision: number): number {
    if (!Number.isFinite(value)) return value;
    const p = Math.max(0, Math.min(18, Math.floor(precision)));
    const factor = 10 ** p;
    return Math.floor(value * factor) / factor;
  }

  private async normalizeOrderParams(
    params: NewOrderParams
  ): Promise<NewOrderParams> {
    let symbolInfo: BinanceExchangeInfo["symbols"][0] | null = null;
    try {
      symbolInfo = await this.getSymbolInfo(params.symbol);
    } catch {
      symbolInfo = null;
    }

    if (!symbolInfo) return params;

    const lotFilter =
      symbolInfo.filters.find((f) => f.filterType === "LOT_SIZE") ??
      symbolInfo.filters.find((f) => f.filterType === "MARKET_LOT_SIZE");

    const priceFilter = symbolInfo.filters.find(
      (f) => f.filterType === "PRICE_FILTER"
    );

    const stepSize = this.parseFilterNumber(lotFilter, "stepSize");
    const minQty = this.parseFilterNumber(lotFilter, "minQty");
    const tickSize = this.parseFilterNumber(priceFilter, "tickSize");

    const qtyPrecision = symbolInfo.quantityPrecision;
    const pricePrecision = symbolInfo.pricePrecision;

    let quantity = params.quantity;
    if (typeof quantity === "number") {
      const stepped = stepSize
        ? this.floorToStep(quantity, stepSize)
        : quantity;
      const floored = this.floorToPrecision(stepped, qtyPrecision);
      const normalized = Number(floored.toFixed(Math.max(0, qtyPrecision)));

      if (minQty && normalized > 0 && normalized < minQty) {
        throw new Error(
          `Calculated quantity ${normalized} is below minQty ${minQty} for ${params.symbol}`
        );
      }
      if (normalized === 0) {
        throw new Error(
          `Calculated quantity rounded to 0 for ${params.symbol} (stepSize=${stepSize ?? "n/a"}, quantityPrecision=${qtyPrecision})`
        );
      }
      quantity = normalized;
    }

    const normalizePrice = (value: number | undefined): number | undefined => {
      if (typeof value !== "number") return value;
      const stepped = tickSize ? this.roundToStep(value, tickSize) : value;
      const floored = this.floorToPrecision(stepped, pricePrecision);
      return Number(floored.toFixed(Math.max(0, pricePrecision)));
    };

    return {
      ...params,
      quantity,
      price: normalizePrice(params.price),
      stopPrice: normalizePrice(params.stopPrice),
    };
  }

  private mapPosition(p: BinancePosition): Position {
    return {
      symbol: p.symbol,
      positionSide: p.positionSide,
      positionAmt: parseFloat(p.positionAmt),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedProfit: parseFloat(p.unRealizedProfit),
      liquidationPrice: parseFloat(p.liquidationPrice),
      leverage: parseInt(p.leverage),
      marginType: p.marginType,
      notional: parseFloat(p.notional),
    };
  }

  private mapOrder(o: BinanceOrder): Order {
    return {
      orderId: o.orderId,
      symbol: o.symbol,
      status: o.status,
      clientOrderId: o.clientOrderId,
      price: parseFloat(o.price),
      avgPrice: parseFloat(o.avgPrice),
      origQty: parseFloat(o.origQty),
      executedQty: parseFloat(o.executedQty),
      type: o.type as Order["type"],
      side: o.side,
      positionSide: o.positionSide,
      stopPrice: o.stopPrice ? parseFloat(o.stopPrice) : undefined,
      time: o.time,
      updateTime: o.updateTime,
    };
  }
}

// Singleton instance
let binanceServiceInstance: BinanceService | null = null;

export function getBinanceService(): BinanceService {
  if (!binanceServiceInstance) {
    binanceServiceInstance = new BinanceService();
  }
  return binanceServiceInstance;
}
