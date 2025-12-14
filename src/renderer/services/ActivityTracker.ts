/* Centralized Activity Tracker (renderer)
 * Sends activity events to main via IPC and queues offline if needed.
 */

export type ActivityContext = {
  staffId?: string
  sessionId?: string
  terminalId?: string
  branchId?: string
}

export type ActivityEvent = {
  type: string
  action: string
  result: 'success' | 'failure'
  message?: string
  metadata?: Record<string, any>
  timestamp?: string
}

class ActivityTrackerClass {
  private static _instance: ActivityTrackerClass
  private context: ActivityContext = {}
  private queue: ActivityEvent[] = []
  private retryTimer: any = null

  static get instance() {
    if (!this._instance) this._instance = new ActivityTrackerClass()
    return this._instance
  }

  setContext(ctx: ActivityContext) {
    this.context = { ...this.context, ...ctx }
  }

  private loadFallbackContext(): ActivityContext {
    try {
      const raw = localStorage.getItem('pos-user')
      if (!raw) return {}
      const u = JSON.parse(raw)
      return { staffId: u?.staffId, sessionId: u?.sessionId, terminalId: u?.terminalId, branchId: u?.branchId }
    } catch {
      return {}
    }
  }

  private async send(ev: ActivityEvent) {
    const ctx = { ...this.loadFallbackContext(), ...this.context }
    const payload = { ...ev, ...ctx, timestamp: ev.timestamp || new Date().toISOString() }
    try {
      const resourceType = (payload.metadata?.resourceType ?? null) as string | null
      const resourceId = (payload.metadata?.resourceId ?? payload.metadata?.orderId ?? null) as string | null
      await (window as any).electronAPI?.ipcRenderer?.invoke(
        'staff-auth:track-activity',
        payload.type,
        resourceType,
        resourceId,
        payload.action,
        payload.metadata ?? {},
        payload.result,
      )
      return true
    } catch (e) {
      return false
    }
  }

  private ensureRetryLoop() {
    if (this.retryTimer) return
    this.retryTimer = setInterval(async () => {
      if (!this.queue.length) return
      const next = this.queue[0]
      const ok = await this.send(next)
      if (ok) this.queue.shift()
    }, 3000)
  }

  private track(ev: ActivityEvent) {
    this.send(ev).then(ok => {
      if (!ok) {
        this.queue.push(ev)
        this.ensureRetryLoop()
      }
    })
  }

  trackOrderCreated(orderId: string, totalAmount: number) {
    this.track({ type: 'order', action: 'create', result: 'success', metadata: { orderId, totalAmount } })
  }

  trackDiscount(applied: boolean, amount?: number, percent?: number) {
    if (!applied) return
    this.track({ type: 'discount', action: 'apply', result: 'success', metadata: { amount, percent } })
  }

  trackPaymentCompleted(amount: number, method: 'cash' | 'card', transactionId?: string, driverId?: string) {
    this.track({ type: 'payment', action: 'complete', result: 'success', metadata: { amount, method, transactionId, driverId } })
  }

  trackRefund(orderId: string, amount: number) {
    this.track({ type: 'payment', action: 'refund', result: 'success', metadata: { orderId, amount } })
  }

  trackVoidTransaction(orderId: string, reason?: string) {
    this.track({ type: 'payment', action: 'void', result: 'success', metadata: { orderId, reason } })
  }
}

export const ActivityTracker = ActivityTrackerClass.instance

