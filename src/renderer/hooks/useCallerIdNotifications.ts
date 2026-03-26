/**
 * useCallerIdNotifications — Combines local Tauri events + Supabase Realtime
 * to show caller ID popup notifications on all terminals.
 *
 * Gated by `isModuleEnabled('caller_id')`.
 */
import { useEffect, useRef, useCallback } from 'react'
import { onEvent, offEvent } from '../../lib'
import { useModules } from '../contexts/module-context'
import { getCachedTerminalCredentials } from '../services/terminal-credentials'
import { subscribeToCallerIdEvents, type CallerIdBroadcastEvent } from '../services/CallerIdRealtimeService'
import { showCallerIdToast } from '../components/callerid/CallerIdPopup'

interface CallerIdNotificationsOptions {
  onStartOrder?: (event: CallerIdBroadcastEvent) => void
  onViewCustomer?: (customerId: string) => void
  onAddCustomer?: (phone: string) => void
}

export function useCallerIdNotifications(options?: CallerIdNotificationsOptions) {
  const { isModuleEnabled } = useModules()
  const enabled = isModuleEnabled('caller_id' as any)
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

    showCallerIdToast(merged, {
      onStartOrder: optionsRef.current?.onStartOrder,
      onViewCustomer: optionsRef.current?.onViewCustomer,
      onAddCustomer: optionsRef.current?.onAddCustomer,
    })
  }, [])

  useEffect(() => {
    if (!enabled) return

    // Listen for local Tauri events (this terminal detected a call via SIP)
    const handleLocalEvent = (data: any) => {
      if (!data?.callerNumber) return
      handleCallEvent({
        callerNumber: data.callerNumber,
        callerName: data.callerName || null,
        customer: data.customer || null,
        sipCallId: data.sipCallId || `local-${Date.now()}`,
        timestamp: data.timestamp || new Date().toISOString(),
      })
    }

    onEvent('callerid:incoming-call', handleLocalEvent)

    // Subscribe to Supabase Realtime (events from other terminals)
    const creds = getCachedTerminalCredentials()
    let unsubscribeRealtime: (() => void) | null = null

    if (creds.organizationId) {
      unsubscribeRealtime = subscribeToCallerIdEvents(
        creds.organizationId,
        creds.terminalId,
        handleCallEvent,
      )
    }

    return () => {
      offEvent('callerid:incoming-call', handleLocalEvent)
      unsubscribeRealtime?.()
      cleanupTimersRef.current.forEach((timer) => clearTimeout(timer))
      cleanupTimersRef.current.clear()
      callEventsRef.current.clear()
    }
  }, [enabled, handleCallEvent])
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
