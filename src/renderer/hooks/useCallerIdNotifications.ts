/**
 * useCallerIdNotifications — Displays validated Caller ID v2 private Realtime
 * events. Legacy native SIP events are intentionally outside this hook.
 *
 * Gated by `plugin_integrations`; caller_id itself is a plugin integration.
 */
import { useEffect, useRef, useCallback } from 'react'
import { useModules } from '../contexts/module-context'
import { getCachedTerminalCredentials } from '../services/terminal-credentials'
import {
  reportCallerIdReceipt,
  subscribeToCallerIdEvents,
  type CallerIdBroadcastEvent,
  type CallerIdRealtimeClient,
} from '../services/CallerIdRealtimeService'
import { showCallerIdToast } from '../components/callerid/CallerIdPopup'
import { navigateToCallerIdCustomerSearch } from '../services/caller-id-customer-search'

interface CallerIdNotificationsOptions {
  realtimeReady?: boolean
  realtimeClient?: CallerIdRealtimeClient | null
}

export function useCallerIdNotifications(options?: CallerIdNotificationsOptions) {
  const { isModuleEnabled } = useModules()
  const enabled = isModuleEnabled('plugin_integrations' as any)
  const realtimeReady = options?.realtimeReady === true
  const realtimeClient = options?.realtimeClient ?? null
  const callEventsRef = useRef(new Map<string, CallerIdBroadcastEvent>())
  const cleanupTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const optionsRef = useRef(options)
  optionsRef.current = options

  const handleCallEvent = useCallback((event: CallerIdBroadcastEvent) => {
    const existing = callEventsRef.current.get(event.sipCallId)
    const merged = mergeCallerIdEvent(existing, event)

    if (existing && callerIdEventsEqual(existing, merged)) {
      return
    }

    callEventsRef.current.set(event.sipCallId, merged)

    const existingTimer = cleanupTimersRef.current.get(event.sipCallId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const cleanupTimer = setTimeout(() => {
      callEventsRef.current.delete(event.sipCallId)
      cleanupTimersRef.current.delete(event.sipCallId)
    }, 30_000)
    cleanupTimersRef.current.set(event.sipCallId, cleanupTimer)

    const reportReceipt =
      merged.reportReceipt ??
      ((receipt: Parameters<typeof reportCallerIdReceipt>[1]) =>
        reportCallerIdReceipt(
          merged.sipCallId,
          receipt,
          merged.timestamp,
        ))
    let completionReported = false
    const reportCompletion = (
      receipt: Parameters<typeof reportCallerIdReceipt>[1],
    ) => {
      if (completionReported) return
      completionReported = true
      void reportReceipt(receipt)
    }

    try {
      showCallerIdToast(merged, {
        onSearchCustomer: () =>
          navigateToCallerIdCustomerSearch(merged.callerNumber),
        onDisplayed: () => reportCompletion({ status: 'displayed' }),
      })
    } catch {
      reportCompletion({
        status: 'failed',
        failureCode: 'DISPLAY_FAILED',
      })
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
    sipCallId: incoming.sipCallId,
    timestamp: incoming.timestamp || existing?.timestamp || new Date().toISOString(),
    sourceTerminalId: incoming.sourceTerminalId ?? existing?.sourceTerminalId ?? null,
    reportReceipt: incoming.reportReceipt ?? existing?.reportReceipt,
  }
}

function callerIdEventsEqual(a: CallerIdBroadcastEvent, b: CallerIdBroadcastEvent): boolean {
  return (
    a.callerNumber === b.callerNumber &&
    (a.callerName ?? null) === (b.callerName ?? null) &&
    a.sipCallId === b.sipCallId &&
    a.timestamp === b.timestamp &&
    (a.sourceTerminalId ?? null) === (b.sourceTerminalId ?? null) &&
    callerIdCustomersEqual(a.customer, b.customer)
  )
}

function callerIdCustomersEqual(
  a: CallerIdBroadcastEvent['customer'],
  b: CallerIdBroadcastEvent['customer'],
): boolean {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return !a && !b
  }

  return (
    a.id === b.id &&
    (a.name ?? null) === (b.name ?? null) &&
    (a.phone ?? null) === (b.phone ?? null) &&
    (a.email ?? null) === (b.email ?? null) &&
    (a.address ?? null) === (b.address ?? null) &&
    (a.is_banned ?? null) === (b.is_banned ?? null) &&
    (a.notes ?? null) === (b.notes ?? null)
  )
}
