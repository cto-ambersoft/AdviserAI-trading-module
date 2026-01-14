import {
  DerivativesTradingUsdsFutures,
  DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL,
  DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
} from "@binance/derivatives-trading-usds-futures";
import { EventEmitter } from "events";
import { getTradingConfig } from "../../config/trading";
import {
  type BinanceWsAccountUpdate,
  type BinanceWsOrderUpdate,
} from "./types";

export type WebSocketEventType =
  | "connected"
  | "disconnected"
  | "error"
  | "accountUpdate"
  | "orderUpdate"
  | "priceUpdate";

export interface PriceUpdate {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface AccountUpdateEvent {
  type: "ACCOUNT_UPDATE";
  timestamp: number;
  balances: Array<{
    asset: string;
    walletBalance: number;
    crossBalance: number;
    balanceChange: number;
  }>;
  positions: Array<{
    symbol: string;
    positionAmt: number;
    entryPrice: number;
    unrealizedPnl: number;
    marginType: string;
    positionSide: "BOTH" | "LONG" | "SHORT";
  }>;
}

export interface OrderUpdateEvent {
  type: "ORDER_UPDATE";
  timestamp: number;
  symbol: string;
  orderId: number;
  side: "BUY" | "SELL";
  orderType: string;
  status: string;
  price: number;
  quantity: number;
  executedQty: number;
  positionSide: "BOTH" | "LONG" | "SHORT";
}

export class BinanceWebSocketService extends EventEmitter {
  private client: DerivativesTradingUsdsFutures;
  private config = getTradingConfig();
  private listenKey: string | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnected = false;
  private priceSubscriptions: Map<string, WebSocket> = new Map();
  private wsBaseUrl: string;
  private userDataWs: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private shouldMaintainUserStream = false;
  private startInFlight: Promise<void> | null = null;

  constructor() {
    super();
    const baseUrl = this.config.binance.testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_REST_API_TESTNET_URL
      : undefined;

    this.wsBaseUrl = this.config.binance.testnet
      ? DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_TESTNET_URL
      : DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL;

    this.client = new DerivativesTradingUsdsFutures({
      configurationRestAPI: {
        apiKey: this.config.binance.apiKey,
        apiSecret: this.config.binance.apiSecret,
        basePath: baseUrl,
      },
    });
  }

  // ============ Credentials Check ============

  hasValidCredentials(): boolean {
    return !!(this.config.binance.apiKey && this.config.binance.apiSecret);
  }

  // ============ User Data Stream ============

  async startUserDataStream(): Promise<void> {
    this.shouldMaintainUserStream = true;

    // Check for valid credentials
    if (!this.hasValidCredentials()) {
      console.warn(
        "[WebSocket] Skipping user data stream - no valid API credentials configured"
      );
      console.warn(
        "[WebSocket] Set BINANCE_API_KEY and BINANCE_API_SECRET environment variables"
      );
      // Without credentials we can't maintain a private user stream.
      this.shouldMaintainUserStream = false;
      return;
    }

    if (this.startInFlight) {
      await this.startInFlight;
      return;
    }

    this.startInFlight = this.startUserDataStreamInternal().finally(() => {
      this.startInFlight = null;
    });

    await this.startInFlight;
  }

  private async startUserDataStreamInternal(): Promise<void> {
    try {
      // Clear any pending reconnect once we are actively trying
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      // Get listen key (may fail on network timeouts)
      const response = await this.client.restAPI.startUserDataStream();
      const data = (await response.data()) as { listenKey: string };
      this.listenKey = data.listenKey;

      // Start WebSocket connection
      await this.connectUserDataStream();

      // Keep alive every 30 minutes
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
      }
      this.keepAliveInterval = setInterval(
        async () => {
          await this.keepAliveUserDataStream();
        },
        30 * 60 * 1000
      );

      console.log("[WebSocket] User data stream started");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        "[WebSocket] Failed to start user data stream:",
        errorMessage
      );
      console.warn(
        "[WebSocket] Service will continue without real-time account updates"
      );

      // If the trading module is running, we must keep trying to restore the stream.
      if (this.shouldMaintainUserStream) {
        this.attemptReconnect();
      }
    }
  }

  private async connectUserDataStream(): Promise<void> {
    if (!this.listenKey) {
      throw new Error("No listen key available");
    }

    const wsUrl = `${this.wsBaseUrl}/ws/${this.listenKey}`;

    // Ensure we don't keep stale sockets around
    if (this.userDataWs) {
      try {
        this.userDataWs.onopen = null;
        this.userDataWs.onclose = null;
        this.userDataWs.onerror = null;
        this.userDataWs.onmessage = null;
      } catch {
        // ignore
      }
      try {
        this.userDataWs.close();
      } catch {
        // ignore
      }
      this.userDataWs = null;
    }

    const ws = new WebSocket(wsUrl);
    this.userDataWs = ws;

    ws.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit("connected");
      console.log("[WebSocket] User data stream connected");
    };

    ws.onclose = () => {
      this.isConnected = false;
      this.emit("disconnected");
      console.log("[WebSocket] User data stream disconnected");
      if (this.shouldMaintainUserStream) {
        this.attemptReconnect();
      }
    };

    ws.onerror = (error) => {
      console.error("[WebSocket] Error:", error);
      this.emit("error", error);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleUserDataMessage(data);
      } catch (error) {
        console.error("[WebSocket] Failed to parse message:", error);
      }
    };
  }

  private handleUserDataMessage(data: Record<string, unknown>): void {
    const eventType = data.e as string;

    if (eventType === "ACCOUNT_UPDATE") {
      const event = this.parseAccountUpdate(
        data as unknown as BinanceWsAccountUpdate
      );
      this.emit("accountUpdate", event);
    } else if (eventType === "ORDER_TRADE_UPDATE") {
      const event = this.parseOrderUpdate(
        data as unknown as BinanceWsOrderUpdate
      );
      this.emit("orderUpdate", event);
    }
  }

  private parseAccountUpdate(data: BinanceWsAccountUpdate): AccountUpdateEvent {
    return {
      type: "ACCOUNT_UPDATE",
      timestamp: data.E,
      balances: data.a.B.map((b) => ({
        asset: b.a,
        walletBalance: parseFloat(b.wb),
        crossBalance: parseFloat(b.cw),
        balanceChange: parseFloat(b.bc),
      })),
      positions: data.a.P.map((p) => ({
        symbol: p.s,
        positionAmt: parseFloat(p.pa),
        entryPrice: parseFloat(p.ep),
        unrealizedPnl: parseFloat(p.up),
        marginType: p.mt,
        positionSide: p.ps,
      })),
    };
  }

  private parseOrderUpdate(data: BinanceWsOrderUpdate): OrderUpdateEvent {
    return {
      type: "ORDER_UPDATE",
      timestamp: data.E,
      symbol: data.o.s,
      orderId: data.o.i,
      side: data.o.S,
      orderType: data.o.o,
      status: data.o.X,
      price: parseFloat(data.o.p),
      quantity: parseFloat(data.o.q),
      executedQty: parseFloat(data.o.z),
      positionSide: data.o.ps,
    };
  }

  private async keepAliveUserDataStream(): Promise<void> {
    if (!this.listenKey) return;

    try {
      await this.client.restAPI.keepaliveUserDataStream();
      console.log("[WebSocket] User data stream keep-alive sent");
    } catch (error) {
      console.error("[WebSocket] Keep-alive failed:", error);
      if (!this.shouldMaintainUserStream) return;
      // Reset stream on keep-alive failure (listenKey likely expired)
      await this.stopUserDataStream();
      await this.startUserDataStream();
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.shouldMaintainUserStream) return;

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(
      `[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.startUserDataStream();
      } catch (error) {
        console.error("[WebSocket] Reconnect failed:", error);
      }
    }, delay);
  }

  async stopUserDataStream(): Promise<void> {
    this.shouldMaintainUserStream = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    if (this.userDataWs) {
      try {
        this.userDataWs.close();
      } catch {
        // ignore
      }
      this.userDataWs = null;
    }

    if (this.listenKey) {
      try {
        await this.client.restAPI.closeUserDataStream();
      } catch {
        // Ignore errors when closing
      }
      this.listenKey = null;
    }

    this.isConnected = false;
    console.log("[WebSocket] User data stream stopped");
  }

  // ============ Price Streams ============

  subscribeToPriceUpdates(symbols: string[]): void {
    for (const symbol of symbols) {
      if (this.priceSubscriptions.has(symbol)) continue;

      const streamName = `${symbol.toLowerCase()}@markPrice@1s`;
      const wsUrl = `${this.wsBaseUrl}/ws/${streamName}`;

      const ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          const priceUpdate: PriceUpdate = {
            symbol: data.s,
            price: parseFloat(data.p),
            timestamp: data.E,
          };
          this.emit("priceUpdate", priceUpdate);
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        this.priceSubscriptions.delete(symbol);
      };

      this.priceSubscriptions.set(symbol, ws);
      console.log(`[WebSocket] Subscribed to price updates: ${symbol}`);
    }
  }

  unsubscribeFromPriceUpdates(symbols: string[]): void {
    for (const symbol of symbols) {
      const ws = this.priceSubscriptions.get(symbol);
      if (ws) {
        ws.close();
        this.priceSubscriptions.delete(symbol);
        console.log(`[WebSocket] Unsubscribed from price updates: ${symbol}`);
      }
    }
  }

  // ============ Status ============

  getStatus(): {
    isConnected: boolean;
    listenKey: string | null;
    priceSubscriptions: string[];
  } {
    return {
      isConnected: this.isConnected,
      listenKey: this.listenKey,
      priceSubscriptions: Array.from(this.priceSubscriptions.keys()),
    };
  }

  // ============ Cleanup ============

  async close(): Promise<void> {
    await this.stopUserDataStream();

    for (const ws of this.priceSubscriptions.values()) {
      ws.close();
    }
    this.priceSubscriptions.clear();

    this.removeAllListeners();
    console.log("[WebSocket] All connections closed");
  }
}

// Singleton instance
let wsServiceInstance: BinanceWebSocketService | null = null;

export function getBinanceWebSocketService(): BinanceWebSocketService {
  if (!wsServiceInstance) {
    wsServiceInstance = new BinanceWebSocketService();
  }
  return wsServiceInstance;
}
