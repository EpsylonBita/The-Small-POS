/**
 * useCallerIdNotifications — Displays validated local Caller ID events
 * immediately, then merges their terminal-scoped cloud delivery evidence.
 * Legacy native SIP events are intentionally outside this hook.
 *
 * Gated by `plugin_integrations`; caller_id itself is a plugin integration.
 */
import { useEffect, useRef, useCallback } from 'react'
import { offEvent, onEvent } from '../../lib'
import { useModules } from '../contexts/module-context'
import { getCachedTerminalCredentials } from '../services/terminal-credentials'
import {
  subscribeToCallerIdEvents,
  type CallerIdBroadcastEvent,
  type CallerIdReceipt,
  type CallerIdRealtimeClient,
} from '../services/CallerIdRealtimeService'
import { showCallerIdToast } from '../components/callerid/CallerIdPopup'
import { navigateToCallerIdCustomerSearch } from '../services/caller-id-customer-search'

interface CallerIdNotificationsOptions {
  realtimeReady?: boolean
  realtimeClient?: CallerIdRealtimeClient | null
}

interface AcceptedCallState {
  event: CallerIdBroadcastEvent
  completion: CallerIdReceipt | null
  receiptReported: boolean
}

interface ValidatedLocalCallPayload {
  schemaVersion: number
  sourceId: string
  sourceVersion: number
  lineId: string
  lineName: string
  lineVersion: number
  providerEventId: string
  callerNumber: string | null
  presentation: 'allowed' | 'restricted'
  occurredAt: string
}

const VALIDATED_LOCAL_CALL_CHANNEL = 'callerid:validated-local-call'
const LOCAL_EVENT_TTL_MS = 30_000
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOCAL_PHONE_REGEX = /^\+?\d{3,32}$/
const PROVIDER_EVENT_ID_REGEX = /^[\x21-\x7e]{1,255}$/
const LOCAL_PAYLOAD_KEYS = [
  'callerNumber',
  'lineId',
  'lineName',
  'lineVersion',
  'occurredAt',
  'presentation',
  'providerEventId',
  'schemaVersion',
  'sourceId',
  'sourceVersion',
] as const

export function useCallerIdNotifications(options?: CallerIdNotificationsOptions) {
  const { isModuleEnabled } = useModules()
  const enabled = isModuleEnabled('plugin_integrations' as any)
  const realtimeReady = options?.realtimeReady === true
  const realtimeClient = options?.realtimeClient ?? null
  const callEventsRef = useRef(new Map<string, AcceptedCallState>())
  const cleanupTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const handleCallEvent = useCallback((event: CallerIdBroadcastEvent) => {
    const eventKey = callerIdEventKey(event)
    const existing = callEventsRef.current.get(eventKey)
    if (existing) {
      existing.event = mergeCallerIdEvent(existing.event, event)
      flushCallerIdCompletion(existing)
      return
    }

    const accepted: AcceptedCallState = {
      event: mergeCallerIdEvent(undefined, event),
      completion: null,
      receiptReported: false,
    }
    callEventsRef.current.set(eventKey, accepted)

    const existingTimer = cleanupTimersRef.current.get(eventKey)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const cleanupTimer = setTimeout(() => {
      callEventsRef.current.delete(eventKey)
      cleanupTimersRef.current.delete(eventKey)
    }, LOCAL_EVENT_TTL_MS)
    cleanupTimersRef.current.set(eventKey, cleanupTimer)

    try {
      showCallerIdToast(accepted.event, {
        onSearchCustomer: () =>
          navigateToCallerIdCustomerSearch(accepted.event.callerNumber),
        onDisplayed: () => {
          accepted.completion ??= { status: 'displayed' }
          flushCallerIdCompletion(accepted)
        },
      })
    } catch {
      accepted.completion = {
        status: 'failed',
        failureCode: 'DISPLAY_FAILED',
      }
      flushCallerIdCompletion(accepted)
    }
  }, [])

  useEffect(() => {
    const clearAcceptedEvents = () => {
      cleanupTimersRef.current.forEach((timer) => clearTimeout(timer))
      cleanupTimersRef.current.clear()
      callEventsRef.current.clear()
    }

    if (!enabled) {
      clearAcceptedEvents()
      return
    }

    return clearAcceptedEvents
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const handleValidatedLocalCall = (payload: unknown) => {
      const event = parseValidatedLocalCall(payload)
      if (event) {
        handleCallEvent(event)
      }
    }
    onEvent(VALIDATED_LOCAL_CALL_CHANNEL, handleValidatedLocalCall)
    return () => {
      offEvent(VALIDATED_LOCAL_CALL_CHANNEL, handleValidatedLocalCall)
    }
  }, [enabled, handleCallEvent])

  useEffect(() => {
    if (!enabled || !realtimeReady || !realtimeClient) {
      return
    }

    const creds = getCachedTerminalCredentials()
    if (!creds.organizationId || !creds.branchId) {
      return
    }

    return subscribeToCallerIdEvents(
      realtimeClient,
      creds.organizationId,
      creds.terminalId,
      handleCallEvent,
      () => {
        const current = getCachedTerminalCredentials()
        return (
          current.organizationId === creds.organizationId &&
          current.terminalId === creds.terminalId &&
          current.branchId === creds.branchId
        )
      },
    )
  }, [enabled, handleCallEvent, realtimeClient, realtimeReady])
}

function parseValidatedLocalCall(value: unknown): CallerIdBroadcastEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (
    keys.length !== LOCAL_PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== LOCAL_PAYLOAD_KEYS[index])
  ) {
    return null
  }
  const payload = value as ValidatedLocalCallPayload
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.sourceId !== 'string' ||
    !UUID_REGEX.test(payload.sourceId) ||
    !Number.isSafeInteger(payload.sourceVersion) ||
    payload.sourceVersion <= 0 ||
    typeof payload.lineId !== 'string' ||
    !UUID_REGEX.test(payload.lineId) ||
    typeof payload.lineName !== 'string' ||
    payload.lineName.length === 0 ||
    payload.lineName.length > 120 ||
    payload.lineName.trim() !== payload.lineName ||
    !Number.isSafeInteger(payload.lineVersion) ||
    payload.lineVersion <= 0 ||
    typeof payload.providerEventId !== 'string' ||
    !PROVIDER_EVENT_ID_REGEX.test(payload.providerEventId) ||
    !['allowed', 'restricted'].includes(payload.presentation) ||
    (payload.presentation === 'allowed'
      ? typeof payload.callerNumber !== 'string' ||
        !LOCAL_PHONE_REGEX.test(payload.callerNumber)
      : payload.callerNumber !== null) ||
    typeof payload.occurredAt !== 'string'
  ) {
    return null
  }
  const occurredAt = Date.parse(payload.occurredAt)
  const now = Date.now()
  if (
    !Number.isFinite(occurredAt) ||
    now - occurredAt > LOCAL_EVENT_TTL_MS ||
    occurredAt - now > 5_000
  ) {
    return null
  }

  return {
    callerNumber: payload.callerNumber ?? 'Private number',
    callerName: null,
    customer: null,
    sipCallId: payload.providerEventId,
    timestamp: payload.occurredAt,
    lineId: payload.lineId,
    lineName: payload.lineName,
    presentation: payload.presentation,
  }
}

function callerIdEventKey(event: CallerIdBroadcastEvent): string {
  if (!event.lineId || !event.presentation) {
    return `event:${event.sipCallId}`
  }
  const numberSuffix =
    event.presentation === 'allowed'
      ? event.callerNumber.replace(/\D/g, '').slice(-8)
      : 'private'
  const occurredAt = Date.parse(event.timestamp)
  const timeKey = Number.isFinite(occurredAt)
    ? String(occurredAt)
    : event.timestamp
  return [
    'call',
    event.lineId,
    timeKey,
    event.presentation,
    numberSuffix,
  ].join(':')
}

function flushCallerIdCompletion(state: AcceptedCallState): void {
  if (!state.completion || state.receiptReported) return
  const reportReceipt = state.event.reportReceipt
  if (!reportReceipt) return
  state.receiptReported = true
  void reportReceipt(state.completion)
}

function mergeCallerIdEvent(
  existing: CallerIdBroadcastEvent | undefined,
  incoming: CallerIdBroadcastEvent,
): CallerIdBroadcastEvent {
  const existingCustomer = existing?.customer ?? null
  const incomingCustomer = incoming.customer ?? null

  return {
    callerNumber: incoming.callerNumber || existing?.callerNumber || '',
    callerName: incoming.callerName ?? existing?.callerName ?? null,
    customer: incomingCustomer
      ? {
          id: incomingCustomer.id || existingCustomer?.id || '',
          name: incomingCustomer.name ?? existingCustomer?.name ?? null,
          phone: incomingCustomer.phone ?? existingCustomer?.phone ?? null,
          email: incomingCustomer.email ?? existingCustomer?.email ?? null,
          address: incomingCustomer.address ?? existingCustomer?.address ?? null,
          is_banned: incomingCustomer.is_banned ?? existingCustomer?.is_banned,
          notes: incomingCustomer.notes ?? existingCustomer?.notes ?? null,
        }
      : existingCustomer,
    sipCallId: existing?.sipCallId ?? incoming.sipCallId,
    timestamp: existing?.timestamp || incoming.timestamp || new Date().toISOString(),
    sourceTerminalId: incoming.sourceTerminalId ?? existing?.sourceTerminalId ?? null,
    lineId: incoming.lineId ?? existing?.lineId,
    lineName: incoming.lineName ?? existing?.lineName,
    presentation: incoming.presentation ?? existing?.presentation,
    reportReceipt: incoming.reportReceipt ?? existing?.reportReceipt,
  }
}
