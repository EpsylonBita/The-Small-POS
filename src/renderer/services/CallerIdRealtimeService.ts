/**
 * Private, terminal-scoped Caller ID Realtime subscriptions.
 *
 * Configuration is reconciled continuously so a prepared setup line can be
 * subscribed and acknowledged without restarting the POS.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { posApiGet, posApiPost } from '../utils/api-helpers'
import {
  createCallerIdPrivateChannel,
  parseCallerIdReceivingLine,
  type CallerIdReceivingLine,
} from './caller-id-private-channel'

export interface CallerIdBroadcastEvent {
  callerNumber: string
  callerName?: string | null
  customer?: {
    id: string
    name?: string | null
    phone?: string | null
    email?: string | null
    address?: string | null
    is_banned?: boolean
    notes?: string | null
  } | null
  sipCallId: string
  timestamp: string
  sourceTerminalId?: string | null
  lineId?: string
  lineName?: string
  presentation?: 'allowed' | 'restricted' | 'unknown'
  reportReceipt?: (receipt: CallerIdReceipt) => Promise<boolean>
}

interface CallerIdRealtimePayload {
  eventId: string
  lineId: string
  lineName: string
  callerNumber: string | null
  presentation: 'allowed' | 'restricted' | 'unknown'
  occurredAt: string
}

interface ReadinessAttempt {
  attemptId: string
  lineVersion: number
  expiresAt: string
}

interface ReceivingLineConfig {
  line: CallerIdReceivingLine
  version: number
  readinessAttempt?: ReadinessAttempt
}

interface CallerIdPosConfig {
  receivingLines?: unknown[]
}

interface ActiveSubscription {
  config: ReceivingLineConfig
  channel: RealtimeChannel
  subscribed: boolean
}

type CallerIdEventCallback = (event: CallerIdBroadcastEvent) => void
export type CallerIdRealtimeClient = Pick<
  SupabaseClient,
  'channel' | 'removeChannel'
> & {
  isTopicRetiring?(topic: string): boolean
}
export type CallerIdReceipt =
  | { status: 'received' }
  | { status: 'displayed' }
  | {
      status: 'failed'
      failureCode:
        | 'DISPLAY_FAILED'
        | 'INVALID_EVENT_PAYLOAD'
        | 'LOCAL_STORAGE_FAILED'
        | 'CLIENT_RUNTIME_ERROR'
    }

const DELIVERY_TTL_MS = 30_000
const CONFIG_POLL_MS = 1_000
const CHANNEL_RETRY_BASE_MS = 1_000
const CHANNEL_RETRY_MAX_MS = 30_000
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, 'i')

function parseReceivingLineConfig(value: unknown): ReceivingLineConfig | null {
  const line = parseCallerIdReceivingLine(value)
  if (!line || !value || typeof value !== 'object') return null
  const wire = value as {
    version?: unknown
    readinessAttempt?: {
      attemptId?: unknown
      lineVersion?: unknown
      expiresAt?: unknown
    }
  }
  if (!Number.isSafeInteger(wire.version) || Number(wire.version) <= 0) {
    return null
  }
  const attempt = wire.readinessAttempt
  if (!attempt) {
    return { line, version: Number(wire.version) }
  }
  if (
    typeof attempt.attemptId !== 'string' ||
    !UUID_REGEX.test(attempt.attemptId) ||
    !Number.isSafeInteger(attempt.lineVersion) ||
    Number(attempt.lineVersion) !== Number(wire.version) ||
    typeof attempt.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(attempt.expiresAt))
  ) {
    return null
  }
  return {
    line,
    version: Number(wire.version),
    readinessAttempt: {
      attemptId: attempt.attemptId,
      lineVersion: Number(attempt.lineVersion),
      expiresAt: attempt.expiresAt,
    },
  }
}

function parseFreshEvent(
  value: unknown,
  expectedLine: CallerIdReceivingLine,
): CallerIdBroadcastEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as CallerIdRealtimePayload
  if (
    !UUID_REGEX.test(event.eventId) ||
    event.lineId !== expectedLine.id ||
    typeof event.lineName !== 'string' ||
    !['allowed', 'restricted', 'unknown'].includes(event.presentation) ||
    (event.callerNumber !== null &&
      (typeof event.callerNumber !== 'string' || event.callerNumber.length === 0))
  ) {
    return null
  }

  const occurredAt = Date.parse(event.occurredAt)
  if (
    !Number.isFinite(occurredAt) ||
    Date.now() - occurredAt > DELIVERY_TTL_MS ||
    occurredAt - Date.now() > 5_000
  ) {
    return null
  }

  return {
    callerNumber: event.callerNumber ?? 'Private number',
    callerName: null,
    customer: null,
    sipCallId: event.eventId,
    timestamp: event.occurredAt,
    lineId: event.lineId,
    lineName: expectedLine.name,
    presentation: event.presentation,
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function reportCallerIdReceipt(
  eventId: string,
  receipt: CallerIdReceipt,
  occurredAt?: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!UUID_REGEX.test(eventId)) return false
  const occurred = occurredAt ? Date.parse(occurredAt) : Date.now()
  const deadline = Number.isFinite(occurred)
    ? occurred + DELIVERY_TTL_MS
    : Date.now()
  const backoff = [0, 250, 750]
  for (const waitMs of backoff) {
    if (!isCurrent()) return false
    if (waitMs > 0) await delay(waitMs)
    if (!isCurrent() || Date.now() >= deadline) return false
    try {
      const result = await posApiPost(
        `/api/pos/caller-id/events/${eventId}/receipt`,
        receipt,
      )
      if (result.success) return true
    } catch {
      // Retry only inside the immutable event delivery window.
    }
  }
  return false
}

/**
 * Subscribe to every line selected for this terminal and continuously
 * reconcile prepared tests. Cleanup is valid immediately.
 */
export function subscribeToCallerIdEvents(
  client: CallerIdRealtimeClient,
  organizationId: string,
  terminalId: string,
  onEvent: CallerIdEventCallback,
  isIdentityCurrent: () => boolean = () => true,
): () => void {
  if (!organizationId || !terminalId) return () => {}

  const seen = new Map<string, number>()
  const channels = new Map<string, ActiveSubscription>()
  const acknowledged = new Set<string>()
  const retryAttempts = new Map<string, number>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingRemovals = new Map<string, Promise<unknown>>()
  let disposed = false
  let refreshInFlight = false
  let configInterval: ReturnType<typeof setInterval> | null = null
  let cleanupInterval: ReturnType<typeof setInterval> | null = null

  const identityCurrent = () => {
    try {
      return isIdentityCurrent()
    } catch {
      return false
    }
  }

  const clearRetry = (lineId: string) => {
    const retryTimer = retryTimers.get(lineId)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimers.delete(lineId)
    retryAttempts.delete(lineId)
  }

  const scheduleRetry = (lineId: string) => {
    if (disposed || retryTimers.has(lineId)) return
    const attempt = (retryAttempts.get(lineId) ?? 0) + 1
    retryAttempts.set(lineId, attempt)
    const retryDelay = Math.min(
      CHANNEL_RETRY_MAX_MS,
      CHANNEL_RETRY_BASE_MS * 2 ** (attempt - 1),
    )
    const retryTimer = setTimeout(() => {
      retryTimers.delete(lineId)
      if (!disposed && identityCurrent()) {
        void refresh()
      }
    }, retryDelay)
    retryTimers.set(lineId, retryTimer)
  }

  const retireChannel = (
    lineId: string,
    active: ActiveSubscription,
  ) => {
    if (channels.get(lineId) === active) {
      channels.delete(lineId)
    }
    if (pendingRemovals.has(lineId)) return

    let removal: Promise<unknown>
    try {
      removal = Promise.resolve(client.removeChannel(active.channel)).catch(
        () => undefined,
      )
    } catch {
      removal = Promise.resolve()
    }
    pendingRemovals.set(lineId, removal)
    void removal.finally(() => {
      if (pendingRemovals.get(lineId) !== removal) return
      pendingRemovals.delete(lineId)
      if (
        !disposed &&
        identityCurrent() &&
        !retryTimers.has(lineId)
      ) {
        void refresh()
      }
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (configInterval) clearInterval(configInterval)
    if (cleanupInterval) clearInterval(cleanupInterval)
    seen.clear()
    acknowledged.clear()
    for (const retryTimer of retryTimers.values()) {
      clearTimeout(retryTimer)
    }
    retryTimers.clear()
    retryAttempts.clear()
    pendingRemovals.clear()
    for (const { channel } of channels.values()) {
      void client.removeChannel(channel)
    }
    channels.clear()
  }

  const acknowledge = async (active: ActiveSubscription) => {
    const attempt = active.config.readinessAttempt
    if (
      disposed ||
      !identityCurrent() ||
      !active.subscribed ||
      !attempt ||
      Date.parse(attempt.expiresAt) <= Date.now()
    ) {
      return
    }
    const key = `${attempt.attemptId}:${attempt.lineVersion}`
    if (acknowledged.has(key)) return
    try {
      const result = await posApiPost('/api/pos/caller-id/readiness', {
        attemptId: attempt.attemptId,
        lineId: active.config.line.id,
        lineVersion: attempt.lineVersion,
      })
      if (!disposed && identityCurrent() && result.success) {
        acknowledged.add(key)
      }
    } catch {
      // The next bounded config reconciliation retries while the attempt lives.
    }
  }

  const refresh = async () => {
    if (disposed || refreshInFlight) return
    if (!identityCurrent()) {
      dispose()
      return
    }
    refreshInFlight = true
    try {
      const result = await posApiGet<CallerIdPosConfig>(
        '/api/pos/caller-id/config',
      )
      if (disposed) return
      if (!identityCurrent()) {
        dispose()
        return
      }
      if (!result.success) return
      const desired = new Map<string, ReceivingLineConfig>()
      for (const value of result.data?.receivingLines ?? []) {
        const parsed = parseReceivingLineConfig(value)
        if (parsed) desired.set(parsed.line.id, parsed)
      }

      for (const lineId of retryAttempts.keys()) {
        if (!desired.has(lineId)) clearRetry(lineId)
      }

      for (const [lineId, active] of channels) {
        const next = desired.get(lineId)
        if (!next || next.line.name !== active.config.line.name) {
          clearRetry(lineId)
          retireChannel(lineId, active)
          continue
        }
        active.config = next
        void acknowledge(active)
      }

      for (const config of desired.values()) {
        if (
          disposed ||
          !identityCurrent() ||
          channels.has(config.line.id) ||
          retryTimers.has(config.line.id) ||
          pendingRemovals.has(config.line.id) ||
          client.isTopicRetiring?.(`callerid:line:${config.line.id}`) === true
        ) {
          continue
        }
        let active: ActiveSubscription | undefined
        try {
          const channel = createCallerIdPrivateChannel(client, config.line)
            .on(
              'broadcast',
              { event: 'caller_id' },
              (message: { payload?: unknown }) => {
                if (
                  disposed ||
                  !identityCurrent() ||
                  !active ||
                  channels.get(config.line.id) !== active
                ) {
                  return
                }
                const event = parseFreshEvent(
                  message?.payload,
                  active.config.line,
                )
                if (!event || seen.has(event.sipCallId)) return
                const acceptedSubscription = active
                const isCurrent = () =>
                  !disposed &&
                  identityCurrent() &&
                  channels.get(config.line.id) === acceptedSubscription
                const acceptedEvent: CallerIdBroadcastEvent = {
                  ...event,
                  reportReceipt: (receipt) =>
                    reportCallerIdReceipt(
                      event.sipCallId,
                      receipt,
                      event.timestamp,
                      isCurrent,
                    ),
                }
                const deliveryDeadline =
                  Date.parse(event.timestamp) + DELIVERY_TTL_MS
                seen.set(event.sipCallId, Date.now())
                void acceptedEvent.reportReceipt!({ status: 'received' })
                if (!isCurrent() || Date.now() >= deliveryDeadline) {
                  return
                }
                try {
                  onEvent(acceptedEvent)
                } catch {
                  void acceptedEvent.reportReceipt!({
                    status: 'failed',
                    failureCode: 'CLIENT_RUNTIME_ERROR',
                  })
                }
              },
            )
          active = { config, channel, subscribed: false }
          channels.set(config.line.id, active)
          channel.subscribe((status, error) => {
            if (
              disposed ||
              !identityCurrent() ||
              !active ||
              channels.get(config.line.id) !== active
            ) {
              return
            }
            if (status === 'SUBSCRIBED') {
              active.subscribed = true
              clearRetry(config.line.id)
              void acknowledge(active)
            } else if (
              status === 'CHANNEL_ERROR' ||
              status === 'TIMED_OUT' ||
              status === 'CLOSED'
            ) {
              active.subscribed = false
              retireChannel(config.line.id, active)
              scheduleRetry(config.line.id)
              console.warn('[CallerIdRealtimeService] Subscription error', {
                organizationId,
                terminalId,
                lineId: config.line.id,
                status,
                error,
              })
            }
          })
        } catch {
          if (active && channels.get(config.line.id) === active) {
            retireChannel(config.line.id, active)
          }
          scheduleRetry(config.line.id)
        }
      }
    } catch {
      // Config polling is self-healing and intentionally logs no caller data.
    } finally {
      refreshInFlight = false
    }
  }

  void refresh()
  if (disposed) return dispose
  configInterval = setInterval(() => void refresh(), CONFIG_POLL_MS)
  cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [eventId, receivedAt] of seen) {
      if (now - receivedAt > DELIVERY_TTL_MS) seen.delete(eventId)
    }
    for (const key of acknowledged) {
      const attemptId = key.split(':')[0]
      const stillPresent = [...channels.values()].some(
        (active) =>
          active.config.readinessAttempt?.attemptId === attemptId &&
          Date.parse(active.config.readinessAttempt.expiresAt) > now,
      )
      if (!stillPresent) acknowledged.delete(key)
    }
  }, DELIVERY_TTL_MS)

  return dispose
}
