/* Centralized Activity Tracker (renderer)
 * Sends activity events to main via IPC and queues offline if needed.
 */
import { getBridge, isBrowser, onEvent } from '../../lib'

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
  private retryTimeout: ReturnType<typeof setTimeout> | null = null
  private retryDelayMs = 1500
  private retryEventsBound = false
  private readonly RETRY_DELAY_MIN_MS = 1500
  private readonly RETRY_DELAY_MAX_MS = 30000
  private bridge = getBridge()

  static get instance() {
    if (!this._instance) this._instance = new ActivityTrackerClass()
    return this._instance
  }

  private constructor() {
    this.bindRetryEvents()
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
    if (isBrowser()) return false
    const ctx = { ...this.loadFallbackContext(), ...this.context }
    const payload = { ...ev, ...ctx, timestamp: ev.timestamp || new Date().toISOString() }
    try {
      // Current native command refreshes inactivity timers only.
      // Keep payload construction for future structured activity endpoints.
      void payload
      await this.bridge.staffAuth.trackActivity()
      return true
    } catch (e) {
      return false
    }
  }

  private bindRetryEvents() {
    if (this.retryEventsBound) return
    this.retryEventsBound = true

    const triggerRetry = () => {
      if (!this.queue.length) return
      this.retryDelayMs = this.RETRY_DELAY_MIN_MS
      this.scheduleRetry(150)
    }

    onEvent('sync:complete', triggerRetry)
    onEvent('sync:status', (payload: any) => {
      if (payload?.isOnline === false) return
      triggerRetry()
    })
    onEvent('network:status', (payload: any) => {
      if (payload?.isOnline === false) return
      triggerRetry()
    })
  }

  private scheduleRetry(delayMs = this.retryDelayMs) {
    if (this.retryTimeout) return
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null
      void this.retryOnce()
    }, delayMs)
  }

  private async retryOnce() {
    if (!this.queue.length) return
    const next = this.queue[0]
    const ok = await this.send(next)
    if (ok) {
      this.queue.shift()
      this.retryDelayMs = this.RETRY_DELAY_MIN_MS
      if (this.queue.length) {
        this.scheduleRetry(200)
      }
      return
    }

    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.RETRY_DELAY_MAX_MS)
    this.scheduleRetry(this.retryDelayMs)
  }

  private track(ev: ActivityEvent) {
    this.send(ev).then(ok => {
      if (ok) return
      this.queue.push(ev)
      this.scheduleRetry(this.RETRY_DELAY_MIN_MS)
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

