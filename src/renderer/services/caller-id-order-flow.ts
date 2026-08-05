export interface CallerIdOrderCustomer {
  id: string
  name: string
  phone: string
  [key: string]: unknown
}

export type CallerIdRequestedOrderType =
  | 'pickup'
  | 'delivery'
  | 'dine-in'
  | 'room'
  | 'service'

export interface CallerIdOrderIntent {
  requestKey: string
  displayPhone: string
  canonicalPhone: string
  lookupPhone: string
  customer: CallerIdOrderCustomer | null
  /**
   * When supplied, the Caller ID workspace already collected the operator's
   * choice and the dashboard must continue that flow directly instead of
   * opening a second order-type modal.
   */
  requestedOrderType?: CallerIdRequestedOrderType
  createdAt: number
}

export type CallerIdOrderSelectionAction =
  | 'open-menu'
  | 'use-existing-customer'
  | 'add-customer'
  | 'open-table-selector'

type CallerIdOrderIntentListener = (intent: CallerIdOrderIntent) => void

const INTENT_TTL_MS = 30_000
const pendingIntents: CallerIdOrderIntent[] = []
const listeners = new Set<CallerIdOrderIntentListener>()

function removeExpiredIntents(now = Date.now()): void {
  while (
    pendingIntents.length > 0 &&
    now - pendingIntents[0].createdAt > INTENT_TTL_MS
  ) {
    pendingIntents.shift()
  }
}

function deliverPendingIntents(): void {
  removeExpiredIntents()
  if (pendingIntents.length === 0 || listeners.size === 0) return

  for (const listener of listeners) {
    const nextIntent = pendingIntents.shift()
    if (!nextIntent) break
    listener(nextIntent)
  }

  if (pendingIntents.length > 0 && listeners.size > 0) {
    queueMicrotask(deliverPendingIntents)
  }
}

/**
 * Keeps the Caller ID handoff in memory only. This preserves offline support
 * without writing phone/customer PII to localStorage or sessionStorage.
 */
export function enqueueCallerIdOrderIntent(
  intent: Omit<CallerIdOrderIntent, 'createdAt'> & { createdAt?: number },
): void {
  const normalizedIntent: CallerIdOrderIntent = {
    ...intent,
    createdAt: intent.createdAt ?? Date.now(),
  }
  const duplicateIndex = pendingIntents.findIndex(
    (pending) => pending.requestKey === normalizedIntent.requestKey,
  )
  if (duplicateIndex >= 0) {
    pendingIntents[duplicateIndex] = normalizedIntent
  } else {
    pendingIntents.push(normalizedIntent)
  }
  deliverPendingIntents()
}

export function subscribeToCallerIdOrderIntents(
  listener: CallerIdOrderIntentListener,
): () => void {
  listeners.add(listener)
  deliverPendingIntents()
  return () => listeners.delete(listener)
}

export function clearCallerIdOrderIntents(): void {
  pendingIntents.length = 0
}

export function resolveCallerIdOrderSelection(
  orderType: 'pickup' | 'delivery' | 'dine-in',
  intent: CallerIdOrderIntent,
): CallerIdOrderSelectionAction {
  if (orderType === 'pickup') return 'open-menu'
  if (orderType === 'dine-in') return 'open-table-selector'
  return intent.customer ? 'use-existing-customer' : 'add-customer'
}
