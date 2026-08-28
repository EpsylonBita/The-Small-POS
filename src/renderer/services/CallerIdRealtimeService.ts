/**
 * Private, terminal-scoped Caller ID delivery.
 *
 * The strict terminal API is the continuous safety path. Private Realtime is
 * an optional low-latency accelerator, so a failed or unavailable channel
 * cannot suppress selected-line delivery.
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
  countryCode?: string
  presentation?: 'allowed' | 'restricted' | 'unknown'
  reportReceipt?: (receipt: CallerIdReceipt) => Promise<boolean>
}

interface CallerIdRealtimePayload {
  eventId: string
  lineId: string
  lineName: string
  lineVersion: number
  callerNumber: string | null
  presentation: 'allowed' | 'restricted' | 'unknown'
  occurredAt: string
}

interface CallerIdPolledPayload extends CallerIdRealtimePayload {
  deliveryExpiresAt: string
}

interface CallerIdPosEventsResponse {
  serverTime?: unknown
  events?: unknown
}

interface ParsedCallerIdEvent {
  event: CallerIdBroadcastEvent
  deliveryDeadline: number
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
// A terminal with NO receiving lines configured has nothing to reconcile —
// yet the 1s config poll hammered /api/pos/caller-id/config ~95×/min per
// terminal in production (field observation, 28/08) on tills that never set
// up caller id. Idle terminals back off to this cadence; the moment a config
// poll returns a line (or anything is pending) the full 1s reconciliation
// cadence resumes, so recognition and the line-readiness wizard are
// untouched where caller id is actually in use.
const CONFIG_IDLE_POLL_MS = 60_000
const CONFIG_IDLE_POLLS_BEFORE_BACKOFF = 5
const EVENT_POLL_MS = 1_000
const MAX_POLLED_EVENTS = 50
const CHANNEL_RETRY_BASE_MS = 1_000
const CHANNEL_RETRY_MAX_MS = 30_000
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, 'i')
const E164_REGEX = /^\+[1-9]\d{1,14}$/

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
  expectedLineVersion: number,
  referenceTime = Date.now(),
): CallerIdBroadcastEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as CallerIdRealtimePayload
  if (
    !UUID_REGEX.test(event.eventId) ||
    event.lineId !== expectedLine.id ||
    typeof event.lineName !== 'string' ||
    event.lineName.length === 0 ||
    !Number.isSafeInteger(event.lineVersion) ||
    event.lineVersion <= 0 ||
    event.lineVersion !== expectedLineVersion ||
    !['allowed', 'restricted', 'unknown'].includes(event.presentation) ||
    (event.presentation === 'allowed'
      ? typeof event.callerNumber !== 'string' ||
        !E164_REGEX.test(event.callerNumber)
      : event.callerNumber !== null)
  ) {
    return null
  }

  const occurredAt = Date.parse(event.occurredAt)
  if (
    !Number.isFinite(occurredAt) ||
    referenceTime - occurredAt > DELIVERY_TTL_MS ||
    occurredAt - referenceTime > 5_000
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
    ...(expectedLine.countryCode
      ? { countryCode: expectedLine.countryCode }
      : {}),
    presentation: event.presentation,
  }
}

function sameReceivingLineVersion(
  left: ReceivingLineConfig | undefined,
  right: ReceivingLineConfig,
): boolean {
  return Boolean(
    left &&
      left.line.id === right.line.id &&
      left.line.name === right.line.name &&
      left.line.countryCode === right.line.countryCode &&
      left.version === right.version,
  )
}

function sameReceivingLineConfig(
  left: ReceivingLineConfig | undefined,
  right: ReceivingLineConfig,
): boolean {
  return Boolean(
    left &&
      sameReceivingLineVersion(left, right) &&
      left.readinessAttempt?.attemptId === right.readinessAttempt?.attemptId &&
      left.readinessAttempt?.lineVersion ===
        right.readinessAttempt?.lineVersion &&
      left.readinessAttempt?.expiresAt === right.readinessAttempt?.expiresAt,
  )
}

function parsePolledEvents(
  value: unknown,
  requestedLines: Map<string, ReceivingLineConfig>,
  pollStartedAt: number,
): ParsedCallerIdEvent[] | null {
  if (!value || typeof value !== 'object') return null
  const response = value as CallerIdPosEventsResponse
  if (typeof response.serverTime !== 'string' || !Array.isArray(response.events)) {
    return null
  }
  const serverTime = Date.parse(response.serverTime)
  if (
    !Number.isFinite(serverTime) ||
    response.events.length > MAX_POLLED_EVENTS
  ) {
    return null
  }

  const parsed: ParsedCallerIdEvent[] = []
  const responseEventIds = new Set<string>()
  for (const value of response.events) {
    if (!value || typeof value !== 'object') return null
    const payload = value as CallerIdPolledPayload
    const deliveryExpiresAt = Date.parse(payload.deliveryExpiresAt)
    if (
      typeof payload.lineId !== 'string' ||
      !UUID_REGEX.test(payload.lineId) ||
      typeof payload.lineName !== 'string' ||
      payload.lineName.length === 0 ||
      !Number.isSafeInteger(payload.lineVersion) ||
      payload.lineVersion <= 0 ||
      typeof payload.deliveryExpiresAt !== 'string' ||
      !Number.isFinite(deliveryExpiresAt) ||
      deliveryExpiresAt <= serverTime ||
      deliveryExpiresAt - serverTime > DELIVERY_TTL_MS ||
      responseEventIds.has(payload.eventId)
    ) {
      return null
    }
    const wireEvent = parseFreshEvent(
      payload,
      { id: payload.lineId, name: payload.lineName },
      payload.lineVersion,
      serverTime,
    )
    if (!wireEvent) return null
    responseEventIds.add(payload.eventId)
    const expected = requestedLines.get(payload.lineId)
    if (!expected || payload.lineVersion !== expected.version) {
      continue
    }
    parsed.push({
      event: { ...wireEvent, lineName: expected.line.name },
      deliveryDeadline:
        pollStartedAt +
        Math.min(DELIVERY_TTL_MS, deliveryExpiresAt - serverTime),
    })
  }
  return parsed
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now()
}

export async function reportCallerIdReceipt(
  eventId: string,
  receipt: CallerIdReceipt,
  occurredAt?: string,
  isCurrent: () => boolean = () => true,
  deliveryDeadline?: number,
): Promise<boolean> {
  if (!UUID_REGEX.test(eventId)) return false
  const occurred = occurredAt ? Date.parse(occurredAt) : Date.now()
  const deadline =
    typeof deliveryDeadline === 'number' && Number.isFinite(deliveryDeadline)
      ? deliveryDeadline
      : Number.isFinite(occurred)
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
 * Deliver every line selected for this terminal and continuously reconcile
 * prepared tests. Cleanup is valid immediately.
 */
export function subscribeToCallerIdEvents(
  client: CallerIdRealtimeClient | null,
  organizationId: string,
  terminalId: string,
  onEvent: CallerIdEventCallback,
  isIdentityCurrent: () => boolean = () => true,
): () => void {
  if (!organizationId || !terminalId) return () => {}

  const seen = new Map<string, number>()
  const channels = new Map<string, ActiveSubscription>()
  const desiredLines = new Map<string, ReceivingLineConfig>()
  const fallbackLineIds = new Set<string>()
  const pendingCatchupLineIds = new Set<string>()
  const postAttemptCatchupUntil = new Map<string, number>()
  const acknowledged = new Set<string>()
  const acknowledging = new Set<string>()
  const retryAttempts = new Map<string, number>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingRemovals = new Map<string, Promise<unknown>>()
  let disposed = false
  let refreshInFlight = false
  let eventPollInFlight = false
  let nextEventPollAt = 0
  // Non-zero while the terminal has no caller-id state at all — the config
  // poll idles until this deadline instead of firing every second. The
  // backoff arms only after several consecutive empty polls, so startup and
  // first-line discovery keep the fast cadence.
  let configIdleUntil = 0
  let consecutiveIdlePolls = 0
  let catchupRevision = 0
  let configInterval: ReturnType<typeof setInterval> | null = null
  let eventPollInterval: ReturnType<typeof setInterval> | null = null
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

    if (!client) return

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
    if (eventPollInterval) clearInterval(eventPollInterval)
    if (cleanupInterval) clearInterval(cleanupInterval)
    seen.clear()
    desiredLines.clear()
    fallbackLineIds.clear()
    pendingCatchupLineIds.clear()
    postAttemptCatchupUntil.clear()
    acknowledged.clear()
    acknowledging.clear()
    for (const retryTimer of retryTimers.values()) {
      clearTimeout(retryTimer)
    }
    retryTimers.clear()
    retryAttempts.clear()
    pendingRemovals.clear()
    if (client) {
      for (const { channel } of channels.values()) {
        void client.removeChannel(channel)
      }
    }
    channels.clear()
  }

  const isDesiredConfigCurrent = (config: ReceivingLineConfig) =>
    !disposed &&
    identityCurrent() &&
    sameReceivingLineConfig(desiredLines.get(config.line.id), config)

  const isDesiredLineCurrent = (config: ReceivingLineConfig) =>
    !disposed &&
    identityCurrent() &&
    sameReceivingLineVersion(desiredLines.get(config.line.id), config)

  const acknowledge = async (
    config: ReceivingLineConfig,
    transportReady: boolean,
  ) => {
    const attempt = config.readinessAttempt
    if (
      disposed ||
      !identityCurrent() ||
      !transportReady ||
      !isDesiredConfigCurrent(config) ||
      !attempt ||
      Date.parse(attempt.expiresAt) <= Date.now()
    ) {
      return
    }
    const key = `${attempt.attemptId}:${attempt.lineVersion}`
    if (acknowledged.has(key) || acknowledging.has(key)) return
    acknowledging.add(key)
    try {
      const result = await posApiPost('/api/pos/caller-id/readiness', {
        attemptId: attempt.attemptId,
        lineId: config.line.id,
        lineVersion: attempt.lineVersion,
      })
      if (isDesiredConfigCurrent(config) && result.success) {
        acknowledged.add(key)
      }
    } catch {
      // The next bounded config reconciliation retries while the attempt lives.
    } finally {
      acknowledging.delete(key)
    }
  }

  const deliverEvent = (
    event: CallerIdBroadcastEvent,
    deliveryDeadline: number,
    isCurrent: () => boolean,
  ) => {
    if (
      !isCurrent() ||
      Date.now() >= deliveryDeadline ||
      seen.has(event.sipCallId)
    ) {
      return
    }
    const acceptedEvent: CallerIdBroadcastEvent = {
      ...event,
      reportReceipt: (receipt) =>
        reportCallerIdReceipt(
          event.sipCallId,
          receipt,
          event.timestamp,
          isCurrent,
          deliveryDeadline,
        ),
    }
    seen.set(event.sipCallId, Date.now())
    void acceptedEvent.reportReceipt!({ status: 'received' })
    if (!isCurrent() || Date.now() >= deliveryDeadline) return
    try {
      onEvent(acceptedEvent)
    } catch {
      void acceptedEvent.reportReceipt!({
        status: 'failed',
        failureCode: 'CLIENT_RUNTIME_ERROR',
      })
    }
  }

  const shouldPollEvents = () => {
    return desiredLines.size > 0
  }

  const pollPendingEvents = async () => {
    const cadenceTime = monotonicNow()
    if (
      disposed ||
      eventPollInFlight ||
      !identityCurrent() ||
      !shouldPollEvents() ||
      cadenceTime < nextEventPollAt
    ) {
      return
    }
    const pollStartedAt = Date.now()
    const requestedLines = new Map(desiredLines)
    const requestedCatchupRevision = catchupRevision
    nextEventPollAt = cadenceTime + EVENT_POLL_MS
    eventPollInFlight = true
    try {
      const result = await posApiGet<CallerIdPosEventsResponse>(
        '/api/pos/caller-id/events',
      )
      if (disposed || !identityCurrent()) return
      if (!result.success) {
        if (result.status === 429) {
          nextEventPollAt = Math.max(
            nextEventPollAt,
            monotonicNow() + 5 * EVENT_POLL_MS,
          )
        }
        return
      }
      const parsed = parsePolledEvents(
        result.data,
        requestedLines,
        pollStartedAt,
      )
      if (!parsed) return

      for (const config of requestedLines.values()) {
        void acknowledge(config, true)
      }
      for (const { event, deliveryDeadline } of parsed) {
        const acceptedConfig = requestedLines.get(event.lineId ?? '')
        if (!acceptedConfig) continue
        const isCurrent = () => isDesiredLineCurrent(acceptedConfig)
        deliverEvent(event, deliveryDeadline, isCurrent)
      }
      for (const [lineId, config] of requestedLines) {
        if (!isDesiredLineCurrent(config)) continue
        if (
          requestedCatchupRevision === catchupRevision &&
          channels.get(lineId)?.subscribed
        ) {
          pendingCatchupLineIds.delete(lineId)
          fallbackLineIds.delete(lineId)
        }
      }
    } catch {
      // A later bounded poll retries without logging caller data.
    } finally {
      eventPollInFlight = false
      if (shouldPollEvents()) {
        void pollPendingEvents()
      }
    }
  }

  const refresh = async () => {
    if (disposed) return
    if (!identityCurrent()) {
      dispose()
      return
    }
    if (refreshInFlight) return
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
      const nextDesired = new Map<string, ReceivingLineConfig>()
      for (const value of result.data?.receivingLines ?? []) {
        const parsed = parseReceivingLineConfig(value)
        if (parsed) nextDesired.set(parsed.line.id, parsed)
      }

      const previousDesired = new Map(desiredLines)
      const now = Date.now()
      for (const [lineId, previous] of previousDesired) {
        if (nextDesired.has(lineId)) continue

        const existingCatchupUntil = postAttemptCatchupUntil.get(lineId) ?? 0
        if (previous.readinessAttempt) {
          postAttemptCatchupUntil.set(lineId, now + DELIVERY_TTL_MS)
          nextDesired.set(lineId, {
            line: previous.line,
            version: previous.version,
          })
        } else if (existingCatchupUntil > now) {
          nextDesired.set(lineId, previous)
        }
      }
      for (const lineId of retryAttempts.keys()) {
        if (!nextDesired.has(lineId)) clearRetry(lineId)
      }
      for (const lineId of fallbackLineIds) {
        if (!nextDesired.has(lineId)) fallbackLineIds.delete(lineId)
      }
      for (const lineId of pendingCatchupLineIds) {
        if (!nextDesired.has(lineId)) pendingCatchupLineIds.delete(lineId)
      }
      for (const lineId of postAttemptCatchupUntil.keys()) {
        if (!nextDesired.has(lineId)) postAttemptCatchupUntil.delete(lineId)
      }
      desiredLines.clear()
      for (const [lineId, config] of nextDesired) {
        desiredLines.set(lineId, config)
        const previous = previousDesired.get(lineId)
        if (
          previous?.readinessAttempt &&
          !config.readinessAttempt &&
          sameReceivingLineVersion(previous, config)
        ) {
          postAttemptCatchupUntil.set(lineId, Date.now() + DELIVERY_TTL_MS)
        } else if (!sameReceivingLineVersion(previous, config)) {
          postAttemptCatchupUntil.delete(lineId)
        }
        if (
          !previous ||
          previous.version !== config.version ||
          previous.line.name !== config.line.name
        ) {
          pendingCatchupLineIds.add(lineId)
          catchupRevision += 1
        }
      }

      for (const [lineId, active] of channels) {
        const next = desiredLines.get(lineId)
        if (
          !next ||
          next.line.name !== active.config.line.name ||
          next.version !== active.config.version
        ) {
          clearRetry(lineId)
          retireChannel(lineId, active)
          continue
        }
        active.config = next
        void acknowledge(active.config, active.subscribed)
      }

      for (const config of desiredLines.values()) {
        if (
          disposed ||
          !identityCurrent() ||
          !client ||
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
                  active.config.version,
                )
                if (!event || seen.has(event.sipCallId)) return
                const acceptedSubscription = active
                const isCurrent = () =>
                  !disposed &&
                  identityCurrent() &&
                  channels.get(config.line.id) === acceptedSubscription
                const deliveryDeadline =
                  Date.parse(event.timestamp) + DELIVERY_TTL_MS
                deliverEvent(event, deliveryDeadline, isCurrent)
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
              const joined = !active.subscribed
              active.subscribed = true
              if (joined) {
                pendingCatchupLineIds.add(config.line.id)
                catchupRevision += 1
              }
              clearRetry(config.line.id)
              void acknowledge(active.config, true)
              void pollPendingEvents()
            } else if (
              status === 'CHANNEL_ERROR' ||
              status === 'TIMED_OUT' ||
              status === 'CLOSED'
            ) {
              active.subscribed = false
              fallbackLineIds.add(config.line.id)
              retireChannel(config.line.id, active)
              scheduleRetry(config.line.id)
              void pollPendingEvents()
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
          fallbackLineIds.add(config.line.id)
          void pollPendingEvents()
        }
      }
      void pollPendingEvents()
      // No lines, no channels, nothing pending: this terminal has caller id
      // idle — after a few consecutive empty polls, back the config poll
      // off. Any live state keeps the full 1s reconciliation cadence.
      const callerIdIdle =
        desiredLines.size === 0 &&
        channels.size === 0 &&
        retryTimers.size === 0 &&
        pendingRemovals.size === 0 &&
        postAttemptCatchupUntil.size === 0
      if (callerIdIdle) {
        consecutiveIdlePolls += 1
        configIdleUntil =
          consecutiveIdlePolls >= CONFIG_IDLE_POLLS_BEFORE_BACKOFF
            ? monotonicNow() + CONFIG_IDLE_POLL_MS
            : 0
      } else {
        consecutiveIdlePolls = 0
        configIdleUntil = 0
      }
    } catch {
      // Config polling is self-healing and intentionally logs no caller data.
    } finally {
      refreshInFlight = false
    }
  }

  void refresh()
  if (disposed) return dispose
  configInterval = setInterval(() => {
    if (monotonicNow() < configIdleUntil) return
    void refresh()
  }, CONFIG_POLL_MS)
  eventPollInterval = setInterval(
    () => void pollPendingEvents(),
    EVENT_POLL_MS,
  )
  cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [eventId, receivedAt] of seen) {
      if (now - receivedAt > DELIVERY_TTL_MS) seen.delete(eventId)
    }
    for (const [lineId, catchupUntil] of postAttemptCatchupUntil) {
      if (catchupUntil <= now) postAttemptCatchupUntil.delete(lineId)
    }
    for (const key of acknowledged) {
      const attemptId = key.split(':')[0]
      const stillPresent = [...desiredLines.values()].some(
        (config) =>
          config.readinessAttempt?.attemptId === attemptId &&
          Date.parse(config.readinessAttempt.expiresAt) > now,
      )
      if (!stillPresent) acknowledged.delete(key)
    }
  }, DELIVERY_TTL_MS)

  return dispose
}
