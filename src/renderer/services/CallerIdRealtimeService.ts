/**
 * CallerIdRealtimeService — Supabase Realtime subscription for caller ID events.
 *
 * Listens on channel `callerid:{organizationId}` for call events broadcast
 * by the admin API when any terminal detects an incoming call.
 *
 * Pattern follows OrderDeleteRealtimeService.ts.
 */
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../../shared/supabase'

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
}

type CallerIdEventCallback = (event: CallerIdBroadcastEvent) => void

/** Dedup window: ignore duplicate sipCallId values within 30 seconds */
const DEDUP_TTL_MS = 30_000

/**
 * Subscribe to caller ID broadcast events for an organization.
 *
 * @param organizationId - The org to listen for
 * @param terminalId - This terminal's ID (to skip self-originated events)
 * @param onEvent - Callback fired for each unique incoming call event
 * @returns Cleanup function to unsubscribe
 */
export function subscribeToCallerIdEvents(
  organizationId: string,
  terminalId: string,
  onEvent: CallerIdEventCallback,
): () => void {
  if (!organizationId) {
    return () => {}
  }

  const seen = new Map<string, number>() // sipCallId → timestamp
  let channel: RealtimeChannel | null = null
  let disposed = false

  // Periodic cleanup of expired dedup entries
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, ts] of seen) {
      if (now - ts > DEDUP_TTL_MS) {
        seen.delete(key)
      }
    }
  }, DEDUP_TTL_MS)

  try {
    channel = supabase
      .channel(`callerid:${organizationId}`)
      .on('broadcast', { event: 'incoming_call' }, (msg: { payload?: unknown }) => {
        if (disposed) return

        const payload = msg?.payload as CallerIdBroadcastEvent | undefined
        if (!payload?.callerNumber || !payload?.sipCallId) {
          return
        }

        // Skip events from this terminal (we already got the local Tauri event)
        if (payload.sourceTerminalId === terminalId) {
          return
        }

        // Dedup by sipCallId
        if (seen.has(payload.sipCallId)) {
          return
        }
        seen.set(payload.sipCallId, Date.now())

        onEvent(payload)
      })
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[CallerIdRealtimeService] Subscription error:', {
            organizationId,
            status,
            error,
          })
        }
      })
  } catch (error) {
    console.warn('[CallerIdRealtimeService] Failed to subscribe:', {
      organizationId,
      error,
    })
  }

  return () => {
    disposed = true
    clearInterval(cleanupInterval)
    if (channel) {
      supabase.removeChannel(channel)
      channel = null
    }
  }
}
