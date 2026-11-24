/**
 * The till's local call record, as the renderer uses it: the «Πρόσφατες
 * κλήσεις» list reads it, and going on from a call's customer search to an
 * order marks that call. Both stay on this till; neither is a server call.
 *
 * Nothing here may stand between a call and its popup, or between staff and
 * an order: every failure is swallowed and the flow goes on.
 */
import { getBridge } from '../../lib'
import type { CallerIdCustomerSearchRequest } from '../hooks/useCallerIdNotifications'
import { normalizeCallerIdSearchPhone } from './caller-id-customer-search'

export type RecentCallPresentation = 'allowed' | 'restricted' | 'unknown'

export interface RecentCall {
  id: string
  /** RFC 3339 UTC. */
  occurredAt: string
  presentation: RecentCallPresentation
  number: string | null
  customerId: string | null
  customerName: string | null
  orderStarted: boolean
}

export interface RecentCalls {
  retentionDays: number
  calls: RecentCall[]
}

interface CallRecordBridge {
  getStatus?: () => Promise<unknown>
  recentCalls?: (options?: { limit?: number }) => Promise<unknown>
  recordCallAction?: (action: CallAction) => Promise<unknown>
}

export interface CallAction {
  callId?: string
  number?: string
  occurredAt?: string
  customerId?: string
}

/** A customer search opened from the list carries the row it came from. */
const RECENT_CALL_REQUEST_PREFIX = 'recent-call:'
/**
 * The key the call notification gives a popup's search:
 * `call:<line>:<time in ms>:<presentation>:<last digits>`
 * (`callerIdEventKey` in `useCallerIdNotifications`). The time is the call's
 * own, the one its row holds.
 */
const POPUP_REQUEST_KEY = /^call:[^:]+:(\d{10,16}):allowed:/

function callRecordBridge(): CallRecordBridge | null {
  try {
    const callerid = (getBridge() as { callerid?: CallRecordBridge } | null)?.callerid
    return callerid && typeof callerid === 'object' ? callerid : null
  } catch {
    return null
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** This build of the till can read its call record. */
export function callRecordReadable(): boolean {
  return typeof callRecordBridge()?.recentCalls === 'function'
}

/**
 * Whether this till records calls now: its Caller ID source is listening, or
 * it has shown a call since it started. Read from the listener's state in
 * memory, never from the database or the server. Any failure reads as "no".
 */
export async function tillRecordsCalls(): Promise<boolean> {
  const bridge = callRecordBridge()
  if (typeof bridge?.getStatus !== 'function' || typeof bridge.recentCalls !== 'function') {
    return false
  }
  try {
    const status = (await bridge.getStatus()) as
      | { status?: unknown; callsDetected?: unknown }
      | null
      | undefined
    return (
      status?.status === 'listening' ||
      (typeof status?.callsDetected === 'number' && status.callsDetected > 0)
    )
  } catch {
    return false
  }
}

function parseRecentCall(value: unknown): RecentCall | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = text(row.id)
  const occurredAt = text(row.occurredAt)
  if (!id || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null
  const number = text(row.number)
  const presentation: RecentCallPresentation =
    row.presentation === 'restricted'
      ? 'restricted'
      : row.presentation === 'allowed' && number
        ? 'allowed'
        : 'unknown'
  return {
    id,
    occurredAt,
    presentation,
    number: presentation === 'allowed' ? number : null,
    customerId: text(row.customerId),
    customerName: text(row.customerName),
    orderStarted: row.orderStarted === true,
  }
}

/** The newest recorded calls. Rejects when the till cannot read them. */
export async function loadRecentCalls(limit?: number): Promise<RecentCalls> {
  const bridge = callRecordBridge()
  if (typeof bridge?.recentCalls !== 'function') {
    throw new Error('call record unavailable')
  }
  const reply = (await bridge.recentCalls(limit ? { limit } : undefined)) as
    | { retentionDays?: unknown; calls?: unknown }
    | null
    | undefined
  if (!reply || !Array.isArray(reply.calls)) {
    throw new Error('call record unreadable')
  }
  return {
    retentionDays:
      typeof reply.retentionDays === 'number' && reply.retentionDays > 0
        ? reply.retentionDays
        : 30,
    calls: reply.calls
      .map(parseRecentCall)
      .filter((call): call is RecentCall => call !== null),
  }
}

/**
 * The customer search a row of the list opens: the same request a call's
 * popup makes, so the same search, the same order hand-off and the same queue
 * behind a search that is already open. `null` for a row without a number.
 */
export function recentCallSearchRequest(
  call: RecentCall,
  nonce: number = Date.now(),
): CallerIdCustomerSearchRequest | null {
  const number = call.presentation === 'allowed' ? text(call.number) : null
  if (!number) return null
  const lookupPhone = normalizeCallerIdSearchPhone(number)
  if (lookupPhone.length < 3) return null
  return {
    displayPhone: number,
    canonicalPhone: number,
    lookupPhone,
    requestKey: `${RECENT_CALL_REQUEST_PREFIX}${call.id}:${nonce}`,
    // The call was displayed when it rang; the list reports nothing.
    onDisplayed: () => {},
  }
}

/** The recorded call a customer search belongs to, or `null` when unknown. */
export function callActionForSearchRequest(
  request: Pick<CallerIdCustomerSearchRequest, 'requestKey' | 'canonicalPhone' | 'displayPhone'> | null | undefined,
): CallAction | null {
  const key = text(request?.requestKey)
  if (!request || !key) return null
  if (key.startsWith(RECENT_CALL_REQUEST_PREFIX)) {
    const rest = key.slice(RECENT_CALL_REQUEST_PREFIX.length)
    const separator = rest.lastIndexOf(':')
    const callId = separator > 0 ? rest.slice(0, separator) : rest
    return callId ? { callId } : null
  }
  const popup = POPUP_REQUEST_KEY.exec(key)
  const number = text(request.canonicalPhone) ?? text(request.displayPhone)
  if (!popup || !number) return null
  const occurredAt = new Date(Number(popup[1]))
  if (Number.isNaN(occurredAt.getTime())) return null
  return { number, occurredAt: occurredAt.toISOString() }
}

/**
 * Staff went on from this customer search to an order: the call's row says so
 * from now on. Never throws and never waits: it is called on the way to the
 * order, and the order goes on whatever happens here.
 */
export function recordCallerIdOrderStarted(
  request: CallerIdCustomerSearchRequest | null | undefined,
  customer: { id?: unknown } | null | undefined,
): void {
  try {
    const action = callActionForSearchRequest(request)
    const bridge = callRecordBridge()
    if (!action || typeof bridge?.recordCallAction !== 'function') return
    const customerId =
      text(customer?.id) ?? (typeof customer?.id === 'number' ? String(customer.id) : null)
    const pending = bridge.recordCallAction({
      ...action,
      ...(customerId ? { customerId } : {}),
    }) as Promise<unknown> | undefined
    if (pending && typeof pending.then === 'function') {
      void pending.then(undefined, () => undefined)
    }
  } catch {
    // The order goes on.
  }
}
