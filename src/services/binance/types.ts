// Binance Futures API response types

export interface BinancePosition {
  symbol: string
  positionSide: "BOTH" | "LONG" | "SHORT"
  positionAmt: string
  entryPrice: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  marginType: "isolated" | "cross"
  notional: string
  isolatedMargin?: string
  updateTime: number
}

export interface BinanceBalance {
  accountAlias: string
  asset: string
  balance: string
  crossWalletBalance: string
  crossUnPnl: string
  availableBalance: string
  maxWithdrawAmount: string
  marginAvailable: boolean
  updateTime: number
}

export interface BinanceOrder {
  orderId: number
  symbol: string
  status: string
  clientOrderId: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  cumQuote: string
  timeInForce: string
  type: string
  reduceOnly: boolean
  closePosition: boolean
  side: "BUY" | "SELL"
  positionSide: "BOTH" | "LONG" | "SHORT"
  stopPrice: string
  workingType: string
  priceProtect: boolean
  origType: string
  time: number
  updateTime: number
}

export interface BinanceNewOrderParams {
  symbol: string
  side: "BUY" | "SELL"
  type:
    | "LIMIT"
    | "MARKET"
    | "STOP"
    | "STOP_MARKET"
    | "TAKE_PROFIT"
    | "TAKE_PROFIT_MARKET"
    | "TRAILING_STOP_MARKET"
  positionSide?: "BOTH" | "LONG" | "SHORT"
  quantity?: number
  price?: number
  stopPrice?: number
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX" | "GTD"
  reduceOnly?: boolean
  closePosition?: boolean
  newClientOrderId?: string
}

export interface BinanceOrderResponse {
  orderId: number
  symbol: string
  status: string
  clientOrderId: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  cumQuote: string
  timeInForce: string
  type: string
  reduceOnly: boolean
  closePosition: boolean
  side: "BUY" | "SELL"
  positionSide: "BOTH" | "LONG" | "SHORT"
  stopPrice: string
  workingType: string
  priceProtect: boolean
  origType: string
  updateTime: number
}

export interface BinanceAccountInfo {
  feeTier: number
  canTrade: boolean
  canDeposit: boolean
  canWithdraw: boolean
  updateTime: number
  totalInitialMargin: string
  totalMaintMargin: string
  totalWalletBalance: string
  totalUnrealizedProfit: string
  totalMarginBalance: string
  totalPositionInitialMargin: string
  totalOpenOrderInitialMargin: string
  totalCrossWalletBalance: string
  totalCrossUnPnl: string
  availableBalance: string
  maxWithdrawAmount: string
  assets: BinanceBalance[]
  positions: BinancePosition[]
}

export interface BinanceTickerPrice {
  symbol: string
  price: string
  time: number
}

export interface BinanceExchangeInfo {
  timezone: string
  serverTime: number
  rateLimits: Array<{
    rateLimitType: string
    interval: string
    intervalNum: number
    limit: number
  }>
  symbols: Array<{
    symbol: string
    pair: string
    contractType: string
    deliveryDate: number
    onboardDate: number
    status: string
    baseAsset: string
    quoteAsset: string
    marginAsset: string
    pricePrecision: number
    quantityPrecision: number
    baseAssetPrecision: number
    quotePrecision: number
    filters: Array<{
      filterType: string
      [key: string]: string | number | boolean
    }>
  }>
}

// WebSocket event types
export interface BinanceWsAccountUpdate {
  e: "ACCOUNT_UPDATE"
  E: number
  T: number
  a: {
    m: string
    B: Array<{
      a: string
      wb: string
      cw: string
      bc: string
    }>
    P: Array<{
      s: string
      pa: string
      ep: string
      cr: string
      up: string
      mt: string
      iw: string
      ps: "BOTH" | "LONG" | "SHORT"
    }>
  }
}

export interface BinanceWsOrderUpdate {
  e: "ORDER_TRADE_UPDATE"
  E: number
  T: number
  o: {
    s: string
    c: string
    S: "BUY" | "SELL"
    o: string
    f: string
    q: string
    p: string
    ap: string
    sp: string
    x: string
    X: string
    i: number
    l: string
    z: string
    L: string
    n: string
    N: string
    T: number
    t: number
    b: string
    a: string
    m: boolean
    R: boolean
    wt: string
    ot: string
    ps: "BOTH" | "LONG" | "SHORT"
    cp: boolean
    rp: string
    pP: boolean
    si: number
    ss: number
  }
}
