import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { MastraServer } from "@mastra/express";
import { z } from "zod";
import { mastra } from "./mastra";
import { getTradingModule } from "./trading-module";
import { getTradingConfig } from "./config/trading";
import { getAiDecisionLogStore } from "./services/ai-decision-log-store";

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

// ============ CORS (allow all origins/headers/content-types) ============
const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  res.set("Access-Control-Allow-Origin", "*");

  res.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  const requestedHeaders = req.header("access-control-request-headers");
  if (requestedHeaders) {
    res.set("Access-Control-Allow-Headers", requestedHeaders);
  } else {
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, X-Requested-With, Origin"
    );
  }

  res.set("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.set("Content-Length", "0");
    res.status(204).end();
    return;
  }

  next();
};

app.use(corsMiddleware);

// ============ Admin Auth (ADMIN_LOGIN/ADMIN_PASSWORD -> ADMIN_API_KEY) ============
const adminApiKey = process.env.ADMIN_API_KEY;
if (!adminApiKey) {
  throw new Error("ADMIN_API_KEY is required (set it in env/.env)");
}

const adminLogin = process.env.ADMIN_LOGIN;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminLogin || !adminPassword) {
  throw new Error(
    "ADMIN_LOGIN and ADMIN_PASSWORD are required (set them in env/.env)"
  );
}

const LoginBodySchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

// Public endpoint to obtain api key for admin panel
app.post("/api/login", (req: Request, res: Response) => {
  try {
    const body = LoginBodySchema.parse(req.body);
    if (body.login !== adminLogin || body.password !== adminPassword) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    res.json({ apiKey: adminApiKey });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid request",
    });
  }
});

// All other endpoints require API key
app.use((req: Request, res: Response, next) => {
  const key = req.header("x-api-key") ?? req.header("authorization") ?? "";
  const normalizedKey = key.toLowerCase().startsWith("bearer ")
    ? key.slice("bearer ".length).trim()
    : key.trim();

  if (!normalizedKey || normalizedKey !== adminApiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

// Initialize Mastra server
const server = new MastraServer({ app, mastra });
await server.init();

// Initialize Trading Module (lazy - will start when needed)
const tradingModule = getTradingModule();

// ============ Health & Status Routes ============

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "Trading Module",
    version: "1.0.0",
    status: "running",
  });
});

app.get("/api/status", async (_req: Request, res: Response) => {
  try {
    const status = tradingModule.getStatus();
    const summary = await tradingModule.getAccountSummary();

    res.json({
      module: status,
      account: summary,
      scheduler: tradingModule.getSchedulerStatus(),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get status",
    });
  }
});

// ============ AI Decision Log Routes ============

const firstQueryValue = (value: unknown) =>
  Array.isArray(value) ? value[0] : value;

const AiLogsListQuerySchema = z.object({
  symbol: z.preprocess(firstQueryValue, z.string().min(1).optional()),
  eventType: z.preprocess(firstQueryValue, z.string().min(1).optional()),
  limit: z.preprocess(
    firstQueryValue,
    z.coerce.number().int().min(1).max(500).default(100)
  ),
  before: z.preprocess(
    firstQueryValue,
    z.coerce.number().int().positive().optional()
  ),
});

const AiLogsLatestQuerySchema = z.object({
  symbol: z.preprocess(firstQueryValue, z.string().min(1).optional()),
  eventType: z.preprocess(firstQueryValue, z.string().min(1).optional()),
});

// ============ Trade History Routes ============

const TradesHistoryQuerySchema = z.object({
  symbol: z.preprocess(firstQueryValue, z.string().min(1).optional()),
  limit: z.preprocess(
    firstQueryValue,
    z.coerce.number().int().min(1).max(500).default(100)
  ),
  before: z.preprocess(
    firstQueryValue,
    z.coerce.number().int().positive().optional()
  ),
});

const tradeEventTypes = new Set(["TRADE_EXECUTED", "TRADE_PARTIAL_SUCCESS"]);

app.get("/api/trades", async (req: Request, res: Response) => {
  try {
    const query = TradesHistoryQuerySchema.parse(req.query);
    const store = getAiDecisionLogStore();

    const [executed, partial] = await Promise.all([
      store.list({
        symbol: query.symbol,
        eventType: "TRADE_EXECUTED",
        limit: query.limit,
        before: query.before,
      }),
      store.list({
        symbol: query.symbol,
        eventType: "TRADE_PARTIAL_SUCCESS",
        limit: query.limit,
        before: query.before,
      }),
    ]);

    const trades = [...executed, ...partial]
      .filter((l) => tradeEventTypes.has(l.eventType))
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return b.id.localeCompare(a.id);
      })
      .slice(0, query.limit)
      .map((l) => ({
        id: l.id,
        createdAt: l.createdAt,
        symbol: l.symbol,
        eventType: l.eventType,
        action: l.action,
        entryPrice: l.entryPrice,
        stopLoss: l.stopLoss,
        takeProfit: l.takeProfit,
        confidence: l.confidence,
        summary: l.summary,
        reasoning: l.reasoning,
        source: l.source,
        meta: l.meta,
      }));

    res.json({ trades });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid request",
    });
  }
});

app.get("/api/ai-logs", async (req: Request, res: Response) => {
  try {
    const query = AiLogsListQuerySchema.parse(req.query);
    const logs = await getAiDecisionLogStore().list({
      symbol: query.symbol,
      eventType: query.eventType,
      limit: query.limit,
      before: query.before,
    });
    res.json({ logs });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid request",
    });
  }
});

app.get("/api/ai-logs/latest", async (req: Request, res: Response) => {
  try {
    const query = AiLogsLatestQuerySchema.parse(req.query);
    const log = await getAiDecisionLogStore().latest({
      symbol: query.symbol,
      eventType: query.eventType,
    });
    res.json({ log });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid request",
    });
  }
});

// ============ Trading Control Routes ============

app.post("/api/trading/start", async (_req: Request, res: Response) => {
  try {
    await tradingModule.start();
    res.json({ success: true, message: "Trading module started" });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to start",
    });
  }
});

app.post("/api/trading/stop", async (_req: Request, res: Response) => {
  try {
    await tradingModule.stop();
    res.json({ success: true, message: "Trading module stopped" });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to stop",
    });
  }
});

// ============ Position Routes ============

app.get("/api/positions", async (_req: Request, res: Response) => {
  try {
    const positions = await tradingModule.getPositions();
    res.json({ positions });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get positions",
    });
  }
});

app.post(
  "/api/positions/:symbol/close",
  async (req: Request<{ symbol: string }>, res: Response) => {
    try {
      const { symbol } = req.params;
      const success = await tradingModule.closePosition(symbol);
      res.json({ success, symbol });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to close position",
      });
    }
  }
);

app.post("/api/positions/close-all", async (_req: Request, res: Response) => {
  try {
    const closed = await tradingModule.closeAllPositions();
    res.json({ success: true, closedCount: closed });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to close positions",
    });
  }
});

// ============ Trade Execution Routes ============

app.post("/api/trade/execute", async (req: Request, res: Response) => {
  try {
    const { symbol, riskAmountUsd } = req.body as {
      symbol: string;
      riskAmountUsd?: number;
    };

    if (!symbol) {
      res.status(400).json({ error: "Symbol is required" });
      return;
    }

    const config = getTradingConfig();
    const risk = riskAmountUsd ?? config.risk.defaultRiskPerTradeUsd;

    const result = await tradingModule.executeTrade(symbol, risk);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to execute trade",
    });
  }
});

app.post("/api/trade/analyze", async (req: Request, res: Response) => {
  try {
    const { symbols } = req.body as { symbols?: string[] };
    const config = getTradingConfig();

    const symbolList = symbols ?? config.trading.defaultSymbols;

    const workflow = mastra.getWorkflow("analysisWorkflow");
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { symbols: symbolList },
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Analysis failed",
    });
  }
});

// ============ Manual Analysis Trigger Route ============

app.post("/api/analysis/trigger", async (req: Request, res: Response) => {
  try {
    const { symbols, executeTrades } = req.body as {
      symbols?: string[];
      executeTrades?: boolean;
    };
    const config = getTradingConfig();

    const symbolList = symbols ?? config.trading.defaultSymbols;

    // Run the analysis workflow
    const workflow = mastra.getWorkflow("analysisWorkflow");
    const run = await workflow.createRun();
    const analysisResult = await run.start({
      inputData: { symbols: symbolList },
    });

    // Optionally execute trades based on analysis
    if (executeTrades && analysisResult.status === "success") {
      await tradingModule.runAnalysisAndTrade();
    }

    res.json({
      success: true,
      analysis: analysisResult,
      tradesExecuted: executeTrades ?? false,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Analysis trigger failed",
    });
  }
});

// ============ Scheduler Routes ============

app.post(
  "/api/scheduler/run/:taskId",
  async (req: Request<{ taskId: string }>, res: Response) => {
    try {
      const { taskId } = req.params;
      await tradingModule.runTaskNow(taskId);
      res.json({ success: true, taskId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to run task",
      });
    }
  }
);

// ============ Agent Chat Routes ============

app.post("/api/agent/trading", async (req: Request, res: Response) => {
  try {
    const { message } = req.body as { message: string };
    if (!message) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const response = await tradingModule.askTradingAgent(message);
    res.json({ response });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Agent error",
    });
  }
});

app.post("/api/agent/risk", async (req: Request, res: Response) => {
  try {
    const { message } = req.body as { message: string };
    if (!message) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const response = await tradingModule.askRiskAgent(message);
    res.json({ response });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Agent error",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Trading service is running on http://localhost:${PORT}`);
  console.log("Available endpoints:");
  console.log("  GET  /api/status - Get trading module status");
  console.log("  POST /api/trading/start - Start trading module");
  console.log("  POST /api/trading/stop - Stop trading module");
  console.log("  GET  /api/positions - Get open positions");
  console.log("  POST /api/positions/:symbol/close - Close position");
  console.log("  POST /api/trade/execute - Execute trade");
  console.log("  POST /api/trade/analyze - Run analysis workflow");
  console.log("  POST /api/analysis/trigger - Manual analysis trigger");
  console.log("  GET  /api/trades - Trade execution history");
  console.log("  GET  /api/ai-logs - List AI decision logs");
  console.log("  GET  /api/ai-logs/latest - Latest AI decision log");
  console.log("  POST /api/scheduler/run/:taskId - Run scheduled task");
  console.log("  POST /api/agent/trading - Chat with trading agent");
  console.log("  POST /api/agent/risk - Chat with risk agent");
});
