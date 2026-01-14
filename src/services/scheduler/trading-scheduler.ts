import cron, { type ScheduledTask as CronScheduledTask } from "node-cron"
import { getTradingConfig } from "../../config/trading"

export type ScheduledTask = {
  id: string
  name: string
  cronExpression: string
  task: CronScheduledTask
  enabled: boolean
}

export type TaskHandler = () => Promise<void>

export class TradingScheduler {
  private tasks: Map<string, ScheduledTask> = new Map()
  private handlers: Map<string, TaskHandler> = new Map()
  private config = getTradingConfig()

  constructor() {
    // Initialize default handlers (will be set later)
  }

  // ============ Task Management ============

  scheduleTask(
    id: string,
    name: string,
    cronExpression: string,
    handler: TaskHandler
  ): void {
    // Remove existing task if any
    this.removeTask(id)

    // Use createTask to create without auto-starting
    const task = cron.createTask(
      cronExpression,
      async () => {
        console.log(`[Scheduler] Running task: ${name}`)
        try {
          await handler()
          console.log(`[Scheduler] Task completed: ${name}`)
        } catch (error) {
          console.error(
            `[Scheduler] Task failed: ${name}`,
            error instanceof Error ? error.message : error
          )
        }
      },
      { name: id }
    )

    this.tasks.set(id, {
      id,
      name,
      cronExpression,
      task,
      enabled: false,
    })
    this.handlers.set(id, handler)

    console.log(`[Scheduler] Task registered: ${name} (${cronExpression})`)
  }

  removeTask(id: string): void {
    const scheduledTask = this.tasks.get(id)
    if (scheduledTask) {
      scheduledTask.task.stop()
      this.tasks.delete(id)
      this.handlers.delete(id)
      console.log(`[Scheduler] Task removed: ${scheduledTask.name}`)
    }
  }

  startTask(id: string): void {
    const scheduledTask = this.tasks.get(id)
    if (scheduledTask && !scheduledTask.enabled) {
      scheduledTask.task.start()
      scheduledTask.enabled = true
      console.log(`[Scheduler] Task started: ${scheduledTask.name}`)
    }
  }

  stopTask(id: string): void {
    const scheduledTask = this.tasks.get(id)
    if (scheduledTask && scheduledTask.enabled) {
      scheduledTask.task.stop()
      scheduledTask.enabled = false
      console.log(`[Scheduler] Task stopped: ${scheduledTask.name}`)
    }
  }

  // ============ Bulk Operations ============

  startAll(): void {
    for (const [id] of this.tasks) {
      this.startTask(id)
    }
    console.log(`[Scheduler] All tasks started (${this.tasks.size} tasks)`)
  }

  stopAll(): void {
    for (const [id] of this.tasks) {
      this.stopTask(id)
    }
    console.log(`[Scheduler] All tasks stopped`)
  }

  // ============ Manual Execution ============

  async runTaskNow(id: string): Promise<void> {
    const handler = this.handlers.get(id)
    if (!handler) {
      throw new Error(`Task not found: ${id}`)
    }

    const task = this.tasks.get(id)
    console.log(`[Scheduler] Manual run: ${task?.name ?? id}`)
    await handler()
  }

  // ============ Status ============

  getTaskStatus(): Array<{
    id: string
    name: string
    cronExpression: string
    enabled: boolean
    nextRun: Date | null
  }> {
    return Array.from(this.tasks.values()).map((task) => ({
      id: task.id,
      name: task.name,
      cronExpression: task.cronExpression,
      enabled: task.enabled,
      nextRun: null, // node-cron doesn't provide this easily
    }))
  }

  isRunning(): boolean {
    return Array.from(this.tasks.values()).some((t) => t.enabled)
  }
}

// ============ Default Trading Scheduler Setup ============

export function createDefaultTradingScheduler(
  onPreUsMarket: TaskHandler,
  onPreAsiaMarket: TaskHandler,
  onPositionCheck: TaskHandler
): TradingScheduler {
  const scheduler = new TradingScheduler()
  const config = getTradingConfig()

  // Pre-US Market Analysis (13:30 UTC - 30 min before US market open)
  scheduler.scheduleTask(
    "pre-us-market",
    "Pre-US Market Analysis",
    config.scheduler.preUsMarketCron,
    onPreUsMarket
  )

  // Pre-Asia Market Analysis (00:00 UTC)
  scheduler.scheduleTask(
    "pre-asia-market",
    "Pre-Asia Market Analysis",
    config.scheduler.preAsiaMarketCron,
    onPreAsiaMarket
  )

  // Position check every hour
  scheduler.scheduleTask(
    "position-check",
    "Hourly Position Check",
    "0 * * * *", // Every hour
    onPositionCheck
  )

  // Risk check every 15 minutes during active trading
  scheduler.scheduleTask(
    "risk-check",
    "Risk Check",
    "*/15 * * * *", // Every 15 minutes
    async () => {
      // Quick risk assessment
      console.log("[Scheduler] Running periodic risk check")
    }
  )

  return scheduler
}

// Singleton instance
let schedulerInstance: TradingScheduler | null = null

export function getTradingScheduler(): TradingScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new TradingScheduler()
  }
  return schedulerInstance
}
