import { createClient, type Client } from "@libsql/client"
import { randomUUID } from "node:crypto"

export type AiDecisionLogSource =
  | "analysisWorkflow"
  | "tradeExecutionWorkflow"
  | "positionManagementWorkflow"
  | "tradingAgent"

export interface AiDecisionLogRecord {
  id: string
  createdAt: number
  symbol: string | null
  source: AiDecisionLogSource
  eventType: string
  action: string | null
  confidence: number | null
  entryPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  riskReward: number | null
  summary: string | null
  reasoning: string
  meta: unknown | null
}

export interface AppendAiDecisionLogInput {
  symbol?: string | null
  source: AiDecisionLogSource
  eventType: string
  action?: string | null
  confidence?: number | null
  entryPrice?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  riskReward?: number | null
  summary?: string | null
  reasoning: string
  meta?: unknown
  createdAt?: number
}

export interface ListAiDecisionLogsParams {
  symbol?: string
  eventType?: string
  limit?: number
  before?: number
}

interface StoreOptions {
  url: string
  maxRows: number
  maxAgeDays: number
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toNullableString(value: unknown): string | null {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return null
  return String(value)
}

function toStringStrict(value: unknown, fallback: string): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

function parseMetaJson(value: unknown): unknown | null {
  const s = toNullableString(value)
  if (!s) return null
  try {
    return JSON.parse(s) as unknown
  } catch {
    return { raw: s }
  }
}

export class AiDecisionLogStore {
  private client: Client
  private initialized = false
  private options: StoreOptions

  constructor(options?: Partial<StoreOptions>) {
    const url = options?.url ?? (process.env.LIBSQL_URL ?? "file:./trading.db")
    this.options = {
      url,
      maxRows: options?.maxRows ?? 5000,
      maxAgeDays: options?.maxAgeDays ?? 30,
    }
    this.client = createClient({ url })
  }

  private async init(): Promise<void> {
    if (this.initialized) return

    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS ai_decision_logs (
        id TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL,
        symbol TEXT,
        source TEXT NOT NULL,
        eventType TEXT NOT NULL,
        action TEXT,
        confidence REAL,
        entryPrice REAL,
        stopLoss REAL,
        takeProfit REAL,
        riskReward REAL,
        summary TEXT,
        reasoning TEXT NOT NULL,
        metaJson TEXT
      )
    `)

    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_ai_decision_logs_createdAt ON ai_decision_logs(createdAt DESC)"
    )
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_ai_decision_logs_symbol_createdAt ON ai_decision_logs(symbol, createdAt DESC)"
    )
    await this.client.execute(
      "CREATE INDEX IF NOT EXISTS idx_ai_decision_logs_eventType_createdAt ON ai_decision_logs(eventType, createdAt DESC)"
    )

    this.initialized = true
  }

  private async enforceRetention(): Promise<void> {
    const maxAgeMs = this.options.maxAgeDays * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - maxAgeMs

    await this.client.execute({
      sql: "DELETE FROM ai_decision_logs WHERE createdAt < ?",
      args: [cutoff],
    })

    await this.client.execute({
      sql: `
        DELETE FROM ai_decision_logs
        WHERE id IN (
          SELECT id
          FROM ai_decision_logs
          ORDER BY createdAt DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `,
      args: [this.options.maxRows],
    })
  }

  async append(input: AppendAiDecisionLogInput): Promise<AiDecisionLogRecord> {
    await this.init()

    const record: AiDecisionLogRecord = {
      id: randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      symbol: input.symbol ?? null,
      source: input.source,
      eventType: input.eventType,
      action: input.action ?? null,
      confidence: input.confidence ?? null,
      entryPrice: input.entryPrice ?? null,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      riskReward: input.riskReward ?? null,
      summary: input.summary ?? null,
      reasoning: input.reasoning,
      meta: input.meta ?? null,
    }

    const metaJson = record.meta ? JSON.stringify(record.meta) : null

    await this.client.execute({
      sql: `
        INSERT INTO ai_decision_logs (
          id, createdAt, symbol, source, eventType, action, confidence,
          entryPrice, stopLoss, takeProfit, riskReward,
          summary, reasoning, metaJson
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?
        )
      `,
      args: [
        record.id,
        record.createdAt,
        record.symbol,
        record.source,
        record.eventType,
        record.action,
        record.confidence,
        record.entryPrice,
        record.stopLoss,
        record.takeProfit,
        record.riskReward,
        record.summary,
        record.reasoning,
        metaJson,
      ],
    })

    await this.enforceRetention()
    return record
  }

  async list(params?: ListAiDecisionLogsParams): Promise<AiDecisionLogRecord[]> {
    await this.init()

    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500)

    const where: string[] = []
    const args: Array<string | number | null> = []

    if (params?.symbol) {
      where.push("symbol = ?")
      args.push(params.symbol)
    }

    if (params?.eventType) {
      where.push("eventType = ?")
      args.push(params.eventType)
    }

    if (params?.before) {
      where.push("createdAt < ?")
      args.push(params.before)
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

    const result = await this.client.execute({
      sql: `
        SELECT
          id, createdAt, symbol, source, eventType, action, confidence,
          entryPrice, stopLoss, takeProfit, riskReward,
          summary, reasoning, metaJson
        FROM ai_decision_logs
        ${whereSql}
        ORDER BY createdAt DESC, id DESC
        LIMIT ?
      `,
      args: [...args, limit],
    })

    return result.rows.map((row) => {
      const createdAt = toNullableNumber(row.createdAt) ?? Date.now()
      return {
        id: toStringStrict(row.id, randomUUID()),
        createdAt,
        symbol: toNullableString(row.symbol),
        source: toStringStrict(row.source, "analysisWorkflow") as AiDecisionLogSource,
        eventType: toStringStrict(row.eventType, "UNKNOWN"),
        action: toNullableString(row.action),
        confidence: toNullableNumber(row.confidence),
        entryPrice: toNullableNumber(row.entryPrice),
        stopLoss: toNullableNumber(row.stopLoss),
        takeProfit: toNullableNumber(row.takeProfit),
        riskReward: toNullableNumber(row.riskReward),
        summary: toNullableString(row.summary),
        reasoning: toStringStrict(row.reasoning, ""),
        meta: parseMetaJson(row.metaJson),
      }
    })
  }

  async latest(params?: {
    symbol?: string
    eventType?: string
  }): Promise<AiDecisionLogRecord | null> {
    const rows = await this.list({
      symbol: params?.symbol,
      eventType: params?.eventType,
      limit: 1,
    })
    return rows[0] ?? null
  }
}

let storeInstance: AiDecisionLogStore | null = null

export function getAiDecisionLogStore(): AiDecisionLogStore {
  if (!storeInstance) storeInstance = new AiDecisionLogStore()
  return storeInstance
}

